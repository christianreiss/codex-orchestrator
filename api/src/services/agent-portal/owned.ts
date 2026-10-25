import { acceptOwnedClaudeTurnProof } from '../../control-plane/state/receiver-turn-proof.js';
import { historyRetentionHours } from '../server-retention/policy.js';
import { recordMessagingRowChange } from '../../control-plane/state/messaging-totals.js';
import { randomBytes, randomUUID } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import {
  agentSessions,
  agentEvents,
  agentMessages,
  agentPrompts,
  agentChatNotices,
  versions,
  type Host,
  type AgentSession,
  type AgentMessage,
} from '../../db/schema.js';
import type { Env } from '../../env.js';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ServiceUnavailableError,
  UnauthorizedError,
  ValidationError,
} from '../../http/errors.js';
import { sha256 } from '../../security/hash.js';
import { encrypt, decrypt } from '../../security/secret-box.js';
import type { Keyring } from '../../security/keyring.js';
import { nowIso, isoOffsetSeconds } from '../../util/timestamp.js';
import { isEngine } from '../../util/engine.js';
import { wsPublisher } from '../../ws/publisher.js';
import type { Json } from '../../control-plane/commands.js';
import type { StateRow } from '../../control-plane/state/catalog.js';
import type { OwnerStateSnapshot } from '../../control-plane/state/store.js';
import {
  addOwnerResponseProof,
  mutateOwnerState,
  type OwnerRuntime,
  type OwnerMutationContext,
} from '../../control-plane/state/runtime.js';
import { stageUpdate } from '../../control-plane/state/rows.js';
import { stagePortalEvent } from '../../control-plane/state/portal-events.js';
import {
  stagePortalSessionFinish,
  stageCancelSessionPending,
  stageUndeliveredNotice,
} from '../../control-plane/state/portal-lifecycle.js';
import { ownedEngineState, ownedMessagingHost } from '../../control-plane/state/messaging.js';
import { assertOwnedHousekeeping } from '../../control-plane/state/session-lifecycle.js';
import {
  ownedSessionAuthority,
  ownedReceiverReady,
  ownedReceiverView,
} from '../../control-plane/streams/receiver.js';
import { stageAttachmentLink } from '../../control-plane/streams/attachments.js';
import { ownerPresence } from '../../control-plane/presence.js';
import { ownedCredentialDeadline } from '../../control-plane/credentials.js';
import { legacyDrainFor } from '../../control-plane/legacy-drain.js';
import { acceptActivity, activityView, type ActivityInput } from '../agent-activity.js';
import { hostAuthFingerprint, safeHashEqual } from '../agent-messaging/internals.js';
import { normalizeWorkspace } from '../agent-messaging/workspace.js';
import { namedSessionTitle } from '../agent-messaging/names.js';
import { receiverState } from '../agent-receiver-state.js';
import { assertHostEngineEnabled } from '../host-engine-policy.js';
import { isTruthyFlagValue } from '../settings.js';
import { ChatAttachments } from '../agent-chat/attachments.js';
import { chatMetadataSchema, validAnswer, type ChatMetadata } from '../agent-chat/contracts.js';
import {
  AGENT_EVENT_TYPES,
  AGENT_PORTAL_MAX_DELIVERY_ATTEMPTS,
  normalizeRequiredText,
  normalizeOptionalText,
  normalizeMessage,
  normalizeCloseNote,
  normalizeUuid,
  normalizeBridgeToken,
  normalizeEventId,
  normalizeEvent,
  messageView,
  closeState,
  backoffSeconds,
  type PortalActor,
  type RegisterAgentInput,
  type AgentEventInput,
  type EventTransactionOptions,
  type ClaimedMessage,
} from '../agent-portal.js';

const json = (value: unknown): Json => JSON.parse(JSON.stringify(value)) as Json;
const lost = () =>
  new ConflictError('Message is no longer owned by this delivery', 'agent_message_lease_lost');
function enabled(snapshot: OwnerStateSnapshot): void {
  if (!isTruthyFlagValue(snapshot.setting('agent_portal_enabled'), false))
    throw new ServiceUnavailableError('Agent sessions are disabled', 'agent_portal_disabled');
}
function actor(snapshot: OwnerStateSnapshot, input: PortalActor) {
  const user = snapshot.table('adminUsers').get(input.user.id);
  if (!user) throw new NotFoundError('Admin user not found', 'admin_user_not_found');
  if (user.active !== 1) throw new ForbiddenError('Admin account is disabled', 'admin_disabled');
  return { id: user.id, displayName: user.name || user.username };
}
export function visiblePortalSession(snapshot: OwnerStateSnapshot, id: string) {
  const row = snapshot.sessions.get(id);
  if (
    !row ||
    (row.expiresAt &&
      row.expiresAt <= nowIso() &&
      !snapshot
        .table('agentChatNotices')
        .by('sessionId', id)
        .some((n) => !n.resolvedAt))
  )
    throw new NotFoundError('Agent session not found', 'agent_session_not_found');
  return row;
}
function live(session: Readonly<StateRow<'agentSessions'>>): void {
  if (session.endedAt || !['starting', 'active', 'waiting', 'offline'].includes(session.status))
    throw new ConflictError('Agent session is read-only', 'agent_session_finished');
}
function conversation(snapshot: OwnerStateSnapshot, id: string): string {
  return snapshot.table('hostDaemonPortalBindings').get(id)?.daemonSessionId ?? id;
}
function instance(
  runtime: OwnerRuntime,
  snapshot: OwnerStateSnapshot,
  session: Readonly<StateRow<'agentSessions'>>,
  ready = true,
): string {
  live(session);
  const native = snapshot.table('agentNativeControls').get(session.id);
  if (
    !native ||
    native.bindingGeneration !== session.bindingGeneration ||
    !['ready', 'requested', 'accepted'].includes(native.status)
  )
    throw lost();
  if (
    !ownerPresence(runtime)
      .session(session.id, session.bindingGeneration, 'session')
      .some((a) => a.scope.native_instance_id === native.instanceId)
  )
    throw lost();
  if (
    ready &&
    (session.receiver ? !ownedReceiverReady(runtime, session, 'portal') : session.relayEnabled !== 1)
  )
    throw new ConflictError('Agent is not listening for portal messages', 'agent_relay_not_ready');
  return native.instanceId;
}
function releaseAnswer(
  ctx: OwnerMutationContext,
  row: Readonly<StateRow<'agentMessages'>>,
  now: string,
): void {
  if (row.kind !== 'answer' || !row.promptId) return;
  const prompt = ctx.draft.table('agentPrompts').get(row.promptId),
    session = ctx.draft.table('agentSessions').get(row.sessionId);
  if (!prompt || prompt.status !== 'answered' || prompt.answerMessageId !== row.messageId) return;
  const reopen = session && !session.endedAt && (!prompt.expiresAt || prompt.expiresAt > now);
  stageUpdate(ctx, 'agentPrompts', prompt.id, {
    status: reopen ? 'open' : 'expired',
    answeredByUserId: null,
    answerMessageId: null,
    answeredAt: null,
    expiresAt: reopen ? prompt.expiresAt : now,
    version: prompt.version + 1,
  });
}

/** Portal metadata is owner RAM; only explicit message/event bodies read cold storage. */
export class OwnedPortal {
  constructor(
    readonly runtime: OwnerRuntime,
    readonly db: Database,
    readonly env: Env,
    readonly keyring: Keyring,
  ) {}
  private snapshot() {
    this.runtime.assertOwner();
    return this.runtime.state.snapshot();
  }
  private encode(value: unknown) {
    return encrypt(JSON.stringify(value), this.keyring);
  }
  private decode<T>(value: string | null, fallback: T): T {
    try {
      return value ? (JSON.parse(decrypt(value, this.keyring)) as T) : fallback;
    } catch {
      return fallback;
    }
  }
  authority(snapshot: OwnerStateSnapshot, id: string, token: string, hostId?: number, allowEnded = false) {
    enabled(snapshot);
    const session = ownedSessionAuthority(snapshot, id, token, { allowEnded }).session;
    if (hostId !== undefined && session.hostId !== hostId)
      throw new ForbiddenError('Agent bridge belongs to a different host', 'agent_bridge_host_mismatch');
    addOwnerResponseProof('portal:' + id, (state) => {
      enabled(state);
      const current = ownedSessionAuthority(state, id, token, {
        allowEnded,
        bindingGeneration: session.bindingGeneration,
      }).session;
      if (hostId !== undefined && current.hostId !== hostId)
        throw new ForbiddenError('Agent bridge host changed');
    });
    return session;
  }
  authenticate(id: string, token: string, hostId?: number, allowEnded = false) {
    return this.authority(this.snapshot(), id, token, hostId, allowEnded);
  }
  health() {
    const s = this.snapshot(),
      messages = s.table('agentMessages').all();
    return {
      active_sessions: s.sessions.all().filter((row) => !row.endedAt).length,
      queued_messages: messages.filter((row) => ['queued', 'leased'].includes(row.status)).length,
      dead_messages: messages.filter((row) => row.status === 'dead').length,
    };
  }
  async setEnabled(value: boolean) {
    return mutateOwnerState(this.runtime, {
      kind: 'portal.enabled',
      payload: { enabled: value },
      prepare: (ctx) => {
        const now = nowIso(),
          previous = ctx.snapshot.settings.get('agent_portal_enabled');
        if (previous?.version === (value ? '1' : '0'))
          return { enabled: value, canceled: 0, revoked_sessions: 0 };
        const row = { name: 'agent_portal_enabled', version: value ? '1' : '0', updatedAt: now };
        ctx.draft.upsert('versions', row);
        ctx.write(async (tx) => {
          await tx
            .insert(versions)
            .values(row)
            .onDuplicateKeyUpdate({ set: { version: row.version, updatedAt: now } });
        });
        let canceled = 0;
        if (!value)
          for (const session of ctx.draft.table('agentSessions').all()) {
            canceled += ctx.draft
              .table('agentMessages')
              .by('sessionId', session.id)
              .filter((m) => m.status === 'queued').length;
            stageCancelSessionPending(ctx, session.id, now, this.keyring);
            if (session.relayEnabled)
              stageUpdate(ctx, 'agentSessions', session.id, {
                relayEnabled: 0,
                relayHeartbeatAt: null,
                updatedAt: now,
              });
          }
        return { enabled: value, canceled, revoked_sessions: 0 };
      },
    });
  }
  async register(host: Host, input: RegisterAgentInput) {
    if (!isTruthyFlagValue(this.snapshot().setting('agent_portal_enabled'))) return { enabled: false };
    const username = normalizeRequiredText(input.username, 'username', 255),
      cwd = normalizeRequiredText(input.cwd, 'cwd', 1024),
      workspace = normalizeWorkspace(input.workspace);
    if (!isEngine(input.engine)) throw new ValidationError('Invalid engine');
    const id = input.sessionId ? normalizeUuid(input.sessionId, 'session_id') : randomUUID(),
      token = input.bridgeToken
        ? normalizeBridgeToken(input.bridgeToken)
        : randomBytes(32).toString('base64url'),
      fingerprint = hostAuthFingerprint(host);
    const drain = legacyDrainFor(this.runtime);
    if (drain?.capturedSession(id)) {
      const snapshot = this.snapshot(),
        old = snapshot.sessions.get(id);
      if (
        !old ||
        old.hostId !== host.id ||
        old.engine !== input.engine ||
        old.username !== username ||
        old.cwd !== cwd ||
        old.invocationKind !== input.invocationKind ||
        (input.upstreamSessionId && input.upstreamSessionId !== old.upstreamSessionId)
      )
        throw new ConflictError(
          'Legacy registration cannot replace a native lifecycle',
          'legacy_drain_fenced',
        );
      drain.recover('session', id, token, host.id, username, (current) => {
        enabled(current);
        const h = ownedMessagingHost(current, host.id);
        if (!safeHashEqual(h.authFingerprint, fingerprint))
          throw new UnauthorizedError('Host credential changed', 'agent_bridge_host_auth_changed');
        assertHostEngineEnabled(h, input.engine, ownedEngineState(current));
      });
      return {
        enabled: true,
        session_id: id,
        bridge_token: token,
        expires_at: new Date(drain.deadline(snapshot, 'session', id)!).toISOString(),
      };
    }
    return mutateOwnerState(this.runtime, {
      kind: 'portal.register',
      principal: `host:${host.id}`,
      payload: json({ ...input, sessionId: id, bridgeToken: sha256(token) }),
      authorize: (s) => {
        enabled(s);
        const h = ownedMessagingHost(s, host.id);
        if (!safeHashEqual(h.authFingerprint, fingerprint))
          throw new UnauthorizedError('Host credential changed', 'agent_bridge_host_auth_changed');
        assertHostEngineEnabled(h, input.engine, ownedEngineState(s));
      },
      prepare: async (ctx) => {
        assertOwnedHousekeeping(ctx, host.id, input.engine);
        const now = nowIso(),
          expiresAt = isoOffsetSeconds(this.env.AGENT_PORTAL_BRIDGE_TTL_SECONDS),
          old = ctx.snapshot.sessions.get(id);
        if (old) {
          if (
            old.hostId !== host.id ||
            old.engine !== input.engine ||
            old.username !== username ||
            old.cwd !== cwd ||
            old.invocationKind !== input.invocationKind ||
            !safeHashEqual(old.bridgeTokenHash, sha256(token))
          )
            throw new ConflictError('Agent session registration conflicts', 'agent_session_conflict');
          live(old);
          stageUpdate(ctx, 'agentSessions', id, {
            hostAuthFingerprint: fingerprint,
            bridgeExpiresAt: expiresAt,
            ...(input.workspace ? { workspace } : {}),
            updatedAt: now,
          });
        } else {
          const row: AgentSession = {
            id,
            hostId: host.id,
            launchName: null,
            providerAccountId: null,
            engine: input.engine,
            username,
            cwd,
            workspace,
            activity: null,
            upstreamSessionId: normalizeOptionalText(input.upstreamSessionId, 255),
            agentBusAddressId: null,
            invocationKind: input.invocationKind,
            status: 'active',
            relayEnabled: 0,
            relayHeartbeatAt: null,
            activeTurnId: null,
            closeRequestedAt: null,
            adapterProtocol: null,
            adapterCapabilities: null,
            receiveHeartbeatAt: null,
            receiver: null,
            bindingGeneration: 0,
            hostAuthFingerprint: fingerprint,
            bridgeTokenHash: sha256(token),
            bridgeExpiresAt: expiresAt,
            startedAt: now,
            heartbeatAt: now,
            endedAt: null,
            expiresAt: null,
            createdAt: now,
            updatedAt: now,
          };
          ctx.draft.upsert('agentSessions', row);
          ctx.write(async (tx) => {
            await tx.insert(agentSessions).values(row);
          });
          stagePortalEvent(ctx, {
            sessionId: id,
            clientEventId: 'server:started',
            eventType: input.resumed ? 'resumed' : 'started',
            source: 'bridge',
            payloadEnc: this.encode({ summary: input.resumed ? 'Agent resumed' : 'Agent started' }),
            createdAt: now,
          });
        }
        return { enabled: true, session_id: id, bridge_token: token, expires_at: expiresAt };
      },
    });
  }
  async heartbeat(
    id: string,
    token: string,
    input: { status?: string; activeTurnId?: string | null; relayAction?: 'poll' | 'close' },
    hostId?: number,
  ) {
    legacyDrainFor(this.runtime)?.renew('session', id, token);
    const current = this.authenticate(id, token, hostId),
      requested = input.status?.trim().toLowerCase();
    const status =
      requested && ['starting', 'active', 'waiting', 'offline'].includes(requested)
        ? requested
        : current.status;
    const turn =
      input.activeTurnId === undefined
        ? current.activeTurnId
        : normalizeOptionalText(input.activeTurnId, 255);
    const relay = input.relayAction === 'close' ? 0 : input.relayAction === 'poll' ? 1 : current.relayEnabled;
    if (status !== current.status || turn !== current.activeTurnId || relay !== current.relayEnabled)
      await mutateOwnerState(this.runtime, {
        kind: 'portal.state',
        payload: json({ id, input }),
        authorize: (s) => {
          this.authority(s, id, token, hostId);
        },
        prepare: (ctx) => {
          const session = ctx.snapshot.sessions.get(id)!,
            now = nowIso(),
            automatic = receiverState(session.receiver);
          const patch: Partial<AgentSession> = {
            status,
            activeTurnId: turn,
            relayEnabled: relay,
            updatedAt: now,
          };
          if (input.relayAction === 'close') {
            if (automatic)
              patch.receiver = {
                ...automatic,
                portal_closed: true,
                probes: Object.fromEntries(
                  Object.entries(automatic.probes).filter(([source]) => source !== 'portal'),
                ),
              };
            patch.relayHeartbeatAt = null;
            stageCancelSessionPending(ctx, id, now, this.keyring, { keepLeasedClose: true });
          }
          if (input.relayAction === 'poll' && automatic?.portal_closed)
            patch.receiver = {
              ...automatic,
              portal_closed: false,
              probes: { ...automatic.probes, portal: {} },
              failure: 'portal_reopened',
            };
          stageUpdate(ctx, 'agentSessions', id, patch);
          return null;
        },
      });
    return {
      enabled: true,
      expires_at: new Date(ownedCredentialDeadline(this.snapshot(), 'session', id)).toISOString(),
      status,
      relay_active: relay === 1,
    };
  }
  private activityConnected(session: Readonly<StateRow<'agentSessions'>>): boolean {
    const receiver = receiverState(session.receiver);
    return Boolean(
      receiver && !receiver.failure && !session.endedAt && (
        ownerPresence(this.runtime).hasReceiver(session.id, session.bindingGeneration, receiver.generation) ||
        legacyDrainFor(this.runtime)?.receiver(session.id, session.bindingGeneration, receiver.generation)
      ),
    );
  }
  async activity(id: string, token: string, input: ActivityInput) {
    const session = this.authenticate(id, token),
      next = acceptActivity(session, input, Date.now(), this.activityConnected(session));
    if (!next) return { accepted: false };
    return mutateOwnerState(this.runtime, {
      kind: 'portal.activity',
      persistence: 'volatile',
      payload: json({ id, input }),
      authorize: (s) => {
        this.authority(s, id, token);
        acceptOwnedClaudeTurnProof(this.runtime, s.sessions.get(id)!, input.turn_proof);
      },
      prepare: (ctx) => {
        const current = ctx.snapshot.sessions.get(id)!;
        const turnProof = acceptOwnedClaudeTurnProof(this.runtime, current, input.turn_proof);
        const value = acceptActivity(current, input, Date.now(), this.activityConnected(current));
        if (!value) return { accepted: false };
        stageUpdate(ctx, 'agentSessions', id, { activity: { ...value, ...(turnProof ? { turn_proof: turnProof } : {}) } });
        return { accepted: true };
      },
    });
  }
  async addEvent(
    id: string,
    input: AgentEventInput,
    options: EventTransactionOptions = {},
    admin?: PortalActor,
  ) {
    if (!(AGENT_EVENT_TYPES as readonly string[]).includes(input.type))
      throw new ValidationError('Unsupported agent event type');
    const eventId = normalizeEventId(input.clientEventId),
      normalized = normalizeEvent(input.type, input.payload ?? {});
    if (normalized.prompt) {
      normalized.payload.prompt_id = normalized.prompt.id;
      normalized.payload.prompt_version = 1;
    }
    const authorize = (s: OwnerStateSnapshot) => {
      enabled(s);
      if (admin) actor(s, admin);
      return options.bridge
        ? this.authority(s, id, options.bridge.token, options.bridge.hostId, options.bridge.allowEnded)
        : visiblePortalSession(s, id);
    };
    return mutateOwnerState(this.runtime, {
      kind: 'portal.event',
      responseAuthorization: options.terminal ? 'commit' : undefined,
      principal: admin ? `admin:${admin.user.id}` : `portal:${id}`,
      id: eventId,
      payload: json({ id, input, terminal: options.terminal ?? null }),
      authorize: (s) => {
        authorize(s);
      },
      prepare: async (ctx) => {
        const session = authorize(ctx.snapshot),
          now = nowIso();
        if (options.terminal && session.endedAt && session.status !== options.terminal.status)
          throw new ConflictError('Session ended with another status', 'agent_session_finished');
        if (input.type === 'session_named') {
          if (
            normalized.payload.native_session_id !== undefined &&
            normalized.payload.native_session_id !== session.upstreamSessionId
          )
            throw new ConflictError('Native session changed before naming', 'agent_session_name_stale');
          normalized.payload.native_session_id = session.upstreamSessionId;
        }
        // Explicit legacy idempotency/history lookup; never a background probe.
        const [existing] = await this.db
          .select()
          .from(agentEvents)
          .where(and(eq(agentEvents.sessionId, id), eq(agentEvents.clientEventId, eventId)))
          .limit(1);
        if (existing) {
          const payload = this.decode<Record<string, unknown>>(existing.payloadEnc, {});
          if (
            existing.eventType !== input.type ||
            existing.source !== input.source ||
            JSON.stringify(payload) !== JSON.stringify(normalized.payload)
          )
            throw new ConflictError(
              'Event ID was already used for another event',
              'client_event_id_conflict',
            );
          return json({
            cursor: existing.id,
            session_id: id,
            type: existing.eventType,
            source: existing.source,
            payload,
            created_at: existing.createdAt,
          });
        }
        if (
          input.type === 'session_named' &&
          normalized.payload.only_if_missing === true &&
          session.taskTitle &&
          session.taskTitleNativeId === session.upstreamSessionId
        ) {
          const [named] = await this.db
            .select()
            .from(agentEvents)
            .where(eq(agentEvents.id, session.taskTitleEventId!))
            .limit(1);
          if (named)
            return json({
              cursor: named.id,
              session_id: id,
              type: named.eventType,
              source: named.source,
              payload: this.decode(named.payloadEnc, {}),
              created_at: named.createdAt,
            });
        }
        if (input.type === 'message_read' || input.type === 'message_processing') {
          const message = ctx.snapshot
            .table('agentMessages')
            .by('messageId', normalizeUuid(normalized.payload.message_id, 'message_id'))[0];
          if (
            !message ||
            message.sessionId !== id ||
            message.status !== 'accepted' ||
            !message.upstreamId ||
            session.activeTurnId !== message.upstreamId
          )
            throw new ConflictError(
              'Message is not current accepted instruction',
              'agent_message_not_active',
            );
        }
        if (normalized.prompt) {
          for (const old of ctx.draft.table('agentPrompts').by('sessionId', id))
            if (old.status === 'open')
              stageUpdate(ctx, 'agentPrompts', old.id, {
                status: 'expired',
                expiresAt: now,
                version: old.version + 1,
              });
          const p = normalized.prompt,
            row: typeof agentPrompts.$inferSelect = {
              id: p.id,
              sessionId: id,
              eventId: null,
              questionEnc: encrypt(p.question, this.keyring),
              optionsEnc: p.options.length ? this.encode(p.options) : null,
              answerMode: p.answerMode,
              choicesEnc: this.encode(p.choices),
              status: 'open',
              answeredByUserId: null,
              answerMessageId: null,
              version: 1,
              createdAt: now,
              answeredAt: null,
              expiresAt: p.expiresAt,
            };
          if (ctx.snapshot.table('agentPrompts').has(p.id))
            throw new ConflictError('Prompt ID already exists');
          ctx.draft.upsert('agentPrompts', row);
          ctx.write(async (tx) => {
            await tx.insert(agentPrompts).values(row);
          });
        }
        if (input.type === 'assistant_message' || input.type === 'waiting_input')
          stageAttachmentLink(
            ctx,
            id,
            chatMetadataSchema.parse({
              attachments: normalized.payload.attachments,
              reply_to: normalized.payload.reply_to,
            }),
            new ChatAttachments(this.db, this.keyring, this.env.DATA_ROOT ?? 'storage').limits()
              .max_total_bytes,
            `agent:${id}`,
          );
        const inserted = stagePortalEvent(ctx, {
          sessionId: id,
          clientEventId: eventId,
          eventType: input.type,
          source: input.source,
          payloadEnc: this.encode(normalized.payload),
          createdAt: now,
        });
        if (normalized.payload.severity && normalized.payload.notice_id) {
          const noticeId = String(normalized.payload.notice_id),
            old = ctx.draft.table('agentChatNotices').get(noticeId);
          if (old && old.sessionId !== id) throw new ConflictError('Notice belongs to another conversation');
          ctx.write(async (tx) => {
            const row = {
              id: noticeId,
              sessionId: id,
              severity: String(normalized.payload.severity),
              payloadEnc: this.encode(normalized.payload),
              eventId: inserted.id,
              resolvedAt: null,
              createdAt: old?.createdAt ?? now,
            };
            if (old) await tx.update(agentChatNotices).set(row).where(eq(agentChatNotices.id, noticeId));
            else await tx.insert(agentChatNotices).values(row);
            ctx.draft.upsert('agentChatNotices', row);
          });
        }
        if (input.type === 'attention_resolved' && normalized.payload.notice_id) {
          const target = ctx.draft.table('agentChatNotices').get(String(normalized.payload.notice_id));
          if (!target || conversation(ctx.snapshot, target.sessionId) !== conversation(ctx.snapshot, id))
            throw new NotFoundError('Notice not found');
          stageUpdate(ctx, 'agentChatNotices', target.id, { resolvedAt: now });
          for (const sessionId of new Set([target.sessionId, id])) {
            const retained = ctx.draft.table('agentSessions').get(sessionId);
            if (retained?.expiresAt && retained.expiresAt <= now)
              stageUpdate(ctx, 'agentSessions', sessionId, {
                expiresAt: isoOffsetSeconds(
                  historyRetentionHours(
                    this.runtime.state.snapshot(),
                    this.env.AGENT_PORTAL_RETENTION_HOURS,
                  ) * 3600,
                ),
              });
          }
        }
        if (normalized.prompt)
          ctx.write(async (tx) => {
            await tx
              .update(agentPrompts)
              .set({ eventId: inserted.id })
              .where(eq(agentPrompts.id, normalized.prompt!.id));
            const p = ctx.draft.table('agentPrompts').get(normalized.prompt!.id)!;
            ctx.draft.upsert('agentPrompts', { ...p, eventId: inserted.id });
          });
        if (input.type === 'session_named')
          ctx.write(async () => {
            const current = ctx.draft.table('agentSessions').get(id)!;
            ctx.draft.upsert('agentSessions', {
              ...current,
              taskTitle: String(normalized.payload.name).slice(0, 160),
              taskTitleNativeId: session.upstreamSessionId,
              taskTitleEventId: inserted.id,
            });
          });
        if (options.terminal && !session.endedAt)
          stagePortalSessionFinish(
            ctx,
            session,
            options.terminal.status,
            options.terminal.expiresAt,
            now,
            this.keyring,
            options.terminal.watchdogFailure,
          );
        else if (
          !session.endedAt &&
          ['waiting_input', 'assistant_message', 'message_accepted'].includes(input.type)
        )
          stageUpdate(ctx, 'agentSessions', id, {
            status: input.type === 'waiting_input' ? 'waiting' : 'active',
            updatedAt: now,
          });
        return () =>
          json({
            cursor: inserted.id,
            session_id: id,
            type: input.type,
            source: input.source,
            payload: normalized.payload,
            created_at: now,
          });
      },
    });
  }
  async enqueue(
    admin: PortalActor,
    input: {
      sessionId: string;
      clientMessageId: string;
      content?: string;
      answer?: string;
      note?: string;
      promptId?: string;
      version?: number;
      metadata?: ChatMetadata;
    },
    kind: 'message' | 'answer' | 'close',
  ) {
    const metadata = chatMetadataSchema.parse(input.metadata ?? {}),
      raw = kind === 'answer' ? input.answer : input.content;
    const text =
      kind === 'close'
        ? normalizeCloseNote(input.note)
        : metadata.attachments?.length && !raw?.trim()
          ? ''
          : normalizeMessage(raw);
    const clientId = normalizeUuid(input.clientMessageId, 'client_message_id'),
      id = randomUUID();
    const authorize = (s: OwnerStateSnapshot) => {
      enabled(s);
      actor(s, admin);
      return visiblePortalSession(s, input.sessionId);
    };
    const reply = await mutateOwnerState(this.runtime, {
      kind: 'portal.enqueue',
      principal: `admin:${admin.user.id}`,
      id: clientId,
      payload: json({ sessionId: input.sessionId, kind, text, promptId: input.promptId ?? null, metadata }),
      authorize: (s) => {
        authorize(s);
      },
      prepare: async (ctx) => {
        const session = authorize(ctx.snapshot),
          user = actor(ctx.snapshot, admin),
          now = nowIso();
        const [old] = await this.db
          .select()
          .from(agentMessages)
          .where(
            and(eq(agentMessages.sessionId, input.sessionId), eq(agentMessages.clientMessageId, clientId)),
          )
          .limit(1);
        if (old) {
          if (
            old.adminUserId !== user.id ||
            old.kind !== kind ||
            old.promptId !== (input.promptId ?? null) ||
            decrypt(old.contentEnc, this.keyring) !== text ||
            JSON.stringify(this.decode(old.metadataEnc, {})) !== JSON.stringify(metadata)
          )
            throw new ConflictError(
              'Message ID already used for different content',
              'client_message_id_conflict',
            );
          return json(this.enqueuedView(old, session.closeRequestedAt));
        }
        live(session);
        instance(this.runtime, ctx.snapshot, session);
        let answerPrompt: Readonly<StateRow<'agentPrompts'>> | undefined;
        if (kind === 'answer') {
          const prompt = ctx.snapshot.table('agentPrompts').get(input.promptId!);
          if (!prompt || prompt.sessionId !== input.sessionId)
            throw new NotFoundError('Prompt not found', 'agent_prompt_not_found');
          if (prompt.status !== 'open')
            throw new ConflictError('Prompt was already answered', 'already_answered', {
              answered_by_user_id: prompt.answeredByUserId,
              answered_at: prompt.answeredAt,
            });
          if (input.version !== undefined && input.version !== prompt.version)
            throw new ConflictError('Prompt version changed', 'prompt_version_conflict', {
              current_version: prompt.version,
            });
          if (prompt.expiresAt && prompt.expiresAt <= now) throw new ConflictError('Question expired');
          const [body] = await this.db
            .select()
            .from(agentPrompts)
            .where(eq(agentPrompts.id, prompt.id))
            .limit(1);
          if (!body) throw new NotFoundError('Prompt not found');
          const choices = body.choicesEnc
            ? this.decode<Array<{ label: string; value: string }>>(body.choicesEnc, [])
            : this.decode<string[]>(body.optionsEnc, []).map((value) => ({ label: value, value }));
          if (!validAnswer(prompt.answerMode ?? 'both', choices, text, metadata.choice_value))
            throw new ValidationError('Answer is not allowed for this question');
          answerPrompt = prompt;
        }
        stageAttachmentLink(
          ctx,
          input.sessionId,
          metadata,
          new ChatAttachments(this.db, this.keyring, this.env.DATA_ROOT ?? 'storage').limits()
            .max_total_bytes,
          `admin:${user.id}`,
        );
        const row: AgentMessage = {
          id: 0,
          messageId: id,
          sessionId: input.sessionId,
          portalUserId: null,
          adminUserId: user.id,
          kind,
          promptId: input.promptId ?? null,
          clientMessageId: clientId,
          contentEnc: encrypt(text, this.keyring),
          metadataEnc: this.encode(metadata),
          status: 'queued',
          ownershipMode: 'connection',
          ownerInstanceId: null,
          ownerBindingGeneration: null,
          attempts: 0,
          nextAttemptAt: now,
          leaseOwner: null,
          leaseUntil: null,
          upstreamId: null,
          lastError: null,
          acceptedAt: null,
          canceledAt: null,
          createdAt: now,
          updatedAt: now,
        };
        ctx.write(async (tx) => {
          const { id: unused, ...values } = row;
          const [result] = await tx.insert(agentMessages).values(values);
          row.id = Number(result.insertId);
          recordMessagingRowChange(ctx.draft, 'agentMessages', null, row);
          ctx.draft.upsert('agentMessages', row);
        });
        if (answerPrompt)
          stageUpdate(ctx, 'agentPrompts', answerPrompt.id, {
            status: 'answered',
            answeredByUserId: user.id,
            answerMessageId: id,
            answeredAt: now,
            version: answerPrompt.version + 1,
          });
        const requestedAt = kind === 'close' ? (session.closeRequestedAt ?? now) : session.closeRequestedAt;
        if (kind === 'close')
          stageUpdate(ctx, 'agentSessions', session.id, { closeRequestedAt: requestedAt, updatedAt: now });
        const payload =
          kind === 'close'
            ? { message_id: id, summary: text, author: user.displayName, delivery_status: 'queued' }
            : {
                message_id: id,
                ...(kind === 'answer' ? { prompt_id: input.promptId } : {}),
                text,
                ...metadata,
                author: user.displayName,
                delivery_status: 'queued',
              };
        stagePortalEvent(ctx, {
          sessionId: session.id,
          clientEventId: `portal:${kind === 'close' ? 'close' : 'message'}:${id}`,
          eventType: kind === 'close' ? 'close_requested' : 'user_message',
          source: 'portal',
          payloadEnc: this.encode(payload),
          createdAt: now,
        });
        return () => json(this.enqueuedView(row, requestedAt));
      },
    });
    const current = this.snapshot()
      .table('agentMessages')
      .by('messageId', String((reply as Record<string, Json>).message_id))[0];
    return current
      ? this.enqueuedView(current, this.snapshot().sessions.get(input.sessionId)?.closeRequestedAt ?? null)
      : reply;
  }
  private enqueuedView(row: Readonly<StateRow<'agentMessages'>> | AgentMessage, requestedAt: string | null) {
    const view = messageView(row as AgentMessage);
    return row.kind === 'close'
      ? {
          ...view,
          close_requested_at: requestedAt ?? row.createdAt,
          close: { requested_at: requestedAt ?? row.createdAt, state: closeState(row.status) },
        }
      : view;
  }
  async forceClose(admin: PortalActor, input: { sessionId: string; clientMessageId: string; note?: string }) {
    const note = normalizeCloseNote(input.note),
      clientId = normalizeUuid(input.clientMessageId, 'client_message_id');
    return mutateOwnerState(this.runtime, {
      kind: 'portal.force-close',
      principal: `admin:${admin.user.id}`,
      id: clientId,
      payload: json({ id: input.sessionId, note }),
      authorize: (s) => {
        enabled(s);
        actor(s, admin);
        visiblePortalSession(s, input.sessionId);
      },
      prepare: (ctx) => {
        const session = visiblePortalSession(ctx.snapshot, input.sessionId),
          user = actor(ctx.snapshot, admin);
        if (session.endedAt)
          return {
            forced: false,
            already_ended: true,
            status: session.status,
            ended_at: session.endedAt,
            expires_at: session.expiresAt,
          };
        const now = nowIso(),
          expires = isoOffsetSeconds(
            historyRetentionHours(this.runtime.state.snapshot(), this.env.AGENT_PORTAL_RETENTION_HOURS) *
              3600,
          );
        stagePortalEvent(ctx, {
          sessionId: session.id,
          clientEventId: `portal:close-force:${clientId}`,
          eventType: 'close_requested',
          source: 'portal',
          payloadEnc: this.encode({ summary: note, author: user.displayName, delivery_status: 'forced' }),
          createdAt: now,
        });
        const changed = stageUpdate(ctx, 'agentSessions', session.id, {
          closeRequestedAt: session.closeRequestedAt ?? now,
          updatedAt: now,
        });
        stagePortalSessionFinish(ctx, changed, 'completed', expires, now, this.keyring);
        return {
          forced: true,
          already_ended: false,
          status: 'completed',
          ended_at: now,
          expires_at: expires,
        };
      },
    });
  }
  async claim(
    id: string,
    token: string,
    claimId: string,
    hostId?: number,
    generation?: string,
  ): Promise<ClaimedMessage | null> {
    const claim = normalizeUuid(claimId, 'claim_id');
    const check = (s: OwnerStateSnapshot) => {
      const session = this.authority(s, id, token, hostId);
      if (receiverState(session.receiver)?.generation !== generation && session.receiver)
        throw new ConflictError('Receiver generation changed', 'receiver_generation_changed');
      return session;
    };
    const initial = this.snapshot();
    check(initial);
    const pending = initial
      .table('agentMessages')
      .by('sessionId', id)
      .filter((m) => ['queued', 'leased'].includes(m.status))
      .sort((a, b) => a.id - b.id);
    if (!pending.length) return null;
    if (
      initial
        .table('agentRebootHandoffs')
        .by('oldSessionId', id)
        .some((h) => h.status === 'armed')
    )
      return null;
    let offeredInstance: string | undefined;
    const result = await mutateOwnerState(this.runtime, {
      kind: 'portal.claim',
      principal: `portal:${id}`,
      id: claim,
      payload: { id, claim },
      authorize: (s) => {
        const current = check(s);
        if (offeredInstance && instance(this.runtime, s, current) !== offeredInstance) throw lost();
      },
      prepare: async (ctx) => {
        const session = check(ctx.snapshot),
          native = instance(this.runtime, ctx.snapshot, session),
          now = nowIso();
        offeredInstance = native;
        for (const row of ctx.draft
          .table('agentMessages')
          .by('sessionId', id)
          .filter((m) => ['queued', 'leased'].includes(m.status))
          .sort((a, b) => a.id - b.id)) {
          if (row.status === 'leased' && row.leaseOwner !== claim) return null;
          if (
            row.status === 'leased' &&
            (row.ownerInstanceId !== native || row.ownerBindingGeneration !== session.bindingGeneration)
          )
            throw lost();
          if (row.status === 'queued' && row.nextAttemptAt > now) return null;
          if (
            row.adminUserId === null ||
            ctx.snapshot.table('adminUsers').get(row.adminUserId)?.active !== 1 ||
            (row.attempts >= AGENT_PORTAL_MAX_DELIVERY_ATTEMPTS && row.status === 'queued')
          ) {
            stageUpdate(ctx, 'agentMessages', row.id, {
              status: 'canceled',
              canceledAt: now,
              leaseOwner: null,
              leaseUntil: null,
              updatedAt: now,
            });
            releaseAnswer(ctx, row, now);
            stageUndeliveredNotice(ctx, row, now, this.keyring);
            continue;
          }
          const [body] = await this.db
            .select({ content: agentMessages.contentEnc, metadata: agentMessages.metadataEnc })
            .from(agentMessages)
            .where(eq(agentMessages.id, row.id))
            .limit(1);
          if (!body) throw new Error('Portal body missing');
          const attempts = row.status === 'leased' ? row.attempts : row.attempts + 1;
          if (row.status !== 'leased')
            stageUpdate(ctx, 'agentMessages', row.id, {
              status: 'leased',
              attempts,
              leaseOwner: claim,
              leaseUntil: null,
              ownershipMode: 'connection',
              ownerInstanceId: native,
              ownerBindingGeneration: session.bindingGeneration,
              updatedAt: now,
            });
          return json({
            message_id: row.messageId,
            sequence: row.id,
            kind: row.kind,
            prompt_id: row.promptId,
            content: decrypt(body.content, this.keyring),
            metadata: this.decode(body.metadata, {}),
            attempts,
            lease_owner: claim,
            created_at: row.createdAt,
          });
        }
        return null;
      },
    });
    if (!result) return null;
    const snapshot = this.snapshot(),
      session = check(snapshot),
      message = snapshot
        .table('agentMessages')
        .by('messageId', String((result as Record<string, Json>).message_id))[0];
    if (!message || message.status !== 'leased' || message.leaseOwner !== claim) return null;
    if (
      message.ownerInstanceId !== instance(this.runtime, snapshot, session) ||
      message.ownerBindingGeneration !== session.bindingGeneration
    )
      throw lost();
    return result as unknown as ClaimedMessage;
  }
  async ack(
    id: string,
    token: string,
    input: {
      messageId: string;
      leaseOwner: string;
      outcome: 'accepted' | 'retry' | 'failed';
      upstreamId?: string | null;
      error?: string | null;
    },
    hostId?: number,
  ) {
    const upstream = normalizeOptionalText(input.upstreamId, 255),
      error = normalizeOptionalText(input.error, 2000);
    const auth = (s: OwnerStateSnapshot) => {
      const session = ownedSessionAuthority(s, id, token, { allowEnded: true }).session;
      if (hostId !== undefined && session.hostId !== hostId)
        throw new ForbiddenError('Agent bridge belongs to another host', 'agent_bridge_host_mismatch');
      return session;
    };
    return mutateOwnerState(this.runtime, {
      kind: 'portal.ack',
      principal: `portal:${id}`,
      id: `${input.leaseOwner}:${input.outcome}`,
      payload: json({ id, ...input, upstreamId: upstream, error }),
      authorize: (s) => {
        auth(s);
      },
      prepare: (ctx) => {
        const session = auth(ctx.snapshot),
          row = ctx.snapshot.table('agentMessages').by('messageId', input.messageId)[0];
        if (!row || row.sessionId !== id)
          throw new NotFoundError('Message not found', 'agent_message_not_found');
        if (row.leaseOwner !== input.leaseOwner) throw lost();
        if (row.status === 'accepted') {
          if (input.outcome !== 'accepted' || row.upstreamId !== upstream) throw lost();
          return json(messageView(row as AgentMessage));
        }
        if (row.status !== 'leased') throw lost();
        const native = ctx.snapshot.table('agentNativeControls').get(id);
        if (
          row.ownerInstanceId &&
          (native?.instanceId !== row.ownerInstanceId ||
            native.bindingGeneration !== row.ownerBindingGeneration ||
            (!session.endedAt && session.bindingGeneration !== row.ownerBindingGeneration))
        )
          throw lost();
        const now = nowIso();
        let next: Readonly<StateRow<'agentMessages'>>;
        if (input.outcome === 'accepted') {
          // A late receipt confirms an existing offer; it never grants new work.
          next = stageUpdate(ctx, 'agentMessages', row.id, {
            status: 'accepted',
            acceptedAt: now,
            upstreamId: upstream,
            lastError: null,
            leaseUntil: null,
            updatedAt: now,
          });
          stagePortalEvent(ctx, {
            sessionId: id,
            clientEventId: `server:accepted:${row.messageId}`,
            eventType: 'message_accepted',
            source: 'bridge',
            payloadEnc: this.encode({
              message_id: row.messageId,
              upstream_id: upstream,
              delivery_status: 'accepted',
            }),
            createdAt: now,
          });
          if (!session.endedAt)
            stageUpdate(ctx, 'agentSessions', id, {
              status: 'active',
              ...(upstream ? { activeTurnId: upstream } : {}),
              updatedAt: now,
            });
        } else if (input.outcome === 'retry' && row.attempts < AGENT_PORTAL_MAX_DELIVERY_ATTEMPTS) {
          next = stageUpdate(ctx, 'agentMessages', row.id, {
            status: 'queued',
            nextAttemptAt: isoOffsetSeconds(backoffSeconds(row.attempts)),
            lastError: error,
            leaseOwner: null,
            leaseUntil: null,
            ownerInstanceId: null,
            ownerBindingGeneration: null,
            updatedAt: now,
          });
        } else {
          next = stageUpdate(ctx, 'agentMessages', row.id, {
            status: 'dead',
            lastError: error ?? 'delivery failed',
            leaseOwner: null,
            leaseUntil: null,
            updatedAt: now,
          });
          releaseAnswer(ctx, row, now);
          stageUndeliveredNotice(ctx, row, now, this.keyring);
        }
        return json(messageView(next as AgentMessage));
      },
    });
  }
  async resolve(admin: PortalActor, id: string, noticeId: string, eventId: string) {
    const snapshot = this.snapshot(),
      notice = snapshot.table('agentChatNotices').get(noticeId);
    if (!notice || conversation(snapshot, notice.sessionId) !== conversation(snapshot, id))
      throw new NotFoundError('Notice not found');
    return this.addEvent(
      notice.sessionId,
      {
        clientEventId: eventId,
        type: 'attention_resolved',
        source: 'portal',
        payload: { notice_id: noticeId, summary: 'Marked resolved by the operator.' },
      },
      {},
      admin,
    );
  }
  async list(at?: number): Promise<{ generated_at: string; sessions: Array<Record<string, unknown>> }> {
    const snapshot = this.snapshot(),
      now = new Date(at ?? Date.now()).toISOString();
    const allNotices = snapshot
      .table('agentChatNotices')
      .all()
      .filter((n) => !n.resolvedAt);
    const sessions = snapshot.sessions
      .all()
      .filter(
        (s) =>
          snapshot.hosts.has(s.hostId) &&
          !snapshot.hosts.get(s.hostId)?.internalRole &&
          (!s.endedAt ||
            (!!s.expiresAt && s.expiresAt > now) ||
            allNotices.some((n) => n.sessionId === s.id)),
      )
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
    const ids = new Set(sessions.map((s) => s.id));
    const open = snapshot
      .table('agentPrompts')
      .all()
      .filter((p) => ids.has(p.sessionId) && p.status === 'open' && (!p.expiresAt || p.expiresAt > now));
    const notices = allNotices.filter((n) => ids.has(n.sessionId));
    // Requested cold content never serves as the change detector.
    const prompts = open.length
      ? await this.db
          .select()
          .from(agentPrompts)
          .where(
            inArray(
              agentPrompts.id,
              open.map((p) => p.id),
            ),
          )
      : [];
    const noticeBodies = notices.length
      ? await this.db
          .select({ id: agentChatNotices.id, payloadEnc: agentChatNotices.payloadEnc })
          .from(agentChatNotices)
          .where(
            inArray(
              agentChatNotices.id,
              notices.map((n) => n.id),
            ),
          )
      : [];
    const detailIds = [
      ...new Set([
        ...open.flatMap((p) => (p.eventId ? [p.eventId] : [])),
        ...sessions.flatMap((s) =>
          !s.endedAt && s.portalAttentionCursor > s.portalAttentionClearedCursor
            ? [s.portalAttentionCursor]
            : [],
        ),
      ]),
    ];
    const events = detailIds.length
      ? await this.db
          .select({
            id: agentEvents.id,
            createdAt: agentEvents.createdAt,
            payloadEnc: agentEvents.payloadEnc,
          })
          .from(agentEvents)
          .where(inArray(agentEvents.id, detailIds))
      : [];
    // Render only against unchanged authorization and prompt metadata.
    if (this.snapshot() !== snapshot) return this.list(at);
    const eventMap = new Map(
        events.map((e) => [e.id, { ...e, payload: this.decode<Record<string, unknown>>(e.payloadEnc, {}) }]),
      ),
      noticeMap = new Map(
        noticeBodies.map((n) => [n.id, this.decode<Record<string, unknown>>(n.payloadEnc, {})]),
      );
    const values = sessions.map((session) => {
      const host = snapshot.hosts.get(session.hostId)!,
        receiver = receiverState(session.receiver);
      let hostLive = false;
      try {
        ownedMessagingHost(snapshot, session.hostId);
        hostLive = true;
      } catch {
        /* Revoked hosts remain visible as offline. */
      }
      const connected =
        hostLive &&
        !session.endedAt &&
        (ownerPresence(this.runtime).hasSession(session.id, session.bindingGeneration) ||
          !!legacyDrainFor(this.runtime)?.session(session.id, session.bindingGeneration));
      const listening =
          connected &&
          (receiver ? ownedReceiverReady(this.runtime, session, 'portal') : session.relayEnabled === 1),
        working = connected && !!session.activeTurnId;
      const prompt = prompts.find((p) => p.sessionId === session.id),
        attention = eventMap.get(session.portalAttentionCursor),
        rank: Record<string, number> = { important: 1, critical: 2, blocker: 3 };
      const sessionNotices = notices
        .filter((n) => n.sessionId === session.id)
        .sort((a, b) => (rank[b.severity] ?? 0) - (rank[a.severity] ?? 0))
        .map((n) => ({
          id: n.id,
          severity: n.severity,
          since: n.createdAt,
          summary: noticeMap.get(n.id)?.summary ?? null,
        }));
      const close = snapshot
        .table('agentMessages')
        .by('sessionId', session.id)
        .filter((m) => m.kind === 'close')
        .sort((a, b) => b.id - a.id)[0];
      const reboot = snapshot
        .table('agentRebootHandoffs')
        .all()
        .find((r) => r.oldSessionId === session.id || r.newSessionId === session.id);
      const taskTitle = session.taskTitleNativeId === session.upstreamSessionId ? session.taskTitle : null;
      return {
        id: session.id,
        reboot: reboot
          ? {
              request_id: reboot.id,
              state: reboot.status,
              old_session_id: reboot.oldSessionId,
              new_session_id: reboot.newSessionId,
            }
          : null,
        engine: session.engine,
        host: host.fqdn,
        host_id: host.id,
        username: session.username,
        cwd: session.cwd,
        launch_name: session.launchName,
        task_title: taskTitle,
        session_name: namedSessionTitle(session.launchName, taskTitle),
        invocation_kind: session.invocationKind,
        upstream_session_id: session.upstreamSessionId,
        status: !session.endedAt && !connected ? 'offline' : session.status,
        presence: session.endedAt
          ? 'ended'
          : !connected
            ? 'offline'
            : working
              ? 'working'
              : listening
                ? 'listening'
                : 'idle',
        presence_source: 'connection',
        activity: activityView(session, at ?? Date.now(), !!prompt, this.activityConnected(session)),
        relay_ready: listening,
        receiver: ownedReceiverView(this.runtime, session),
        relay_enabled: session.relayEnabled === 1,
        relay_heartbeat_at: session.relayHeartbeatAt,
        active_turn_id: session.activeTurnId,
        active_turn_started_at: null,
        started_at: session.startedAt,
        heartbeat_at: session.heartbeatAt,
        last_event_at: session.portalLastEventAt,
        notices: sessionNotices,
        attention:
          sessionNotices[0] ??
          (!session.endedAt &&
          session.portalAttentionCursor > session.portalAttentionClearedCursor &&
          attention
            ? { since: attention.createdAt, summary: attention.payload.summary ?? null }
            : null),
        ended_at: session.endedAt,
        expires_at: session.expiresAt,
        close_requested_at: session.closeRequestedAt,
        close: close
          ? { requested_at: session.closeRequestedAt ?? close.createdAt, state: closeState(close.status) }
          : null,
        read_only: !!session.endedAt,
        pending_prompt: prompt
          ? {
              id: prompt.id,
              question: decrypt(prompt.questionEnc, this.keyring),
              options: this.decode(prompt.optionsEnc, []),
              attachments: prompt.eventId ? (eventMap.get(prompt.eventId)?.payload.attachments ?? []) : [],
              answer_mode: prompt.answerMode ?? 'both',
              choices: this.decode(prompt.choicesEnc, []),
              version: prompt.version,
              created_at: prompt.createdAt,
            }
          : null,
      };
    });
    return { generated_at: new Date(at ?? Date.now()).toISOString(), sessions: values };
  }
}
