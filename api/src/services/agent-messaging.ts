import { randomBytes, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import {
  and,
  asc,
  count,
  desc,
  eq,
  gt,
  inArray,
  isNotNull,
  isNull,
  lte,
  ne,
  or,
  sql,
} from 'drizzle-orm';

import type { Database } from '../db/client.js';
import {
  agentBusAddresses,
  agentBusConferenceMembers,
  agentBusConferences,
  agentBusConversations,
  agentBusMessages,
  agentBusRelays,
  agentSessions,
  hosts,
  logs,
  versions,
  type AgentBusAddress,
  type AgentBusConference,
  type AgentBusConferenceMember,
  type AgentBusConversation,
  type AgentBusMessage,
  type AgentBusRelay,
  type AgentSession,
  type Host,
} from '../db/schema.js';
import type { Env } from '../env.js';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ServiceUnavailableError,
  UnauthorizedError,
  ValidationError,
} from '../http/errors.js';
import { sha256 } from '../security/hash.js';
import type { Keyring } from '../security/keyring.js';
import { decrypt, encrypt } from '../security/secret-box.js';
import { ENGINE_CLAUDE, ENGINE_CODEX, type Engine } from '../util/engine.js';
import { isoOffsetSeconds, nowIso } from '../util/timestamp.js';
import { wsPublisher } from '../ws/publisher.js';
import {
  AGENT_PRESENCE_RANK,
  deriveAddressPresence,
  isPresent,
  type AgentAddressPresence,
} from './agent-presence.js';
import { hostEnginesList } from './host-engine-policy.js';
import { insecureWindowActive } from './insecure-window.js';
import { isTruthyFlagValue, SettingsService } from './settings.js';

export const AGENT_MESSAGING_ENABLED_KEY = 'agent_messaging_enabled';
export const AGENT_MESSAGING_MAX_BODY_BYTES = 32 * 1024;
export const AGENT_MESSAGING_DEFAULT_TTL_SECONDS = 24 * 60 * 60;
export const AGENT_MESSAGING_MIN_TTL_SECONDS = 60;
export const AGENT_MESSAGING_MAX_TTL_SECONDS = 7 * 24 * 60 * 60;
export const AGENT_MESSAGING_MAX_DELIVERY_ATTEMPTS = 12;
export const AGENT_MESSAGING_LEASE_SECONDS = 60;
export const AGENT_MESSAGING_RELAY_TOKEN_SECONDS = 15 * 60;
export const AGENT_MESSAGING_RECEIVE_FRESH_SECONDS = 45;
/**
 * Most addresses a single `agent_list` will return. Reachable peers are ranked
 * first, so this only ever truncates the dead tail; the reply carries `total`
 * and `truncated` so a caller is never quietly shown a partial fleet.
 */
export const AGENT_MESSAGING_LIST_LIMIT = 50;
export const AGENT_MESSAGING_WAIT_PAGE_SIZE = 100;
export const AGENT_MESSAGING_CALL_PIN_TTL_SECONDS = 10 * 60;
export const AGENT_MESSAGING_CALL_PIN_MIN_TTL_SECONDS = 60;
export const AGENT_MESSAGING_CALL_PIN_MAX_TTL_SECONDS = 60 * 60;
/** `0000`..`9999`. The PIN is read aloud off one terminal into another, so it stays four digits. */
export const AGENT_MESSAGING_CALL_PIN_SPACE = 10_000;
/** How far back a mailbox peek reports calls that expired unanswered. */
export const AGENT_MESSAGING_MISSED_WINDOW_SECONDS = 30 * 60;
export const AGENT_MESSAGING_CONFERENCE_TTL_SECONDS = 60 * 60;
export const AGENT_MESSAGING_CONFERENCE_MIN_TTL_SECONDS = 5 * 60;
export const AGENT_MESSAGING_CONFERENCE_MAX_TTL_SECONDS = 6 * 60 * 60;
/**
 * A room of eight is already 8 engine boots per broadcast round on the headless
 * path. The cap is about what a chair can actually run, not what the tables hold.
 */
export const AGENT_MESSAGING_CONFERENCE_MAX_MEMBERS = 8;
/**
 * Messages one member may exchange with the chair before the room is out of
 * budget. The 1:1 call's sixteen-turn bound is meaningless here -- a single
 * broadcast round across five members is already ten-plus messages -- so the
 * budget is per member and the deadline is wall-clock.
 */
export const AGENT_MESSAGING_CONFERENCE_MEMBER_MESSAGE_CAP = 12;
/** Shortest dispatch window. A headless task must survive at least one engine boot. */
export const AGENT_MESSAGING_CONFERENCE_DISPATCH_FLOOR_SECONDS = 15 * 60;
export const AGENT_MESSAGING_CONFERENCE_DISPATCH_MAX_SECONDS = 4 * 60 * 60;
/** Most rows a single mailbox peek will report. It runs on every turn boundary; keep it cheap. */
export const AGENT_MESSAGING_MAILBOX_PAGE_SIZE = 20;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CALL_PIN_RE = /^[0-9]{4}$/;
const LIVE_MESSAGE_STATUSES = ['queued', 'leased', 'accepted'] as const;
const CANCELABLE_MESSAGE_STATUSES = ['queued', 'leased'] as const;
const TERMINAL_MESSAGE_STATUSES = ['completed', 'ambiguous', 'dead', 'expired', 'canceled'] as const;

export type AgentMessagingDb = Pick<Database, 'insert' | 'update' | 'select' | 'delete'>;

export type AgentMessagingOutcome = 'accepted' | 'completed' | 'retry' | 'dead' | 'ambiguous';

export interface RegisterMessagingSessionInput {
  engine: Engine;
  username: string;
  cwd: string;
  upstreamSessionId?: string | null;
  invocationKind: 'interactive' | 'execute' | 'peer_delivery';
  resumed?: boolean;
  sessionId: string;
  bridgeToken: string;
  requestedAddress?: string | null;
  expectedBindingGeneration?: number | null;
  continuity?: 'native' | 'reset';
  adapterProtocol?: string | null;
  adapterCapabilities?: Record<string, unknown> | null;
}

export interface MessageDelivery {
  message_id: string;
  conversation_id: string;
  sequence: number;
  reply_to_message_id: string | null;
  kind: string;
  content: string;
  content_bytes: number;
  sender: Record<string, unknown>;
  target: Record<string, unknown>;
  attempts: number;
  claim_id: string;
  lease_owner: string;
  lease_until: string;
  expires_at: string;
}

export function normalizeMessageBody(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ValidationError('message body must not be empty', { param: 'content' });
  }
  const bytes = Buffer.byteLength(value, 'utf8');
  if (bytes > AGENT_MESSAGING_MAX_BODY_BYTES) {
    throw new ValidationError('message body exceeds 32 KiB', { param: 'content' });
  }
  return value;
}

export function normalizeCallPin(value: unknown): string {
  // Always a string. A number would drop the leading zeros of `0042`.
  const pin = typeof value === 'string' ? value.trim() : '';
  if (!CALL_PIN_RE.test(pin)) {
    throw new ValidationError('pin must be four digits', { param: 'pin' });
  }
  return pin;
}

export function normalizeCallPinTtl(value: unknown): number {
  if (value === undefined || value === null) return AGENT_MESSAGING_CALL_PIN_TTL_SECONDS;
  const ttl = Number(value);
  if (
    !Number.isSafeInteger(ttl) ||
    ttl < AGENT_MESSAGING_CALL_PIN_MIN_TTL_SECONDS ||
    ttl > AGENT_MESSAGING_CALL_PIN_MAX_TTL_SECONDS
  ) {
    throw new ValidationError('ttl_seconds must be between 60 and 3600', { param: 'ttl_seconds' });
  }
  return ttl;
}

export function normalizeConferenceTtl(value: unknown): number {
  if (value === undefined || value === null) return AGENT_MESSAGING_CONFERENCE_TTL_SECONDS;
  const ttl = Number(value);
  if (
    !Number.isSafeInteger(ttl) ||
    ttl < AGENT_MESSAGING_CONFERENCE_MIN_TTL_SECONDS ||
    ttl > AGENT_MESSAGING_CONFERENCE_MAX_TTL_SECONDS
  ) {
    throw new ValidationError('ttl_seconds must be between 300 and 21600', { param: 'ttl_seconds' });
  }
  return ttl;
}

export function normalizeConferenceMaxMembers(value: unknown): number {
  if (value === undefined || value === null) return AGENT_MESSAGING_CONFERENCE_MAX_MEMBERS;
  const max = Number(value);
  if (!Number.isSafeInteger(max) || max < 2 || max > AGENT_MESSAGING_CONFERENCE_MAX_MEMBERS) {
    throw new ValidationError(`max_members must be between 2 and ${AGENT_MESSAGING_CONFERENCE_MAX_MEMBERS}`, {
      param: 'max_members',
    });
  }
  return max;
}

export function normalizeDispatchEta(value: unknown): number {
  if (value === undefined || value === null) return AGENT_MESSAGING_CONFERENCE_DISPATCH_FLOOR_SECONDS;
  const eta = Number(value);
  if (!Number.isSafeInteger(eta) || eta < 0 || eta > AGENT_MESSAGING_CONFERENCE_DISPATCH_MAX_SECONDS) {
    throw new ValidationError('eta_seconds must be between 0 and 14400', { param: 'eta_seconds' });
  }
  // The floor is not a minimum the caller asked for -- it is how long the sweep
  // waits before declaring a silent member stuck. A task that claims it needs
  // thirty seconds still gets the full grace period, because a headless run
  // spends most of that booting an engine.
  return Math.max(eta, AGENT_MESSAGING_CONFERENCE_DISPATCH_FLOOR_SECONDS);
}

export function normalizeMessageTtl(value: unknown): number {
  if (value === undefined || value === null) return AGENT_MESSAGING_DEFAULT_TTL_SECONDS;
  const ttl = Number(value);
  if (
    !Number.isSafeInteger(ttl) ||
    ttl < AGENT_MESSAGING_MIN_TTL_SECONDS ||
    ttl > AGENT_MESSAGING_MAX_TTL_SECONDS
  ) {
    throw new ValidationError('ttl_seconds must be between 60 and 604800', {
      param: 'ttl_seconds',
    });
  }
  return ttl;
}

export function deliveryBackoffSeconds(attempt: number): number {
  const bounded = Math.max(1, Math.min(AGENT_MESSAGING_MAX_DELIVERY_ATTEMPTS, Math.trunc(attempt)));
  return Math.min(900, 2 ** bounded);
}

export class AgentMessagingService {
  private readonly settings: SettingsService;

  constructor(
    private readonly db: Database,
    private readonly env: Env,
    private readonly keyring: Keyring,
  ) {
    this.settings = new SettingsService(db);
  }

  async isEnabled(): Promise<boolean> {
    return await this.settings.getFlag(AGENT_MESSAGING_ENABLED_KEY, false);
  }

  async state(): Promise<Record<string, unknown>> {
    const enabled = await this.isEnabled();
    const now = nowIso();
    const freshAfter = isoOffsetSeconds(-AGENT_MESSAGING_RECEIVE_FRESH_SECONDS);
    const [addressRows, relayRows, queued, leased, accepted, dead, ambiguous, conversations, directionRows] =
      await Promise.all([
        this.db
          .select({
            engine: agentBusAddresses.engine,
            receiveHeartbeatAt: agentBusAddresses.receiveHeartbeatAt,
            hostStatus: hosts.status,
            hostSecure: hosts.secure,
            hostWindowUntil: hosts.insecureEnabledUntil,
            hostEngines: hosts.engines,
          })
          .from(agentBusAddresses)
          .innerJoin(hosts, eq(hosts.id, agentBusAddresses.hostId))
          .where(and(eq(agentBusAddresses.enabled, 1), isNull(agentBusAddresses.archivedAt))),
        this.db
          .select({
            tokenExpiresAt: agentBusRelays.tokenExpiresAt,
            hostStatus: hosts.status,
            hostSecure: hosts.secure,
            hostWindowUntil: hosts.insecureEnabledUntil,
          })
          .from(agentBusRelays)
          .innerJoin(hosts, eq(hosts.id, agentBusRelays.hostId))
          .where(eq(agentBusRelays.status, 'active')),
        this.db.select({ value: count() }).from(agentBusMessages).where(eq(agentBusMessages.status, 'queued')),
        this.db.select({ value: count() }).from(agentBusMessages).where(eq(agentBusMessages.status, 'leased')),
        this.db.select({ value: count() }).from(agentBusMessages).where(eq(agentBusMessages.status, 'accepted')),
        this.db.select({ value: count() }).from(agentBusMessages).where(eq(agentBusMessages.status, 'dead')),
        this.db.select({ value: count() }).from(agentBusMessages).where(eq(agentBusMessages.status, 'ambiguous')),
        this.db.select({ value: count() }).from(agentBusConversations).where(eq(agentBusConversations.status, 'open')),
        this.db
          .select({ sourceEngine: agentBusMessages.sourceEngine, targetEngine: agentBusMessages.targetEngine, status: agentBusMessages.status, value: count() })
          .from(agentBusMessages)
          .groupBy(agentBusMessages.sourceEngine, agentBusMessages.targetEngine, agentBusMessages.status),
      ]);
    const eligibleAddresses = enabled
      ? addressRows.filter((row) =>
        messagingHostEligible({
          status: row.hostStatus,
          secure: row.hostSecure,
          insecureEnabledUntil: row.hostWindowUntil,
        }) &&
        hostEnginesList(row.hostEngines).includes(row.engine as Engine),
      )
      : [];
    const eligibleRelays = enabled
      ? relayRows.filter((row) =>
        messagingHostEligible({
          status: row.hostStatus,
          secure: row.hostSecure,
          insecureEnabledUntil: row.hostWindowUntil,
        }) &&
        row.tokenExpiresAt != null &&
        row.tokenExpiresAt > now,
      )
      : [];
    const directions = [ENGINE_CODEX, ENGINE_CLAUDE].flatMap((sourceEngine) =>
      [ENGINE_CODEX, ENGINE_CLAUDE].map((targetEngine) => {
        const matching = directionRows.filter((row) => row.sourceEngine === sourceEngine && row.targetEngine === targetEngine);
        const value = (statuses: readonly string[]) => matching
          .filter((row) => statuses.includes(row.status))
          .reduce((sum, row) => sum + Number(row.value), 0);
        return {
          source_engine: sourceEngine,
          target_engine: targetEngine,
          total: value(matching.map((row) => row.status)),
          pending: value(LIVE_MESSAGE_STATUSES),
          completed: value(['completed']),
          dead: value(['dead']),
          ambiguous: value(['ambiguous']),
        };
      }),
    );
    return {
      enabled,
      initial_default: false,
      addresses: eligibleAddresses.length,
      live_addresses: eligibleAddresses.filter((row) => row.receiveHeartbeatAt != null && row.receiveHeartbeatAt > freshAfter).length,
      relays: eligibleRelays.length,
      open_conversations: Number(conversations[0]?.value ?? 0),
      messages: {
        queued: Number(queued[0]?.value ?? 0),
        leased: Number(leased[0]?.value ?? 0),
        accepted: Number(accepted[0]?.value ?? 0),
        dead: Number(dead[0]?.value ?? 0),
        ambiguous: Number(ambiguous[0]?.value ?? 0),
      },
      directions,
      delivery: 'ordered_at_least_once',
    };
  }

  async setEnabled(enabled: boolean): Promise<Record<string, unknown>> {
    const now = nowIso();
    const result = await this.db.transaction(async (tx) => {
      const rows = await tx
        .select({ version: versions.version })
        .from(versions)
        .where(eq(versions.name, AGENT_MESSAGING_ENABLED_KEY))
        .limit(1)
        .for('update');
      if (rows.length === 0) {
        await tx.insert(versions).values({
          name: AGENT_MESSAGING_ENABLED_KEY,
          version: enabled ? '1' : '0',
          updatedAt: now,
        });
      } else {
        await tx
          .update(versions)
          .set({ version: enabled ? '1' : '0', updatedAt: now })
          .where(eq(versions.name, AGENT_MESSAGING_ENABLED_KEY));
      }
      // The signed wrapper payload carries the effective messaging policy.
      // Mark every host stale on either edge so the normal config refresh path
      // converges without an operator reinstall.
      await tx
        .update(hosts)
        .set({ configVersion: sql`${hosts.configVersion} + 1`, updatedAt: now });
      if (enabled) {
        return { canceled: 0, ambiguous: 0, conversations: 0, relays: 0, bindings: 0 };
      }
      const [pending, uncertain, open, relayRows, bound] = await Promise.all([
        tx.select({ value: count() }).from(agentBusMessages).where(inArray(agentBusMessages.status, [...CANCELABLE_MESSAGE_STATUSES])),
        tx.select({ value: count() }).from(agentBusMessages).where(eq(agentBusMessages.status, 'accepted')),
        tx.select({ value: count() }).from(agentBusConversations).where(eq(agentBusConversations.status, 'open')),
        tx.select({ value: count() }).from(agentBusRelays).where(eq(agentBusRelays.status, 'active')),
        tx.select({ value: count() }).from(agentBusAddresses).where(or(isNull(agentBusAddresses.archivedAt), ne(agentBusAddresses.readiness, 'disabled'))),
      ]);
      await tx
        .update(agentBusMessages)
        .set({
          status: 'canceled',
          cancelRequestedAt: now,
          canceledAt: now,
          leaseOwner: null,
          leaseUntil: null,
          updatedAt: now,
        })
        .where(inArray(agentBusMessages.status, [...CANCELABLE_MESSAGE_STATUSES]));
      await tx
        .update(agentBusMessages)
        .set({
          status: 'ambiguous',
          ambiguousAt: now,
          lastErrorCode: 'master_disabled_after_accept',
          leaseOwner: null,
          leaseUntil: null,
          updatedAt: now,
        })
        .where(eq(agentBusMessages.status, 'accepted'));
      await tx
        .update(agentBusConversations)
        .set({
          status: 'canceled',
          canceledBy: 'system:master-switch',
          cancelReason: 'Agent Messaging disabled',
          canceledAt: now,
          updatedAt: now,
        })
        .where(eq(agentBusConversations.status, 'open'));
      await tx
        .update(agentBusRelays)
        .set({
          status: 'revoked',
          tokenHash: null,
          tokenExpiresAt: null,
          stopRequestedAt: now,
          updatedAt: now,
        })
        .where(eq(agentBusRelays.status, 'active'));
      await tx
        .update(agentBusAddresses)
        .set({
          currentSessionId: null,
          readiness: 'disabled',
          receiveHeartbeatAt: null,
          callPin: null,
          callPinExpiresAt: null,
          bindingGeneration: sql`${agentBusAddresses.bindingGeneration} + 1`,
          updatedAt: now,
        })
        .where(isNull(agentBusAddresses.archivedAt));
      await tx
        .update(agentSessions)
        .set({
          adapterProtocol: null,
          adapterCapabilities: null,
          receiveHeartbeatAt: null,
          bindingGeneration: sql`${agentSessions.bindingGeneration} + 1`,
          updatedAt: now,
        });
      return {
        canceled: Number(pending[0]?.value ?? 0),
        ambiguous: Number(uncertain[0]?.value ?? 0),
        conversations: Number(open[0]?.value ?? 0),
        relays: Number(relayRows[0]?.value ?? 0),
        bindings: Number(bound[0]?.value ?? 0),
      };
    });
    wsPublisher.publish('agent_messaging.state.changed', { enabled, ...result });
    wsPublisher.publish('settings.changed', { key: AGENT_MESSAGING_ENABLED_KEY });
    return { enabled, ...result };
  }

  /**
   * Revoke runtime eligibility so work cannot sit invisibly in-flight and
   * later replay when eligibility returns. Host status and engine demotions
   * call this. A secure-to-insecure demotion deliberately does not: an
   * insecure host is window-bounded, not disqualified, so its queue is left
   * intact to drain when the window reopens.
   */
  async suspendHostRuntime(
    hostId: number,
    reason: 'host_inactive' | 'engine_disabled',
    engines?: Engine[],
  ): Promise<Record<string, unknown>> {
    const result = await this.db.transaction(async (tx) =>
      await suspendAgentMessagingRuntimeLocked(tx, hostId, reason, engines),
    );
    wsPublisher.publish('agent_messaging.host.changed', { host_id: hostId, suspended: true, reason, ...result });
    return { host_id: hostId, suspended: true, reason, ...result };
  }

  async registerSession(host: Host, input: RegisterMessagingSessionInput): Promise<Record<string, unknown>> {
    if (!(await this.isEnabled())) return { enabled: false, reason: 'master_disabled' };
    this.assertEligibleHost(host);
    const sessionId = normalizeUuid(input.sessionId, 'session_id');
    const bridgeToken = normalizeBridgeToken(input.bridgeToken);
    const username = normalizeRequiredText(input.username, 'username', 255);
    const cwd = normalizeRequiredText(input.cwd, 'cwd', 1024);
    const now = nowIso();
    const bridgeExpiresAt = isoOffsetSeconds(this.env.AGENT_PORTAL_BRIDGE_TTL_SECONDS);
    const fingerprint = hostAuthFingerprint(host);
    const result = await this.db.transaction(async (tx) => {
      await this.requireEnabledLocked(tx);
      const lockedHost = await this.requireEligibleHostLocked(tx, host.id);
      if (!safeHashEqual(hostAuthFingerprint(lockedHost), fingerprint)) {
        throw new UnauthorizedError('Host credential changed during registration', 'agent_bridge_host_auth_changed');
      }
      if (!hostEnginesList(lockedHost.engines).includes(input.engine)) {
        throw new ForbiddenError(`Engine ${input.engine} is disabled for this host`, 'engine_disabled');
      }
      // A crashed wrapper may leave its durable address bound until the portal
      // reaper runs. Reclaim expired bindings for this identity in-band so a
      // restart reuses the same address instead of minting a split identity.
      await reapExpiredAgentMessagingBindingsLocked(tx, now, {
        hostId: host.id,
        engine: input.engine,
        username,
      });
      const existingRows = await tx.select().from(agentSessions).where(eq(agentSessions.id, sessionId)).limit(1).for('update');
      const existing = existingRows[0];
      if (existing) {
        this.assertSessionRegistration(existing, host, input.engine, username, cwd, input.invocationKind, bridgeToken);
        if (existing.endedAt) throw new ConflictError('Agent session is finished', 'agent_session_finished');
        await tx.update(agentSessions).set({ hostAuthFingerprint: fingerprint, bridgeExpiresAt, heartbeatAt: now, updatedAt: now }).where(eq(agentSessions.id, sessionId));
      } else {
        await tx.insert(agentSessions).values({
          id: sessionId,
          hostId: host.id,
          engine: input.engine,
          username,
          cwd,
          upstreamSessionId: normalizeOptionalText(input.upstreamSessionId, 255),
          agentBusAddressId: null,
          invocationKind: input.invocationKind,
          status: 'active',
          relayEnabled: 0,
          relayHeartbeatAt: null,
          activeTurnId: null,
          adapterProtocol: normalizeOptionalText(input.adapterProtocol, 32),
          adapterCapabilities: input.adapterCapabilities ?? null,
          receiveHeartbeatAt: null,
          bindingGeneration: 0,
          hostAuthFingerprint: fingerprint,
          bridgeTokenHash: sha256(bridgeToken),
          bridgeExpiresAt,
          startedAt: now,
          heartbeatAt: now,
          endedAt: null,
          expiresAt: null,
          createdAt: now,
          updatedAt: now,
        });
      }

      const currentRows = await tx.select().from(agentSessions).where(eq(agentSessions.id, sessionId)).limit(1).for('update');
      const current = currentRows[0]!;
      let address: AgentBusAddress | null = null;
      let inferredContinuity: 'native' | 'reset' | null = null;
      if (current.agentBusAddressId) {
        const rows = await tx.select().from(agentBusAddresses).where(eq(agentBusAddresses.id, current.agentBusAddressId)).limit(1).for('update');
        address = rows[0] ?? null;
        if (!address || address.archivedAt || address.enabled !== 1) {
          throw new ConflictError('Agent address binding changed', 'agent_messaging_binding_stale');
        }
      }
      if (!address && input.requestedAddress) {
        address = await this.resolveAddressLocked(tx, input.requestedAddress, true);
        this.assertAddressRegistration(address, host, input.engine, username, cwd);
        inferredContinuity = input.upstreamSessionId ? 'native' : 'reset';
        if (
          input.expectedBindingGeneration != null &&
          address.bindingGeneration !== input.expectedBindingGeneration
        ) {
          throw new ConflictError('Agent address binding changed', 'agent_messaging_binding_stale');
        }
      }
      if (!address && input.upstreamSessionId) {
        const rows = await tx
          .select()
          .from(agentBusAddresses)
          .where(and(eq(agentBusAddresses.hostId, host.id), eq(agentBusAddresses.engine, input.engine), eq(agentBusAddresses.username, username), eq(agentBusAddresses.lastUpstreamSessionId, input.upstreamSessionId), eq(agentBusAddresses.enabled, 1), isNull(agentBusAddresses.archivedAt)))
          .orderBy(desc(agentBusAddresses.lastSeenAt))
          .limit(1)
          .for('update');
        if (rows[0] && (!rows[0].currentSessionId || rows[0].currentSessionId === sessionId)) {
          address = rows[0];
          inferredContinuity = 'native';
        }
      }
      if (!address) {
        // A fresh native session has no upstream transcript id yet. Reuse the
        // latest dormant identity for the same host/user/engine/cwd and mark
        // continuity reset; concurrent live sessions still get distinct
        // addresses because only an unbound row is eligible here.
        const rows = await tx
          .select()
          .from(agentBusAddresses)
          .where(and(
            eq(agentBusAddresses.hostId, host.id),
            eq(agentBusAddresses.engine, input.engine),
            eq(agentBusAddresses.username, username),
            eq(agentBusAddresses.cwdHash, sha256(cwd)),
            eq(agentBusAddresses.enabled, 1),
            isNull(agentBusAddresses.currentSessionId),
            isNull(agentBusAddresses.archivedAt),
          ))
          .orderBy(desc(agentBusAddresses.lastSeenAt))
          .limit(1)
          .for('update');
        if (rows[0]) {
          address = rows[0];
          inferredContinuity = 'reset';
        }
      }
      if (!address) {
        const id = randomUUID();
        address = {
          id,
          address: `agent:${id}`,
          displayAlias: null,
          hostId: host.id,
          engine: input.engine,
          username,
          cwd,
          cwdHash: sha256(cwd),
          enabled: 1,
          currentSessionId: sessionId,
          callPin: null,
          callPinExpiresAt: null,
          lastUpstreamSessionId: normalizeOptionalText(input.upstreamSessionId, 255),
          bindingGeneration: 1,
          continuity: input.continuity ?? (input.upstreamSessionId ? 'native' : 'reset'),
          adapterProtocol: normalizeOptionalText(input.adapterProtocol, 32),
          adapterCapabilities: input.adapterCapabilities ?? null,
          readiness: input.adapterProtocol ? 'ready' : 'resumable',
          receiveHeartbeatAt: input.adapterProtocol ? now : null,
          lastSeenAt: now,
          archivedAt: null,
          createdAt: now,
          updatedAt: now,
        };
        await tx.insert(agentBusAddresses).values(address);
      } else {
        if (address.currentSessionId && address.currentSessionId !== sessionId) {
          throw new ConflictError('Agent address is already bound to another lifecycle', 'agent_messaging_address_busy');
        }
        const nextGeneration = address.currentSessionId === sessionId ? address.bindingGeneration : address.bindingGeneration + 1;
        const nextContinuity = input.continuity ?? (
          address.currentSessionId === sessionId
            ? address.continuity
            : inferredContinuity ?? (input.upstreamSessionId || input.resumed ? 'native' : 'reset')
        );
        const nextUpstream = normalizeOptionalText(input.upstreamSessionId, 255) ?? (
          nextContinuity === 'reset' ? null : address.lastUpstreamSessionId
        );
        await tx
          .update(agentBusAddresses)
          .set({
            currentSessionId: sessionId,
            lastUpstreamSessionId: nextUpstream,
            bindingGeneration: nextGeneration,
            continuity: nextContinuity,
            adapterProtocol: normalizeOptionalText(input.adapterProtocol, 32),
            adapterCapabilities: input.adapterCapabilities ?? null,
            readiness: input.adapterProtocol ? 'ready' : 'resumable',
            receiveHeartbeatAt: input.adapterProtocol ? now : null,
            lastSeenAt: now,
            updatedAt: now,
          })
          .where(eq(agentBusAddresses.id, address.id));
        address = {
          ...address,
          currentSessionId: sessionId,
          lastUpstreamSessionId: nextUpstream,
          bindingGeneration: nextGeneration,
          continuity: nextContinuity,
        };
      }
      await tx
        .update(agentSessions)
        .set({
          agentBusAddressId: address.id,
          upstreamSessionId: normalizeOptionalText(input.upstreamSessionId, 255) ?? current.upstreamSessionId,
          adapterProtocol: normalizeOptionalText(input.adapterProtocol, 32),
          adapterCapabilities: input.adapterCapabilities ?? null,
          receiveHeartbeatAt: input.adapterProtocol ? now : null,
          bindingGeneration: address.bindingGeneration,
          heartbeatAt: now,
          bridgeExpiresAt,
          updatedAt: now,
        })
        .where(eq(agentSessions.id, sessionId));
      return { address, bridgeExpiresAt };
    });
    wsPublisher.publish('agent_messaging.address.changed', { address_id: result.address.id, host_id: host.id, engine: input.engine });
    return {
      enabled: true,
      session_id: sessionId,
      bridge_token: bridgeToken,
      expires_at: result.bridgeExpiresAt,
      address: publicAddress(result.address),
    };
  }

  async heartbeatSession(
    sessionId: string,
    bridgeToken: string,
    input: {
      status?: string;
      upstreamSessionId?: string | null;
      adapterProtocol?: string | null;
      adapterCapabilities?: Record<string, unknown> | null;
      receiveCapable?: boolean;
      expectedBindingGeneration?: number | null;
      continuity?: 'native' | 'reset';
      /**
       * Return null instead of raising when this session never received a
       * messaging address.
       *
       * The shared liveness heartbeat is sent by *every* managed session,
       * including ones that registered while the fleet switch was off and so
       * were never given an address. For those, messaging simply does not
       * apply, and raising a conflict fails the whole shared heartbeat —
       * taking Agent Portal down with it for the life of the session. An
       * explicit bind keeps raising, because there the caller is asking for a
       * binding it must be told it cannot have.
       */
      skipIfUnbound?: boolean;
    },
  ): Promise<Record<string, unknown> | null> {
    const authenticated = await this.authenticateBridge(sessionId, bridgeToken);
    const now = nowIso();
    const expiresAt = isoOffsetSeconds(this.env.AGENT_PORTAL_BRIDGE_TTL_SECONDS);
    const result = await this.db.transaction(async (tx) => {
      await this.requireEnabledLocked(tx);
      const session = await this.requireBridgeSessionLocked(tx, authenticated.session.id, bridgeToken, authenticated.host.id);
      if (!session.agentBusAddressId) {
        if (input.skipIfUnbound) return null;
        throw new ConflictError('Agent session has no messaging address', 'agent_messaging_address_missing');
      }
      const addressRows = await tx.select().from(agentBusAddresses).where(eq(agentBusAddresses.id, session.agentBusAddressId)).limit(1).for('update');
      const address = addressRows[0];
      if (!address || address.archivedAt || address.enabled !== 1) throw new ForbiddenError('Agent address is disabled', 'agent_messaging_address_disabled');
      if (address.currentSessionId !== session.id) throw new ConflictError('Agent address binding changed', 'agent_messaging_binding_stale');
      await this.assertAddressEligibleLocked(tx, address);
      if (input.expectedBindingGeneration != null && address.bindingGeneration !== input.expectedBindingGeneration) {
        throw new ConflictError('Agent address binding changed', 'agent_messaging_binding_stale');
      }
      const receiveHeartbeatAt = input.receiveCapable === undefined
        ? session.receiveHeartbeatAt
          ? now
          : null
        : input.receiveCapable
          ? now
          : null;
      const protocol = normalizeOptionalText(input.adapterProtocol, 32) ?? session.adapterProtocol;
      const upstream = normalizeOptionalText(input.upstreamSessionId, 255) ?? session.upstreamSessionId;
      const status = normalizeSessionStatus(input.status) ?? session.status;
      await tx
        .update(agentSessions)
        .set({
          status,
          upstreamSessionId: upstream,
          adapterProtocol: protocol,
          adapterCapabilities: input.adapterCapabilities ?? session.adapterCapabilities,
          receiveHeartbeatAt,
          heartbeatAt: now,
          bridgeExpiresAt: expiresAt,
          updatedAt: now,
        })
        .where(eq(agentSessions.id, session.id));
      await tx
        .update(agentBusAddresses)
        .set({
          lastUpstreamSessionId: upstream ?? address.lastUpstreamSessionId,
          continuity: input.continuity ?? address.continuity,
          adapterProtocol: protocol,
          adapterCapabilities: input.adapterCapabilities ?? address.adapterCapabilities,
          readiness: input.receiveCapable === undefined
            ? address.readiness
            : input.receiveCapable
              ? 'live'
              : upstream
                ? 'resumable'
                : 'offline',
          receiveHeartbeatAt,
          lastSeenAt: now,
          updatedAt: now,
        })
        .where(eq(agentBusAddresses.id, address.id));
      return { address, status };
    });
    if (!result) return null;
    return {
      enabled: true,
      expires_at: expiresAt,
      status: result.status,
      address: publicAddress(result.address),
    };
  }

  async finishSession(sessionId: string, bridgeToken: string, status: 'completed' | 'failed'): Promise<Record<string, unknown>> {
    const authenticated = await this.authenticateBridge(sessionId, bridgeToken, true);
    const now = nowIso();
    await this.db.transaction(async (tx) => {
      const rows = await tx.select().from(agentSessions).where(eq(agentSessions.id, sessionId)).limit(1).for('update');
      const session = rows[0];
      if (!session) return;
      await tx
        .update(agentSessions)
        .set({ status, endedAt: session.endedAt ?? now, receiveHeartbeatAt: null, adapterProtocol: null, adapterCapabilities: null, updatedAt: now })
        .where(eq(agentSessions.id, sessionId));
      if (session.agentBusAddressId) {
        await tx
          .update(agentBusAddresses)
          // The PIN dies with the session that opened it: it lives on the
          // address, which outlives the session, so a survivor would leave a
          // later join dialling an address with nobody on it.
          .set({ currentSessionId: null, readiness: session.upstreamSessionId ? 'resumable' : 'offline', receiveHeartbeatAt: null, callPin: null, callPinExpiresAt: null, lastUpstreamSessionId: session.upstreamSessionId, lastSeenAt: now, updatedAt: now })
          .where(and(eq(agentBusAddresses.id, session.agentBusAddressId), eq(agentBusAddresses.currentSessionId, sessionId)));
      }
    });
    wsPublisher.publish('agent_messaging.address.changed', { address_id: authenticated.session.agentBusAddressId, status });
    return { enabled: true, status };
  }

  async listAddresses(sessionId: string, bridgeToken: string, filters: { engine?: Engine; hostId?: number; includeOffline?: boolean } = {}): Promise<Record<string, unknown>> {
    const authenticated = await this.authenticateBridge(sessionId, bridgeToken);
    const currentAddressId = authenticated.session.agentBusAddressId;
    if (!currentAddressId) throw new ConflictError('Agent session has no messaging address', 'agent_messaging_address_missing');
    const predicates = [
      eq(agentBusAddresses.enabled, 1),
      isNull(agentBusAddresses.archivedAt),
      messagingHostEligibleSql(),
      ne(agentBusAddresses.id, currentAddressId),
    ];
    if (filters.engine) predicates.push(eq(agentBusAddresses.engine, filters.engine));
    if (filters.hostId) predicates.push(eq(agentBusAddresses.hostId, filters.hostId));
    const rows = await this.db.transaction(async (tx) => {
      await this.requireEnabledLocked(tx);
      const current = await this.requireAddressLocked(tx, currentAddressId);
      await this.assertSessionAddressLocked(tx, authenticated.session.id, current);
      return await tx
        .select({
          address: agentBusAddresses,
          fqdn: hosts.fqdn,
          hostEngines: hosts.engines,
          // Left, not inner: an address whose binding was reaped has no session
          // row to join, and that absence is itself the answer.
          session: { heartbeatAt: agentSessions.heartbeatAt, endedAt: agentSessions.endedAt },
        })
        .from(agentBusAddresses)
        .innerJoin(hosts, eq(hosts.id, agentBusAddresses.hostId))
        .leftJoin(agentSessions, eq(agentSessions.id, agentBusAddresses.currentSessionId))
        .where(and(...predicates))
        .orderBy(asc(agentBusAddresses.address));
    });
    const freshAfter = isoOffsetSeconds(-this.env.AGENT_PORTAL_HEARTBEAT_FRESH_SECONDS);
    const ranked = rows
      .filter((row) => hostEnginesList(row.hostEngines).includes(row.address.engine as Engine))
      .map((row) => ({ ...row, presence: deriveAddressPresence(row.address, row.session, freshAfter) }))
      // `online: true` reaches here as `includeOffline: false`. It filters on
      // derived presence, not on `readiness`: that column is a registration
      // latch, so the old blocklist reported a peer as reachable for as long as
      // its row survived — a month, in the worst case observed live.
      .filter((row) => filters.includeOffline !== false || isPresent(row.presence))
      // Reachable first, then most recently seen. The old ordering was
      // alphabetical by address, which is a UUID — so truncating it would have
      // cut at random. Ranking is what makes the cap below safe.
      .sort(
        (a, b) =>
          AGENT_PRESENCE_RANK[a.presence] - AGENT_PRESENCE_RANK[b.presence] ||
          (a.address.lastSeenAt < b.address.lastSeenAt ? 1 : a.address.lastSeenAt > b.address.lastSeenAt ? -1 : 0),
      );
    // An address is never deleted when its agent exits, so this list is a
    // history that only grows: 201 rows fleet-wide, 104 on one host, and 92 KB
    // of JSON that overflowed the context of the agent that asked. Live peers
    // number in the handful, so a ranked cap loses nothing a caller can act on
    // — and says so rather than silently truncating.
    const addresses = ranked.slice(0, AGENT_MESSAGING_LIST_LIMIT);
    return {
      addresses: addresses.map((row) => publicAddress(row.address, row.fqdn, row.presence)),
      total: ranked.length,
      ...(ranked.length > addresses.length ? { truncated: true } : {}),
    };
  }

  /**
   * Clear every PIN whose window has closed.
   *
   * Runs before any mint or redeem, and again on the maintenance tick. An
   * expired-but-uncleared PIN still occupies its slot in the unique index, so
   * without this the mint-from-complement scan would treat a dead rendezvous as
   * a live one.
   */
  private async sweepCallPinsLocked(db: AgentMessagingDb, now: string): Promise<void> {
    await db
      .update(agentBusAddresses)
      .set({ callPin: null, callPinExpiresAt: null, updatedAt: now })
      .where(and(isNotNull(agentBusAddresses.callPin), lte(agentBusAddresses.callPinExpiresAt, now)));
    // Conference PINs share the four-digit space and therefore the sweep. A dead
    // room PIN left in place would occupy a slot the call mint cannot reuse.
    await db
      .update(agentBusConferences)
      .set({ pin: null, pinExpiresAt: null, updatedAt: now })
      .where(and(isNotNull(agentBusConferences.pin), lte(agentBusConferences.pinExpiresAt, now)));
  }

  /**
   * Every PIN currently spoken for, across both rendezvous kinds.
   *
   * The two spaces are deliberately one space. A human carrying four digits from
   * one terminal to another cannot be expected to also carry which *kind* of
   * thing those digits open, and `#call receiver 4821` against a conference PIN
   * should fail as "wrong kind" rather than silently dial an unrelated stranger
   * who happens to hold the same number. MySQL cannot express a UNIQUE across
   * two tables, so the invariant lives here, in the mint.
   */
  private async livePinsLocked(db: AgentMessagingDb): Promise<Set<string>> {
    const addressRows = await db
      .select({ pin: agentBusAddresses.callPin })
      .from(agentBusAddresses)
      .where(isNotNull(agentBusAddresses.callPin))
      .for('update');
    const conferenceRows = await db
      .select({ pin: agentBusConferences.pin })
      .from(agentBusConferences)
      .where(isNotNull(agentBusConferences.pin))
      .for('update');
    return new Set(
      [...addressRows, ...conferenceRows].map((row) => row.pin).filter((pin): pin is string => pin !== null),
    );
  }

  /**
   * Choose from the complement of the live set rather than retrying random
   * values against a unique index: a duplicate insert inside a transaction would
   * surface as a driver-level ER_DUP_ENTRY this layer would have to
   * pattern-match, and exhaustion would be indistinguishable from bad luck.
   */
  private pickFreePin(taken: Set<string>): string {
    const free: string[] = [];
    for (let candidate = 0; candidate < AGENT_MESSAGING_CALL_PIN_SPACE; candidate += 1) {
      const pin = String(candidate).padStart(4, '0');
      if (!taken.has(pin)) free.push(pin);
    }
    if (free.length === 0) {
      throw new ConflictError('No call PIN is available', 'agent_messaging_call_pin_exhausted');
    }
    return free[randomInt(free.length)]!;
  }

  /** Pick a free PIN and bind it to this address. */
  private async mintCallPinLocked(
    db: AgentMessagingDb,
    addressId: string,
    expiresAt: string,
    now: string,
  ): Promise<string> {
    const pin = this.pickFreePin(await this.livePinsLocked(db));
    await db
      .update(agentBusAddresses)
      .set({ callPin: pin, callPinExpiresAt: expiresAt, updatedAt: now })
      .where(eq(agentBusAddresses.id, addressId));
    return pin;
  }

  /** Pick a free PIN and bind it to this conference. */
  private async mintConferencePinLocked(
    db: AgentMessagingDb,
    conferenceId: string,
    expiresAt: string,
    now: string,
  ): Promise<string> {
    const pin = this.pickFreePin(await this.livePinsLocked(db));
    await db
      .update(agentBusConferences)
      .set({ pin, pinExpiresAt: expiresAt, updatedAt: now })
      .where(eq(agentBusConferences.id, conferenceId));
    return pin;
  }

  /**
   * Resolve a PIN to the address that opened it.
   *
   * Deliberately does not clear the PIN: the caller clears it only once the join
   * has fully succeeded, so a join that fails validation, targets itself, or
   * finds an ineligible opener leaves the rendezvous intact. One mistyped join
   * must not burn a PIN the human is still holding.
   *
   * The failure names all three ways a lookup comes up empty rather than
   * guessing between them, because nothing here can tell them apart: a swept PIN
   * and a spent PIN both leave the same NULL, and the four-digit space is shared
   * with conferences and re-minted constantly, so any remembered "last PIN"
   * would sooner or later belong to a stranger. The third cause is the one worth
   * spelling out — a human who hands one PIN to a third agent reads "not found"
   * as a typo and re-reads the digits, when what they actually want is a
   * conference.
   */
  private async consumeCallPinLocked(db: AgentMessagingDb, pin: string, now: string): Promise<AgentBusAddress> {
    const rows = await db
      .select()
      .from(agentBusAddresses)
      .where(and(eq(agentBusAddresses.callPin, pin), gt(agentBusAddresses.callPinExpiresAt, now)))
      .limit(1)
      .for('update');
    const address = rows[0];
    if (!address || address.archivedAt) {
      throw new NotFoundError(
        'Call PIN not found, expired, or already dialled. A call PIN is single-use and joins exactly two agents; for three or more, open a conference instead.',
        'agent_messaging_call_pin_not_found',
      );
    }
    return address;
  }

  private async clearCallPinLocked(db: AgentMessagingDb, addressId: string, now: string): Promise<void> {
    await db
      .update(agentBusAddresses)
      .set({ callPin: null, callPinExpiresAt: null, updatedAt: now })
      .where(eq(agentBusAddresses.id, addressId));
  }

  /**
   * Open a `#call` rendezvous: mint a PIN a peer can dial, and tell the caller
   * its own address.
   *
   * `self` is the only route by which an agent learns its own address —
   * `listAddresses` excludes the caller by construction.
   */
  async openCall(
    sessionId: string,
    bridgeToken: string,
    input: { ttlSeconds?: number | null } = {},
  ): Promise<Record<string, unknown>> {
    const authenticated = await this.authenticateBridge(sessionId, bridgeToken);
    if (!authenticated.session.agentBusAddressId) {
      throw new ConflictError('Agent session has no messaging address', 'agent_messaging_address_missing');
    }
    const ttlSeconds = normalizeCallPinTtl(input.ttlSeconds);
    const result = await this.db.transaction(async (tx) => {
      await this.requireEnabledLocked(tx);
      const now = nowIso();
      await this.sweepCallPinsLocked(tx, now);
      const self = await this.requireAddressLocked(tx, authenticated.session.agentBusAddressId!);
      await this.assertSessionAddressLocked(tx, authenticated.session.id, self);
      await this.assertAddressEligibleLocked(tx, self);
      // Re-opening while a PIN is still live returns the same one. Minting a
      // second would silently kill a PIN the human may already have written down.
      if (self.callPin && self.callPinExpiresAt && self.callPinExpiresAt > now) {
        return { pin: self.callPin, expiresAt: self.callPinExpiresAt, reused: true, self };
      }
      const expiresAt = isoOffsetSeconds(ttlSeconds);
      const pin = await this.mintCallPinLocked(tx, self.id, expiresAt, now);
      return { pin, expiresAt, reused: false, self };
    });
    return {
      enabled: true,
      pin: result.pin,
      expires_at: result.expiresAt,
      reused: result.reused,
      self: publicAddress(result.self),
    };
  }

  /**
   * Dial a PIN: open the conversation and deliver the first message in one step.
   *
   * The hello is folded in for atomicity — PIN consumed, conversation opened and
   * first message queued all commit together. Split across two calls, a failed
   * follow-up send would leave a consumed single-use PIN, an orphan conversation
   * and an opener waiting on a rendezvous it can no longer be reached through.
   */
  async joinCall(
    sessionId: string,
    bridgeToken: string,
    input: { pin: string; content: string; clientMessageId: string; ttlSeconds?: number | null },
  ): Promise<Record<string, unknown>> {
    const authenticated = await this.authenticateBridge(sessionId, bridgeToken);
    if (!authenticated.session.agentBusAddressId) {
      throw new ConflictError('Agent session has no messaging address', 'agent_messaging_address_missing');
    }
    const pin = normalizeCallPin(input.pin);
    const content = normalizeMessageBody(input.content);
    const clientMessageId = normalizeUuid(input.clientMessageId, 'client_message_id');
    const ttlSeconds = normalizeMessageTtl(input.ttlSeconds);
    const result = await this.db.transaction(async (tx) => {
      await this.requireEnabledLocked(tx);
      const now = nowIso();
      await this.sweepCallPinsLocked(tx, now);
      const opener = await this.consumeCallPinLocked(tx, pin, now);
      const self = await this.requireAddressLocked(tx, authenticated.session.agentBusAddressId!);
      await this.assertSessionAddressLocked(tx, authenticated.session.id, self);
      if (self.id === opener.id) {
        throw new ValidationError('An agent cannot call itself', { param: 'pin' });
      }
      await this.assertAddressEligibleLocked(tx, opener);

      const conversation: AgentBusConversation = {
        id: randomUUID(),
        addressAId: opener.id,
        addressBId: self.id,
        createdByAddressId: self.id,
        nextSequence: 1,
        status: 'open',
        lastActivityAt: now,
        canceledBy: null,
        cancelReason: null,
        canceledAt: null,
        createdAt: now,
        updatedAt: now,
      };
      await tx.insert(agentBusConversations).values(conversation);
      const messageId = randomUUID();
      await tx.insert(agentBusMessages).values(
        newQueuedMessage({
          id: messageId,
          conversationId: conversation.id,
          sequence: 1,
          sender: self,
          senderSessionId: authenticated.session.id,
          target: opener,
          kind: 'message',
          content,
          contentEnc: encrypt(content, this.keyring),
          clientMessageId,
          expiresAt: isoOffsetSeconds(ttlSeconds),
          now,
        }),
      );
      const persistedRows = await tx.select().from(agentBusMessages).where(eq(agentBusMessages.id, messageId)).limit(1);
      const persisted = persistedRows[0];
      if (!persisted) throw new Error('Inserted agent message could not be read back');
      await tx
        .update(agentBusConversations)
        .set({ nextSequence: 2, lastActivityAt: now, updatedAt: now })
        .where(eq(agentBusConversations.id, conversation.id));
      // Single-use, and consumed only here — after every check has passed.
      await this.clearCallPinLocked(tx, opener.id, now);
      return { conversation, message: persisted, self, opener };
    });
    await this.recordRuntime('agent_message.queued', authenticated.host.id, result.self.engine, {
      message_id: result.message.id,
      conversation_id: result.message.conversationId,
      source_address_id: result.self.id,
      target_address_id: result.opener.id,
      source_engine: result.self.engine,
      target_engine: result.opener.engine,
      content_bytes: result.message.contentBytes,
    });
    wsPublisher.publish('agent_messaging.message.changed', {
      message_id: result.message.id,
      conversation_id: result.message.conversationId,
      status: result.message.status,
    });
    return {
      enabled: true,
      conversation_id: result.conversation.id,
      peer: publicAddress(result.opener),
      self: publicAddress(result.self),
      message: messageForParticipant(result.message, content, result.self, result.opener),
    };
  }

  // =====================================================================
  // Conferences
  //
  // A conference is an owner, a roster, and the authority to dispatch and
  // adjourn. Its transport is a star: every member holds one ordinary
  // two-party conversation with the owner, and the owner relays. Nothing here
  // introduces an N-party conversation, because the delivery leases, the
  // per-conversation sequence and the one-in-flight-per-address rule in
  // `claimDelivery` are all written against exactly two participants.
  //
  // The 1:1 call's token invariant -- "at any instant exactly one side holds
  // the token" -- does not survive N parties, so it is replaced rather than
  // stretched. Every message creates exactly one obligation, and the chair's
  // reply to a participant is always turn-terminal: a participant that
  // receives one goes back to listening or exits, it does not reply again.
  // Only the chair opens a round. That asymmetry is what makes a five-way
  // room terminate; the skill states it, and these methods are shaped so an
  // agent following it cannot accidentally start a second round.
  // =====================================================================

  private async requireConferenceLocked(db: AgentMessagingDb, id: string): Promise<AgentBusConference> {
    const rows = await db.select().from(agentBusConferences).where(eq(agentBusConferences.id, id)).limit(1).for('update');
    const conference = rows[0];
    if (!conference) throw new NotFoundError('Conference not found', 'agent_messaging_conference_not_found');
    return conference;
  }

  private async requireMemberLocked(
    db: AgentMessagingDb,
    conferenceId: string,
    addressId: string,
  ): Promise<AgentBusConferenceMember> {
    const rows = await db
      .select()
      .from(agentBusConferenceMembers)
      .where(and(eq(agentBusConferenceMembers.conferenceId, conferenceId), eq(agentBusConferenceMembers.addressId, addressId)))
      .limit(1)
      .for('update');
    const member = rows[0];
    if (!member || member.state === 'left') {
      throw new ForbiddenError('Not a member of this conference', 'agent_messaging_conference_not_member');
    }
    return member;
  }

  /** Dispatch and adjourn are the chair's alone; everything else any member may do. */
  private async requireChairLocked(
    db: AgentMessagingDb,
    conferenceId: string,
    addressId: string,
  ): Promise<AgentBusConferenceMember> {
    const member = await this.requireMemberLocked(db, conferenceId, addressId);
    if (member.role !== 'owner') {
      throw new ForbiddenError('Only the conference owner can do that', 'agent_messaging_conference_not_owner');
    }
    return member;
  }

  private assertConferenceOpen(conference: AgentBusConference, now: string): void {
    if (conference.status !== 'open') {
      throw new ConflictError('Conference is adjourned', 'agent_messaging_conference_adjourned');
    }
    if (conference.deadlineAt <= now) {
      throw new ConflictError('Conference deadline has passed', 'agent_messaging_conference_expired');
    }
  }

  /**
   * Which half of the delivery split a member sits on.
   *
   * `claimDelivery` already arbitrates this per message: a target with a live
   * wrapper attached is skipped by the relay and must claim for itself, while an
   * idle one is booted headless. The roster only records which side a member is
   * currently on, because the chair has to phrase a dispatch differently for a
   * listener than for a one-shot run. It is recomputed on every send rather than
   * stored at join, since a member that quits its terminal changes side.
   */
  private conferenceMode(address: AgentBusAddress): string {
    return address.currentSessionId ? 'attached' : 'headless';
  }

  private async rosterRowsLocked(db: AgentMessagingDb, conferenceId: string) {
    return await db
      .select({ member: agentBusConferenceMembers, address: agentBusAddresses, fqdn: hosts.fqdn })
      .from(agentBusConferenceMembers)
      .innerJoin(agentBusAddresses, eq(agentBusAddresses.id, agentBusConferenceMembers.addressId))
      .innerJoin(hosts, eq(hosts.id, agentBusAddresses.hostId))
      .where(and(eq(agentBusConferenceMembers.conferenceId, conferenceId), ne(agentBusConferenceMembers.state, 'left')))
      .orderBy(asc(agentBusConferenceMembers.joinedAt));
  }

  /**
   * Queue one message along a member's spoke.
   *
   * The header line is composed here rather than left to the caller because a
   * relay-woken member has no prior context at all: its whole existence is the
   * prompt it is booted with, so the conference id has to travel inside the
   * message or it can never call `agent_conf_join` to answer. Composing it
   * server-side also means a peer that has never read the skill still receives a
   * parseable envelope.
   */
  private async queueConferenceMessageLocked(
    tx: AgentMessagingDb,
    input: {
      conference: AgentBusConference;
      member: AgentBusConferenceMember;
      sender: AgentBusAddress;
      target: AgentBusAddress;
      senderSessionId: string | null;
      verb: string;
      headers: Record<string, string | number | null | undefined>;
      body: string;
      now: string;
    },
  ): Promise<AgentBusMessage> {
    const { conference, member, sender, target, now } = input;
    if (member.messageCount >= AGENT_MESSAGING_CONFERENCE_MEMBER_MESSAGE_CAP) {
      throw new ConflictError(
        `Conference budget spent for this member (${AGENT_MESSAGING_CONFERENCE_MEMBER_MESSAGE_CAP} messages)`,
        'agent_messaging_conference_budget_spent',
      );
    }
    let conversationId = member.conversationId;
    if (!conversationId) {
      conversationId = randomUUID();
      await tx.insert(agentBusConversations).values({
        id: conversationId,
        addressAId: conference.ownerAddressId,
        addressBId: member.addressId,
        createdByAddressId: sender.id,
        nextSequence: 1,
        status: 'open',
        lastActivityAt: now,
        canceledBy: null,
        cancelReason: null,
        canceledAt: null,
        createdAt: now,
        updatedAt: now,
      });
      await tx
        .update(agentBusConferenceMembers)
        .set({ conversationId, updatedAt: now })
        .where(eq(agentBusConferenceMembers.id, member.id));
    }
    const conversation = await this.requireConversationLocked(tx, conversationId);
    if (conversation.status !== 'open') {
      throw new ConflictError('Conversation is canceled', 'agent_messaging_conversation_canceled');
    }
    this.assertConversationParticipants(conversation, sender.id, target.id);
    const content = conferenceEnvelope(input.verb, { conference: conference.id, ...input.headers }, input.body);
    const sequence = Number(conversation.nextSequence);
    const messageId = randomUUID();
    await tx.insert(agentBusMessages).values(
      newQueuedMessage({
        id: messageId,
        conversationId,
        sequence,
        sender,
        senderSessionId: input.senderSessionId,
        target,
        kind: 'message',
        content,
        contentEnc: encrypt(content, this.keyring),
        // Server-generated: a conference send is a fan-out, so there is no single
        // client key that could identify it. Partial delivery is reported per
        // member instead, and re-sending to a member that already received one is
        // a second message by design rather than a swallowed duplicate.
        clientMessageId: randomUUID(),
        // A message must not outlive the room it belongs to.
        expiresAt: conferenceMessageExpiry(conference, now),
        now,
      }),
    );
    const persistedRows = await tx.select().from(agentBusMessages).where(eq(agentBusMessages.id, messageId)).limit(1);
    const persisted = persistedRows[0];
    if (!persisted) throw new Error('Inserted conference message could not be read back');
    await tx
      .update(agentBusConversations)
      .set({ nextSequence: sequence + 1, lastActivityAt: now, updatedAt: now })
      .where(eq(agentBusConversations.id, conversationId));
    const participant = sender.id === conference.ownerAddressId ? target : sender;
    const spent = member.messageCount + 1;
    await tx
      .update(agentBusConferenceMembers)
      .set({ messageCount: spent, mode: this.conferenceMode(participant), updatedAt: now })
      .where(eq(agentBusConferenceMembers.id, member.id));
    // The send path closes on the same boundary as the reply path. Incrementing
    // here without checking let a send land exactly on the cap and leave the
    // spoke open for one more reply, so a room advertised as twelve messages
    // stopped at thirteen -- observed on a live run.
    await this.closeSpokeIfSpentLocked(tx, member.id, conversationId, spent, now);
    return persisted;
  }

  /**
   * A dispatched member reports back by replying to the task it was given.
   *
   * Called from both reply paths, because the two member kinds report through
   * different ones: an attached member replies through `replyMessage`, while a
   * headless member never calls a tool at all -- the relay correlates its final
   * output and posts it through `replyFromRelayDelivery`. Hooking only the tool
   * path would leave every headless member stuck in `dispatched` forever.
   */
  private async settleConferenceDispatchLocked(tx: AgentMessagingDb, parentMessageId: string, now: string): Promise<void> {
    const rows = await tx
      .select()
      .from(agentBusConferenceMembers)
      .where(and(eq(agentBusConferenceMembers.dispatchMessageId, parentMessageId), eq(agentBusConferenceMembers.state, 'dispatched')))
      .limit(1)
      .for('update');
    const member = rows[0];
    if (!member) return;
    await tx
      .update(agentBusConferenceMembers)
      .set({ state: 'seated', dispatchMessageId: null, dispatchDeadlineAt: null, lastReportAt: now, updatedAt: now })
      .where(eq(agentBusConferenceMembers.id, member.id));
  }

  /**
   * Charge a reply against the room's budget, and close the spoke when it runs out.
   *
   * The budget used to be charged only by `queueConferenceMessageLocked`, i.e. the
   * `agent_conf_*` tools. But once a room is running, the traffic is ordinary
   * `agent_reply` -- that is how a participant answers anything -- and replies
   * never reached the counter. Measured on a live two-host run: the member row
   * read 2 while 21 messages had flown, and nothing server-side was going to end
   * it before the wall-clock deadline. On the headless path every one of those
   * exchanges is a fresh engine boot, so "bounded only by an hour" is not a bound
   * worth having. This is the same runaway the `call` skill's own rationale
   * warns about, reappearing through the one path that was not counted.
   *
   * Spending the budget closes the member's conversation rather than refusing the
   * reply. Refusing would strand the peer holding an unanswerable message, and on
   * the relay path a throw here becomes an `ambiguous` delivery -- the exact
   * silent failure mode this bus has been fixing all week. Closing lets the last
   * word land and makes the *next* exchange fail as `agent_messaging_conversation_canceled`,
   * which both skills already define as "the room closed under you: report and stop".
   */
  private async chargeConferenceBudgetLocked(
    db: AgentMessagingDb,
    conversationId: string,
    now: string,
  ): Promise<void> {
    const rows = await db
      .select()
      .from(agentBusConferenceMembers)
      .where(and(eq(agentBusConferenceMembers.conversationId, conversationId), ne(agentBusConferenceMembers.state, 'left')))
      .limit(1)
      .for('update');
    const member = rows[0];
    if (!member) return; // Not a conference spoke; an ordinary conversation is unbudgeted.

    const spent = member.messageCount + 1;
    await db
      .update(agentBusConferenceMembers)
      .set({ messageCount: spent, updatedAt: now })
      .where(eq(agentBusConferenceMembers.id, member.id));
    await this.closeSpokeIfSpentLocked(db, member.id, conversationId, spent, now);
  }

  /**
   * Retire a member's spoke once its budget is gone.
   *
   * Shared by both the send and reply paths so the room stops on the number it
   * advertises: whichever path spends the last message is the one that closes.
   */
  private async closeSpokeIfSpentLocked(
    db: AgentMessagingDb,
    memberId: string,
    conversationId: string,
    spent: number,
    now: string,
  ): Promise<void> {
    if (spent < AGENT_MESSAGING_CONFERENCE_MEMBER_MESSAGE_CAP) return;
    await db
      .update(agentBusConferenceMembers)
      .set({ state: 'left', leftAt: now, dispatchMessageId: null, dispatchDeadlineAt: null, updatedAt: now })
      .where(eq(agentBusConferenceMembers.id, memberId));
    await db
      .update(agentBusConversations)
      .set({
        status: 'canceled',
        canceledBy: 'system:conference_budget_spent',
        cancelReason: `Conference budget spent (${AGENT_MESSAGING_CONFERENCE_MEMBER_MESSAGE_CAP} messages)`,
        canceledAt: now,
        updatedAt: now,
      })
      .where(eq(agentBusConversations.id, conversationId));
  }

  /**
   * Open a conference and mint the room PIN.
   *
   * One open conference per owner. A second would give the chair two rooms to
   * keep straight and two budgets to spend, and every mechanism here -- the
   * roster, the floor, the adjourn authority -- assumes the chair is running one
   * meeting. Re-opening returns the existing room rather than minting a rival.
   */
  async openConference(
    sessionId: string,
    bridgeToken: string,
    input: { topic?: string | null; purpose?: string | null; ttlSeconds?: number | null; maxMembers?: number | null } = {},
  ): Promise<Record<string, unknown>> {
    const authenticated = await this.authenticateBridge(sessionId, bridgeToken);
    if (!authenticated.session.agentBusAddressId) {
      throw new ConflictError('Agent session has no messaging address', 'agent_messaging_address_missing');
    }
    const topic = normalizeOptionalText(input.topic, 255);
    const purpose = normalizeOptionalText(input.purpose, 1024);
    const ttlSeconds = normalizeConferenceTtl(input.ttlSeconds);
    const maxMembers = normalizeConferenceMaxMembers(input.maxMembers);
    const result = await this.db.transaction(async (tx) => {
      await this.requireEnabledLocked(tx);
      const now = nowIso();
      await this.sweepCallPinsLocked(tx, now);
      const self = await this.requireAddressLocked(tx, authenticated.session.agentBusAddressId!);
      await this.assertSessionAddressLocked(tx, authenticated.session.id, self);
      await this.assertAddressEligibleLocked(tx, self);
      const openRows = await tx
        .select()
        .from(agentBusConferences)
        .where(and(eq(agentBusConferences.ownerAddressId, self.id), eq(agentBusConferences.status, 'open'), gt(agentBusConferences.deadlineAt, now)))
        .limit(1)
        .for('update');
      const existing = openRows[0];
      if (existing) {
        const pin =
          existing.pin && existing.pinExpiresAt && existing.pinExpiresAt > now
            ? existing.pin
            : await this.mintConferencePinLocked(tx, existing.id, existing.deadlineAt, now);
        return { conference: { ...existing, pin }, self, reused: true };
      }
      const conference: typeof agentBusConferences.$inferInsert = {
        id: randomUUID(),
        ownerAddressId: self.id,
        topic,
        purpose,
        pin: null,
        pinExpiresAt: null,
        status: 'open',
        maxMembers,
        deadlineAt: isoOffsetSeconds(ttlSeconds),
        adjournReason: null,
        adjournedAt: null,
        createdAt: now,
        updatedAt: now,
      };
      await tx.insert(agentBusConferences).values(conference);
      await tx.insert(agentBusConferenceMembers).values({
        id: randomUUID(),
        conferenceId: conference.id,
        addressId: self.id,
        conversationId: null,
        role: 'owner',
        purpose,
        mode: this.conferenceMode(self),
        state: 'seated',
        dispatchMessageId: null,
        dispatchDeadlineAt: null,
        dispatchedAt: null,
        lastReportAt: null,
        messageCount: 0,
        joinedAt: now,
        leftAt: null,
        createdAt: now,
        updatedAt: now,
      });
      // The PIN dies with the room, so its window is the room's deadline.
      const pin = await this.mintConferencePinLocked(tx, conference.id, conference.deadlineAt, now);
      return { conference: { ...conference, pin } as AgentBusConference, self, reused: false };
    });
    const roster = await this.db.transaction(async (tx) => await this.rosterRowsLocked(tx, result.conference.id));
    return {
      enabled: true,
      conference_id: result.conference.id,
      pin: result.conference.pin,
      expires_at: result.conference.deadlineAt,
      deadline_at: result.conference.deadlineAt,
      topic: result.conference.topic,
      max_members: result.conference.maxMembers,
      reused: result.reused,
      self: publicAddress(result.self),
      roster: roster.map((row) => publicConferenceMember(row.member, row.address, row.fqdn)),
    };
  }

  /**
   * Invite addresses into the room.
   *
   * This is the path that makes a conference usable on a cluster: an idle host
   * is woken by its relay with the invite as its prompt, so no human carries
   * anything. A host with a wrapper already attached is skipped by the relay by
   * design and its invite simply waits in the queue until that session listens
   * -- which is exactly the case the PIN still exists to cover.
   *
   * Not atomic, and deliberately not pretending to be: each member is its own
   * conversation and its own delivery, so the result is per member and a partial
   * fan-out is reported rather than rolled back.
   */
  async inviteToConference(
    sessionId: string,
    bridgeToken: string,
    input: { conferenceId: string; to: string[]; note?: string | null },
  ): Promise<Record<string, unknown>> {
    const authenticated = await this.authenticateBridge(sessionId, bridgeToken);
    const selfId = authenticated.session.agentBusAddressId;
    if (!selfId) throw new ConflictError('Agent session has no messaging address', 'agent_messaging_address_missing');
    const conferenceId = normalizeUuid(input.conferenceId, 'conference_id');
    const note = normalizeOptionalText(input.note, AGENT_MESSAGING_MAX_BODY_BYTES) ?? '';
    if (!Array.isArray(input.to) || input.to.length === 0) {
      throw new ValidationError('to must be a non-empty list of addresses', { param: 'to' });
    }
    const targets = input.to.map((value) => normalizeRequiredText(value, 'to', 96));
    const results: Record<string, unknown>[] = [];
    for (const target of targets) {
      try {
        const queued = await this.db.transaction(async (tx) => {
          await this.requireEnabledLocked(tx);
          const now = nowIso();
          const conference = await this.requireConferenceLocked(tx, conferenceId);
          this.assertConferenceOpen(conference, now);
          await this.requireChairLocked(tx, conferenceId, selfId);
          const chair = await this.requireAddressLocked(tx, selfId);
          await this.assertSessionAddressLocked(tx, authenticated.session.id, chair);
          const invitee = await this.resolveAddressLocked(tx, target, true);
          if (invitee.id === chair.id) {
            throw new ValidationError('The chair is already in the conference', { param: 'to' });
          }
          await this.assertAddressEligibleLocked(tx, invitee);
          const seated = await tx
            .select({ value: count() })
            .from(agentBusConferenceMembers)
            .where(and(eq(agentBusConferenceMembers.conferenceId, conferenceId), ne(agentBusConferenceMembers.state, 'left')));
          if (Number(seated[0]?.value ?? 0) >= conference.maxMembers) {
            throw new ConflictError('Conference is full', 'agent_messaging_conference_full');
          }
          const priorRows = await tx
            .select()
            .from(agentBusConferenceMembers)
            .where(and(eq(agentBusConferenceMembers.conferenceId, conferenceId), eq(agentBusConferenceMembers.addressId, invitee.id)))
            .limit(1)
            .for('update');
          if (priorRows[0] && priorRows[0].state !== 'left') {
            throw new ConflictError('Address is already a member', 'agent_messaging_conference_already_member');
          }
          const member: typeof agentBusConferenceMembers.$inferInsert = {
            id: priorRows[0]?.id ?? randomUUID(),
            conferenceId,
            addressId: invitee.id,
            conversationId: priorRows[0]?.conversationId ?? null,
            role: 'participant',
            purpose: null,
            mode: this.conferenceMode(invitee),
            state: 'seated',
            dispatchMessageId: null,
            dispatchDeadlineAt: null,
            dispatchedAt: null,
            lastReportAt: null,
            messageCount: priorRows[0]?.messageCount ?? 0,
            joinedAt: now,
            leftAt: null,
            createdAt: priorRows[0]?.createdAt ?? now,
            updatedAt: now,
          };
          if (priorRows[0]) {
            await tx.update(agentBusConferenceMembers).set(member).where(eq(agentBusConferenceMembers.id, member.id!));
          } else {
            await tx.insert(agentBusConferenceMembers).values(member);
          }
          const stored = await this.requireMemberLocked(tx, conferenceId, invitee.id);
          const message = await this.queueConferenceMessageLocked(tx, {
            conference,
            member: stored,
            sender: chair,
            target: invitee,
            senderSessionId: authenticated.session.id,
            verb: 'INVITE',
            headers: {
              topic: conference.topic ?? undefined,
              deadline: conference.deadlineAt,
              members: `${Number(seated[0]?.value ?? 0) + 1}/${conference.maxMembers}`,
            },
            body: conferenceInviteBody(conference, note),
            now,
          });
          return { message, invitee, mode: stored.mode };
        });
        wsPublisher.publish('agent_messaging.message.changed', {
          message_id: queued.message.id,
          conversation_id: queued.message.conversationId,
          status: queued.message.status,
        });
        results.push({
          address: queued.invitee.address,
          alias: queued.invitee.displayAlias,
          mode: this.conferenceMode(queued.invitee),
          delivered: true,
          message_id: queued.message.id,
        });
      } catch (error) {
        results.push({ address: target, delivered: false, error: errorCodeOf(error), detail: errorMessageOf(error) });
      }
    }
    return { enabled: true, conference_id: conferenceId, results };
  }

  /**
   * Join a room, by PIN or by invitation.
   *
   * The PIN path is multi-use, which is the whole difference from `#call`: four
   * agents dial the same four digits, so unlike `consumeCallPinLocked` this must
   * never clear the PIN on success. It dies with the room's deadline or when the
   * room fills, not on first use.
   *
   * The `conference_id` path exists for a relay-woken invitee, which learns the
   * id from the invite it was booted with. It requires an existing member row,
   * so knowing a UUID is not by itself an entry ticket.
   */
  async joinConference(
    sessionId: string,
    bridgeToken: string,
    input: { pin?: string | null; conferenceId?: string | null; purpose?: string | null; content?: string | null },
  ): Promise<Record<string, unknown>> {
    const authenticated = await this.authenticateBridge(sessionId, bridgeToken);
    const selfId = authenticated.session.agentBusAddressId;
    if (!selfId) throw new ConflictError('Agent session has no messaging address', 'agent_messaging_address_missing');
    const hasPin = input.pin !== undefined && input.pin !== null && input.pin !== '';
    const hasId = input.conferenceId !== undefined && input.conferenceId !== null && input.conferenceId !== '';
    if (hasPin === hasId) {
      throw new ValidationError('Provide exactly one of pin or conference_id', { param: 'pin' });
    }
    const pin = hasPin ? normalizeCallPin(input.pin) : null;
    const conferenceId = hasId ? normalizeUuid(input.conferenceId, 'conference_id') : null;
    const purpose = normalizeOptionalText(input.purpose, 1024);
    const body = normalizeOptionalText(input.content, AGENT_MESSAGING_MAX_BODY_BYTES) ?? '';
    const result = await this.db.transaction(async (tx) => {
      await this.requireEnabledLocked(tx);
      const now = nowIso();
      await this.sweepCallPinsLocked(tx, now);
      const self = await this.requireAddressLocked(tx, selfId);
      await this.assertSessionAddressLocked(tx, authenticated.session.id, self);
      const conference = pin
        ? await this.resolveConferencePinLocked(tx, pin, now)
        : await this.requireConferenceLocked(tx, conferenceId!);
      this.assertConferenceOpen(conference, now);
      if (conference.ownerAddressId === self.id) {
        throw new ValidationError('The chair is already in the conference', { param: 'pin' });
      }
      const chair = await this.requireAddressLocked(tx, conference.ownerAddressId);
      await this.assertAddressEligibleLocked(tx, chair);
      const priorRows = await tx
        .select()
        .from(agentBusConferenceMembers)
        .where(and(eq(agentBusConferenceMembers.conferenceId, conference.id), eq(agentBusConferenceMembers.addressId, self.id)))
        .limit(1)
        .for('update');
      const prior = priorRows[0];
      if (!prior && !pin) {
        // An id alone is not an invitation.
        throw new ForbiddenError('Not a member of this conference', 'agent_messaging_conference_not_member');
      }
      if (!prior) {
        const seated = await tx
          .select({ value: count() })
          .from(agentBusConferenceMembers)
          .where(and(eq(agentBusConferenceMembers.conferenceId, conference.id), ne(agentBusConferenceMembers.state, 'left')));
        if (Number(seated[0]?.value ?? 0) >= conference.maxMembers) {
          throw new ConflictError('Conference is full', 'agent_messaging_conference_full');
        }
        await tx.insert(agentBusConferenceMembers).values({
          id: randomUUID(),
          conferenceId: conference.id,
          addressId: self.id,
          conversationId: null,
          role: 'participant',
          purpose,
          mode: this.conferenceMode(self),
          state: 'seated',
          dispatchMessageId: null,
          dispatchDeadlineAt: null,
          dispatchedAt: null,
          lastReportAt: null,
          messageCount: 0,
          joinedAt: now,
          leftAt: null,
          createdAt: now,
          updatedAt: now,
        });
      } else {
        await tx
          .update(agentBusConferenceMembers)
          .set({ state: 'seated', purpose: purpose ?? prior.purpose, mode: this.conferenceMode(self), leftAt: null, updatedAt: now })
          .where(eq(agentBusConferenceMembers.id, prior.id));
      }
      const member = await this.requireMemberLocked(tx, conference.id, self.id);
      const message = await this.queueConferenceMessageLocked(tx, {
        conference,
        member,
        sender: self,
        target: chair,
        senderSessionId: authenticated.session.id,
        verb: 'HELLO',
        headers: { purpose: purpose ?? undefined },
        body,
        now,
      });
      const roster = await this.rosterRowsLocked(tx, conference.id);
      return { conference, self, chair, message, roster };
    });
    wsPublisher.publish('agent_messaging.message.changed', {
      message_id: result.message.id,
      conversation_id: result.message.conversationId,
      status: result.message.status,
    });
    return {
      enabled: true,
      conference_id: result.conference.id,
      topic: result.conference.topic,
      deadline_at: result.conference.deadlineAt,
      chair: publicAddress(result.chair),
      self: publicAddress(result.self),
      roster: result.roster.map((row) => publicConferenceMember(row.member, row.address, row.fqdn)),
    };
  }

  /**
   * Resolve a room PIN without spending it.
   *
   * The contrast with `consumeCallPinLocked` is the point: a call PIN is
   * single-use because it names one rendezvous between two agents, while a room
   * PIN is how every member finds the same room. Clearing it on first join would
   * admit exactly one participant and turn a conference into a call.
   */
  private async resolveConferencePinLocked(db: AgentMessagingDb, pin: string, now: string): Promise<AgentBusConference> {
    const rows = await db
      .select()
      .from(agentBusConferences)
      .where(and(eq(agentBusConferences.pin, pin), gt(agentBusConferences.pinExpiresAt, now)))
      .limit(1)
      .for('update');
    const conference = rows[0];
    if (!conference) {
      throw new NotFoundError('Conference PIN not found or expired', 'agent_messaging_conference_pin_not_found');
    }
    return conference;
  }

  async conferenceRoster(sessionId: string, bridgeToken: string, conferenceId: string): Promise<Record<string, unknown>> {
    const authenticated = await this.authenticateBridge(sessionId, bridgeToken);
    const selfId = authenticated.session.agentBusAddressId;
    if (!selfId) throw new ConflictError('Agent session has no messaging address', 'agent_messaging_address_missing');
    const id = normalizeUuid(conferenceId, 'conference_id');
    return await this.db.transaction(async (tx) => {
      await this.requireEnabledLocked(tx);
      const conference = await this.requireConferenceLocked(tx, id);
      await this.requireMemberLocked(tx, id, selfId);
      const roster = await this.rosterRowsLocked(tx, id);
      return {
        enabled: true,
        conference_id: conference.id,
        topic: conference.topic,
        purpose: conference.purpose,
        status: conference.status,
        deadline_at: conference.deadlineAt,
        max_members: conference.maxMembers,
        members: roster.map((row) => publicConferenceMember(row.member, row.address, row.fqdn)),
      };
    });
  }

  /**
   * Say something. The chair broadcasts; a participant may only address the chair.
   *
   * A participant's `to` is ignored rather than rejected: the star has no edge
   * between participants, so there is nowhere for it to go, and failing the call
   * would punish an agent for a topology it cannot see.
   */
  async conferenceSay(
    sessionId: string,
    bridgeToken: string,
    input: { conferenceId: string; content: string; to?: string | null },
  ): Promise<Record<string, unknown>> {
    const authenticated = await this.authenticateBridge(sessionId, bridgeToken);
    const selfId = authenticated.session.agentBusAddressId;
    if (!selfId) throw new ConflictError('Agent session has no messaging address', 'agent_messaging_address_missing');
    const conferenceId = normalizeUuid(input.conferenceId, 'conference_id');
    const body = normalizeMessageBody(input.content);
    const to = normalizeOptionalText(input.to, 96);
    const recipients = await this.db.transaction(async (tx) => {
      await this.requireEnabledLocked(tx);
      const now = nowIso();
      const conference = await this.requireConferenceLocked(tx, conferenceId);
      this.assertConferenceOpen(conference, now);
      const me = await this.requireMemberLocked(tx, conferenceId, selfId);
      if (me.role !== 'owner') return { chairOnly: true, conference };
      const roster = await this.rosterRowsLocked(tx, conferenceId);
      const targets = roster
        .filter((row) => row.member.role !== 'owner')
        // A dispatched member is away on a task and holding a delivery; adding a
        // broadcast behind it would queue behind work it has not finished.
        .filter((row) => row.member.state === 'seated')
        .filter((row) => !to || row.address.address === to || row.address.displayAlias === to);
      return { chairOnly: false, conference, targets: targets.map((row) => row.address.id) };
    });
    const results: Record<string, unknown>[] = [];
    if (recipients.chairOnly) {
      const sent = await this.deliverConferenceMessage(authenticated, conferenceId, selfId, null, 'SAY', {}, body);
      results.push(sent);
    } else {
      for (const addressId of recipients.targets ?? []) {
        results.push(await this.deliverConferenceMessage(authenticated, conferenceId, selfId, addressId, 'SAY', {}, body));
      }
    }
    return { enabled: true, conference_id: conferenceId, results };
  }

  /**
   * Hand a task to one participant and take it off the floor.
   *
   * The member goes to `dispatched`, which excludes it from broadcast until its
   * report lands. `dispatch_deadline_at` is what the maintenance sweep uses to
   * notice a member whose run died: a headless task that never returns burns its
   * delivery attempts silently, and without the deadline the chair would wait
   * forever on a report that is not coming.
   */
  async conferenceDispatch(
    sessionId: string,
    bridgeToken: string,
    input: { conferenceId: string; to: string; task: string; etaSeconds?: number | null },
  ): Promise<Record<string, unknown>> {
    const authenticated = await this.authenticateBridge(sessionId, bridgeToken);
    const selfId = authenticated.session.agentBusAddressId;
    if (!selfId) throw new ConflictError('Agent session has no messaging address', 'agent_messaging_address_missing');
    const conferenceId = normalizeUuid(input.conferenceId, 'conference_id');
    const to = normalizeRequiredText(input.to, 'to', 96);
    const task = normalizeMessageBody(input.task);
    const etaSeconds = normalizeDispatchEta(input.etaSeconds);
    const result = await this.db.transaction(async (tx) => {
      await this.requireEnabledLocked(tx);
      const now = nowIso();
      const conference = await this.requireConferenceLocked(tx, conferenceId);
      this.assertConferenceOpen(conference, now);
      await this.requireChairLocked(tx, conferenceId, selfId);
      const chair = await this.requireAddressLocked(tx, selfId);
      await this.assertSessionAddressLocked(tx, authenticated.session.id, chair);
      const target = await this.resolveAddressLocked(tx, to, true);
      await this.assertAddressEligibleLocked(tx, target);
      const member = await this.requireMemberLocked(tx, conferenceId, target.id);
      if (member.role === 'owner') {
        throw new ValidationError('The chair cannot dispatch itself', { param: 'to' });
      }
      if (member.state === 'dispatched') {
        throw new ConflictError('Member is already on a task', 'agent_messaging_conference_member_busy');
      }
      const message = await this.queueConferenceMessageLocked(tx, {
        conference,
        member,
        sender: chair,
        target,
        senderSessionId: authenticated.session.id,
        verb: 'TASK',
        headers: { eta: etaSeconds, deadline: conference.deadlineAt },
        body: task,
        now,
      });
      await tx
        .update(agentBusConferenceMembers)
        .set({
          state: 'dispatched',
          dispatchMessageId: message.id,
          dispatchDeadlineAt: isoOffsetSeconds(etaSeconds),
          dispatchedAt: now,
          updatedAt: now,
        })
        .where(eq(agentBusConferenceMembers.id, member.id));
      return { message, target };
    });
    wsPublisher.publish('agent_messaging.message.changed', {
      message_id: result.message.id,
      conversation_id: result.message.conversationId,
      status: result.message.status,
    });
    return {
      enabled: true,
      conference_id: conferenceId,
      dispatched_to: publicAddress(result.target),
      message_id: result.message.id,
      eta_seconds: etaSeconds,
    };
  }

  /**
   * Close the room.
   *
   * Graceful by default. Cancelling a conversation revokes any lease on it, and
   * a headless member mid-run is having its lease renewed on a ticker -- so a
   * blanket cancel kills a running engine process mid-task. That is sometimes
   * what the chair wants and never what it should get by accident, so the
   * default leaves dispatched members to finish and the room lands in
   * `adjourning` until their reports arrive or the sweep expires them. `force`
   * is the decisive form, and it reports how much work it interrupted.
   */
  async adjournConference(
    sessionId: string,
    bridgeToken: string,
    input: { conferenceId: string; reason?: string | null; force?: boolean },
  ): Promise<Record<string, unknown>> {
    const authenticated = await this.authenticateBridge(sessionId, bridgeToken);
    const selfId = authenticated.session.agentBusAddressId;
    if (!selfId) throw new ConflictError('Agent session has no messaging address', 'agent_messaging_address_missing');
    const conferenceId = normalizeUuid(input.conferenceId, 'conference_id');
    const reason = normalizeOptionalText(input.reason, 255) ?? 'Adjourned by the chair';
    const force = input.force === true;
    const plan = await this.db.transaction(async (tx) => {
      await this.requireEnabledLocked(tx);
      const now = nowIso();
      const conference = await this.requireConferenceLocked(tx, conferenceId);
      if (conference.status === 'adjourned') {
        throw new ConflictError('Conference is already adjourned', 'agent_messaging_conference_adjourned');
      }
      await this.requireChairLocked(tx, conferenceId, selfId);
      const roster = await this.rosterRowsLocked(tx, conferenceId);
      const participants = roster.filter((row) => row.member.role !== 'owner');
      const working = participants.filter((row) => row.member.state === 'dispatched');
      const releasable = force ? participants : participants.filter((row) => row.member.state !== 'dispatched');
      const settled = force || working.length === 0;
      await tx
        .update(agentBusConferences)
        .set({
          status: settled ? 'adjourned' : 'adjourning',
          adjournReason: reason,
          adjournedAt: settled ? now : null,
          pin: null,
          pinExpiresAt: null,
          updatedAt: now,
        })
        .where(eq(agentBusConferences.id, conferenceId));
      for (const row of releasable) {
        await tx
          .update(agentBusConferenceMembers)
          .set({ state: 'left', leftAt: now, dispatchMessageId: null, dispatchDeadlineAt: null, updatedAt: now })
          .where(eq(agentBusConferenceMembers.id, row.member.id));
      }
      if (settled) {
        await tx
          .update(agentBusConferenceMembers)
          .set({ state: 'left', leftAt: now, updatedAt: now })
          .where(and(eq(agentBusConferenceMembers.conferenceId, conferenceId), ne(agentBusConferenceMembers.state, 'left')));
      }
      return {
        settled,
        interrupted: force ? working.length : 0,
        waitingOn: settled ? 0 : working.length,
        conversations: releasable.map((row) => row.member.conversationId).filter((id): id is string => Boolean(id)),
      };
    });
    for (const conversationId of plan.conversations) {
      try {
        await this.cancelConversationInternal(conversationId, `agent:${selfId}`, reason, selfId, authenticated.session.id);
      } catch {
        // A conversation already canceled or never opened is not a failure to
        // adjourn: the room is closing either way.
      }
    }
    wsPublisher.publish('agent_messaging.conference.changed', {
      conference_id: conferenceId,
      status: plan.settled ? 'adjourned' : 'adjourning',
    });
    return {
      enabled: true,
      conference_id: conferenceId,
      status: plan.settled ? 'adjourned' : 'adjourning',
      released: plan.conversations.length,
      interrupted_tasks: plan.interrupted,
      waiting_on_tasks: plan.waitingOn,
    };
  }

  /** One spoke of a fan-out, isolated so a single failure is reported rather than fatal. */
  private async deliverConferenceMessage(
    authenticated: { session: AgentSession; host: Host },
    conferenceId: string,
    selfId: string,
    targetAddressId: string | null,
    verb: string,
    headers: Record<string, string | number | null | undefined>,
    body: string,
  ): Promise<Record<string, unknown>> {
    try {
      const queued = await this.db.transaction(async (tx) => {
        await this.requireEnabledLocked(tx);
        const now = nowIso();
        const conference = await this.requireConferenceLocked(tx, conferenceId);
        this.assertConferenceOpen(conference, now);
        const self = await this.requireAddressLocked(tx, selfId);
        await this.assertSessionAddressLocked(tx, authenticated.session.id, self);
        const isChair = conference.ownerAddressId === self.id;
        const otherId = isChair ? targetAddressId! : conference.ownerAddressId;
        const other = await this.requireAddressLocked(tx, otherId);
        await this.assertAddressEligibleLocked(tx, other);
        const member = await this.requireMemberLocked(tx, conferenceId, isChair ? other.id : self.id);
        const message = await this.queueConferenceMessageLocked(tx, {
          conference,
          member,
          sender: self,
          target: other,
          senderSessionId: authenticated.session.id,
          verb,
          headers,
          body,
          now,
        });
        return { message, other };
      });
      wsPublisher.publish('agent_messaging.message.changed', {
        message_id: queued.message.id,
        conversation_id: queued.message.conversationId,
        status: queued.message.status,
      });
      return {
        address: queued.other.address,
        alias: queued.other.displayAlias,
        delivered: true,
        message_id: queued.message.id,
      };
    } catch (error) {
      return { address: targetAddressId, delivered: false, error: errorCodeOf(error), detail: errorMessageOf(error) };
    }
  }

  async sendMessage(
    sessionId: string,
    bridgeToken: string,
    input: {
      to: string;
      content: string;
      clientMessageId: string;
      conversationId?: string | null;
      ttlSeconds?: number | null;
      kind?: 'message' | 'request';
    },
  ): Promise<Record<string, unknown>> {
    const authenticated = await this.authenticateBridge(sessionId, bridgeToken);
    if (!authenticated.session.agentBusAddressId) {
      throw new ConflictError('Agent session has no messaging address', 'agent_messaging_address_missing');
    }
    const content = normalizeMessageBody(input.content);
    const clientMessageId = normalizeUuid(input.clientMessageId, 'client_message_id');
    const ttlSeconds = normalizeMessageTtl(input.ttlSeconds);
    const result = await this.db.transaction(async (tx) => {
      await this.requireEnabledLocked(tx);
      const sender = await this.requireAddressLocked(tx, authenticated.session.agentBusAddressId!);
      await this.assertSessionAddressLocked(tx, authenticated.session.id, sender);
      const target = await this.resolveAddressLocked(tx, input.to, true);
      await this.assertAddressEligibleLocked(tx, target);
      if (sender.id === target.id) {
        throw new ValidationError('An agent cannot message itself', { param: 'to' });
      }
      const existingRows = await tx
        .select()
        .from(agentBusMessages)
        .where(and(eq(agentBusMessages.senderAddressId, sender.id), eq(agentBusMessages.clientMessageId, clientMessageId)))
        .limit(1)
        .for('update');
      const existing = existingRows[0];
      if (existing) {
        this.assertMessageIdempotency(existing, target.id, input.conversationId ?? null, null, content, input.kind ?? 'message');
        return { message: existing, sender, target, content, created: false };
      }

      const now = nowIso();
      let conversation: AgentBusConversation;
      if (input.conversationId) {
        conversation = await this.requireConversationLocked(tx, normalizeUuid(input.conversationId, 'conversation_id'));
        this.assertConversationParticipants(conversation, sender.id, target.id);
        if (conversation.status !== 'open') throw new ConflictError('Conversation is canceled', 'agent_messaging_conversation_canceled');
      } else {
        conversation = {
          id: randomUUID(),
          addressAId: sender.id,
          addressBId: target.id,
          createdByAddressId: sender.id,
          nextSequence: 1,
          status: 'open',
          lastActivityAt: now,
          canceledBy: null,
          cancelReason: null,
          canceledAt: null,
          createdAt: now,
          updatedAt: now,
        };
        await tx.insert(agentBusConversations).values(conversation);
      }
      const sequence = Number(conversation.nextSequence);
      const messageId = randomUUID();
      const message: typeof agentBusMessages.$inferInsert = {
        id: messageId,
        conversationId: conversation.id,
        sequence,
        replyToMessageId: null,
        redriveOfMessageId: null,
        senderAddressId: sender.id,
        senderSessionId: authenticated.session.id,
        targetAddressId: target.id,
        sourceEngine: sender.engine,
        targetEngine: target.engine,
        kind: input.kind ?? 'message',
        contentEnc: encrypt(content, this.keyring),
        contentBytes: Buffer.byteLength(content, 'utf8'),
        clientMessageId,
        status: 'queued',
        attempts: 0,
        nextAttemptAt: now,
        leaseOwner: null,
        leaseUntil: null,
        claimId: null,
        relayGeneration: null,
        targetBindingGeneration: null,
        deliverySessionId: null,
        deliveryUpstreamSessionId: null,
        expiresAt: isoOffsetSeconds(ttlSeconds),
        lastErrorCode: null,
        lastErrorEnc: null,
        cancelRequestedAt: null,
        acceptedAt: null,
        completedAt: null,
        ambiguousAt: null,
        deadAt: null,
        expiredAt: null,
        canceledAt: null,
        createdAt: now,
        updatedAt: now,
      };
      await tx.insert(agentBusMessages).values(message);
      const persistedRows = await tx.select().from(agentBusMessages).where(eq(agentBusMessages.id, messageId)).limit(1);
      const persisted = persistedRows[0];
      if (!persisted) throw new Error('Inserted agent message could not be read back');
      await tx
        .update(agentBusConversations)
        .set({ nextSequence: sequence + 1, lastActivityAt: now, updatedAt: now })
        .where(eq(agentBusConversations.id, conversation.id));
      return { message: persisted, sender, target, content, created: true };
    });
    if (result.created) {
      await this.recordRuntime('agent_message.queued', authenticated.host.id, result.sender.engine, {
        message_id: result.message.id,
        conversation_id: result.message.conversationId,
        source_address_id: result.sender.id,
        target_address_id: result.target.id,
        source_engine: result.sender.engine,
        target_engine: result.target.engine,
        content_bytes: result.message.contentBytes,
      });
      wsPublisher.publish('agent_messaging.message.changed', {
        message_id: result.message.id,
        conversation_id: result.message.conversationId,
        status: result.message.status,
      });
    }
    return {
      created: result.created,
      message: messageForParticipant(result.message, result.content, result.sender, result.target),
    };
  }

  async replyMessage(
    sessionId: string,
    bridgeToken: string,
    parentMessageId: string,
    input: { content: string; clientMessageId: string; ttlSeconds?: number | null },
  ): Promise<Record<string, unknown>> {
    const authenticated = await this.authenticateBridge(sessionId, bridgeToken);
    const senderAddressId = authenticated.session.agentBusAddressId;
    if (!senderAddressId) throw new ConflictError('Agent session has no messaging address', 'agent_messaging_address_missing');
    const content = normalizeMessageBody(input.content);
    const clientMessageId = normalizeUuid(input.clientMessageId, 'client_message_id');
    const ttlSeconds = normalizeMessageTtl(input.ttlSeconds);
    const parentId = normalizeUuid(parentMessageId, 'message_id');
    const result = await this.db.transaction(async (tx) => {
      await this.requireEnabledLocked(tx);
      const sender = await this.requireAddressLocked(tx, senderAddressId);
      await this.assertSessionAddressLocked(tx, authenticated.session.id, sender);
      const parentRows = await tx.select().from(agentBusMessages).where(eq(agentBusMessages.id, parentId)).limit(1).for('update');
      const parent = parentRows[0];
      if (!parent || parent.targetAddressId !== sender.id) {
        throw new NotFoundError('Message not found', 'agent_messaging_message_not_found');
      }
      const target = await this.requireAddressLocked(tx, parent.senderAddressId);
      await this.assertAddressEligibleLocked(tx, target);
      const existingRows = await tx
        .select()
        .from(agentBusMessages)
        .where(and(eq(agentBusMessages.senderAddressId, sender.id), eq(agentBusMessages.clientMessageId, clientMessageId)))
        .limit(1)
        .for('update');
      const existing = existingRows[0];
      if (existing) {
        this.assertMessageIdempotency(existing, target.id, parent.conversationId, parent.id, content, 'reply');
        return { message: existing, sender, target, content, created: false };
      }
      const conversation = await this.requireConversationLocked(tx, parent.conversationId);
      this.assertConversationParticipants(conversation, sender.id, target.id);
      if (conversation.status !== 'open') throw new ConflictError('Conversation is canceled', 'agent_messaging_conversation_canceled');
      const now = nowIso();
      const sequence = Number(conversation.nextSequence);
      const messageId = randomUUID();
      const message: typeof agentBusMessages.$inferInsert = {
        id: messageId,
        conversationId: conversation.id,
        sequence,
        replyToMessageId: parent.id,
        redriveOfMessageId: null,
        senderAddressId: sender.id,
        senderSessionId: authenticated.session.id,
        targetAddressId: target.id,
        sourceEngine: sender.engine,
        targetEngine: target.engine,
        kind: 'reply',
        contentEnc: encrypt(content, this.keyring),
        contentBytes: Buffer.byteLength(content, 'utf8'),
        clientMessageId,
        status: 'queued',
        attempts: 0,
        nextAttemptAt: now,
        leaseOwner: null,
        leaseUntil: null,
        claimId: null,
        relayGeneration: null,
        targetBindingGeneration: null,
        deliverySessionId: null,
        deliveryUpstreamSessionId: null,
        expiresAt: isoOffsetSeconds(ttlSeconds),
        lastErrorCode: null,
        lastErrorEnc: null,
        cancelRequestedAt: null,
        acceptedAt: null,
        completedAt: null,
        ambiguousAt: null,
        deadAt: null,
        expiredAt: null,
        canceledAt: null,
        createdAt: now,
        updatedAt: now,
      };
      await tx.insert(agentBusMessages).values(message);
      const persistedRows = await tx.select().from(agentBusMessages).where(eq(agentBusMessages.id, messageId)).limit(1);
      const persisted = persistedRows[0];
      if (!persisted) throw new Error('Inserted agent reply could not be read back');
      // An attached conference member reports by replying to its task.
      await this.settleConferenceDispatchLocked(tx, parent.id, now);
      await this.chargeConferenceBudgetLocked(tx, parent.conversationId, now);
      await tx.update(agentBusConversations).set({ nextSequence: sequence + 1, lastActivityAt: now, updatedAt: now }).where(eq(agentBusConversations.id, conversation.id));
      return { message: persisted, sender, target, content, created: true };
    });
    if (result.created) {
      await this.recordRuntime('agent_message.replied', authenticated.host.id, result.sender.engine, {
        message_id: result.message.id,
        conversation_id: result.message.conversationId,
        reply_to_message_id: result.message.replyToMessageId,
        source_address_id: result.sender.id,
        target_address_id: result.target.id,
        content_bytes: result.message.contentBytes,
      });
      wsPublisher.publish('agent_messaging.message.changed', { message_id: result.message.id, conversation_id: result.message.conversationId, status: 'queued' });
    }
    return { created: result.created, message: messageForParticipant(result.message, result.content, result.sender, result.target) };
  }

  async waitForMessages(
    sessionId: string,
    bridgeToken: string,
    conversationId: string,
    afterSequence = 0,
  ): Promise<Record<string, unknown>> {
    const authenticated = await this.authenticateBridge(sessionId, bridgeToken);
    const addressId = authenticated.session.agentBusAddressId;
    if (!addressId) throw new ConflictError('Agent session has no messaging address', 'agent_messaging_address_missing');
    const id = normalizeUuid(conversationId, 'conversation_id');
    const { conversation, rows, hasMore } = await this.db.transaction(async (tx) => {
      await this.requireEnabledLocked(tx);
      const address = await this.requireAddressLocked(tx, addressId);
      await this.assertSessionAddressLocked(tx, authenticated.session.id, address);
      const conversationRows = await tx.select().from(agentBusConversations).where(eq(agentBusConversations.id, id)).limit(1).for('update');
      const conversation = conversationRows[0];
      if (!conversation || !conversationIncludes(conversation, addressId)) {
        throw new NotFoundError('Conversation not found', 'agent_messaging_conversation_not_found');
      }
      const fetched = await tx
        .select()
        .from(agentBusMessages)
        .where(and(eq(agentBusMessages.conversationId, id), eq(agentBusMessages.targetAddressId, addressId), gt(agentBusMessages.sequence, Math.max(0, Math.trunc(afterSequence)))))
        .orderBy(asc(agentBusMessages.sequence))
        .limit(AGENT_MESSAGING_WAIT_PAGE_SIZE + 1);
      return { conversation, rows: fetched.slice(0, AGENT_MESSAGING_WAIT_PAGE_SIZE), hasMore: fetched.length > AGENT_MESSAGING_WAIT_PAGE_SIZE };
    });
    const addresses = await this.addressMap(rows.flatMap((row) => [row.senderAddressId, row.targetAddressId]));
    return {
      conversation: conversationMetadata(conversation),
      messages: rows.map((row) => messageForParticipant(row, this.decodeContent(row), addresses.get(row.senderAddressId)!, addresses.get(row.targetAddressId)!)),
      has_more: hasMore,
      next_sequence: rows.at(-1)?.sequence ?? Math.max(0, Math.trunc(afterSequence)),
    };
  }

  async getMessage(sessionId: string, bridgeToken: string, messageId: string): Promise<Record<string, unknown>> {
    const authenticated = await this.authenticateBridge(sessionId, bridgeToken);
    const addressId = authenticated.session.agentBusAddressId;
    if (!addressId) throw new ConflictError('Agent session has no messaging address', 'agent_messaging_address_missing');
    const id = normalizeUuid(messageId, 'message_id');
    const message = await this.db.transaction(async (tx) => {
      await this.requireEnabledLocked(tx);
      const address = await this.requireAddressLocked(tx, addressId);
      await this.assertSessionAddressLocked(tx, authenticated.session.id, address);
      const rows = await tx.select().from(agentBusMessages).where(eq(agentBusMessages.id, id)).limit(1).for('update');
      const message = rows[0];
      if (!message || (message.senderAddressId !== addressId && message.targetAddressId !== addressId)) {
        throw new NotFoundError('Message not found', 'agent_messaging_message_not_found');
      }
      return message;
    });
    const addresses = await this.addressMap([message.senderAddressId, message.targetAddressId]);
    return { message: messageForParticipant(message, this.decodeContent(message), addresses.get(message.senderAddressId)!, addresses.get(message.targetAddressId)!) };
  }

  async cancelConversation(sessionId: string, bridgeToken: string, conversationId: string, reason?: string | null): Promise<Record<string, unknown>> {
    const authenticated = await this.authenticateBridge(sessionId, bridgeToken);
    const addressId = authenticated.session.agentBusAddressId;
    if (!addressId) throw new ConflictError('Agent session has no messaging address', 'agent_messaging_address_missing');
    const id = normalizeUuid(conversationId, 'conversation_id');
    const result = await this.cancelConversationInternal(
      id,
      `agent:${addressId}`,
      reason ?? 'Canceled by participant',
      addressId,
      authenticated.session.id,
    );
    wsPublisher.publish('agent_messaging.conversation.changed', { conversation_id: id, status: 'canceled' });
    return result;
  }

  async claimForSession(sessionId: string, bridgeToken: string, claimId: string): Promise<MessageDelivery | null> {
    const authenticated = await this.authenticateBridge(sessionId, bridgeToken);
    const addressId = authenticated.session.agentBusAddressId;
    if (!addressId) throw new ConflictError('Agent session has no messaging address', 'agent_messaging_address_missing');
    if (!authenticated.session.receiveHeartbeatAt) {
      throw new ConflictError('Agent session is not receive-capable', 'agent_messaging_adapter_unavailable');
    }
    return await this.claimDelivery([addressId], `session:${sessionId}`, claimId, null, false);
  }

  /**
   * Report what is waiting without touching it.
   *
   * An interactive agent has no interrupt -- it exists only during a turn -- so
   * until something tells it otherwise, a queued message simply expires unread.
   * This is the ring. Two constraints follow from that job and neither is
   * negotiable:
   *
   * - It must work *before* the agent has ever bound receive-capable, because
   *   binding happens on the first `agent_listen` and the whole point is that
   *   the agent has not listened yet. So, unlike `claimForSession`, there is no
   *   `receiveHeartbeatAt` gate here.
   * - It must leave the queue exactly as it found it: no lease, no status
   *   transition, no attempt burned. Peeking is not claiming.
   *
   * Content is deliberately omitted. Hearing the phone ring is not answering
   * it, and handing the body over without a lease would tell the sender its
   * message went unread while the target had in fact read it.
   *
   * `missed` exists because expiry is otherwise entirely invisible: today an
   * unanswered message flips to `expired` and no one ever learns a call was
   * placed at all.
   */
  async peekMailbox(sessionId: string, bridgeToken: string): Promise<Record<string, unknown>> {
    const authenticated = await this.authenticateBridge(sessionId, bridgeToken);
    const addressId = authenticated.session.agentBusAddressId;
    if (!addressId) throw new ConflictError('Agent session has no messaging address', 'agent_messaging_address_missing');
    const now = nowIso();
    const missedAfter = isoOffsetSeconds(-AGENT_MESSAGING_MISSED_WINDOW_SECONDS);
    const rows = await this.db
      .select({ message: agentBusMessages, sender: agentBusAddresses, fqdn: hosts.fqdn })
      .from(agentBusMessages)
      .innerJoin(agentBusAddresses, eq(agentBusAddresses.id, agentBusMessages.senderAddressId))
      .innerJoin(hosts, eq(hosts.id, agentBusAddresses.hostId))
      .where(
        and(
          eq(agentBusMessages.targetAddressId, addressId),
          or(
            and(eq(agentBusMessages.status, 'queued'), gt(agentBusMessages.expiresAt, now)),
            and(eq(agentBusMessages.status, 'expired'), gt(agentBusMessages.expiredAt, missedAfter)),
          ),
        ),
      )
      .orderBy(asc(agentBusMessages.dispatchOrder))
      .limit(AGENT_MESSAGING_MAILBOX_PAGE_SIZE);
    const pending: Record<string, unknown>[] = [];
    const missed: Record<string, unknown>[] = [];
    for (const row of rows) {
      const from = {
        address: row.sender.address,
        alias: row.sender.displayAlias,
        engine: row.sender.engine,
        fqdn: row.fqdn,
      };
      if (row.message.status === 'queued') {
        pending.push({
          message_id: row.message.id,
          conversation_id: row.message.conversationId,
          kind: row.message.kind,
          from,
          expires_at: row.message.expiresAt,
        });
      } else {
        missed.push({ from, expired_at: row.message.expiredAt });
      }
    }
    return { pending, missed };
  }

  async registerRelay(
    host: Host,
    input: {
      username: string;
      instanceId: string;
      wrapperVersion: string;
      capabilities?: Record<string, unknown> | null;
    },
  ): Promise<Record<string, unknown>> {
    await this.requireEnabled();
    this.assertEligibleHost(host);
    const username = normalizeRequiredText(input.username, 'username', 255);
    const instanceId = normalizeUuid(input.instanceId, 'instance_id');
    const wrapperVersion = normalizeRequiredText(input.wrapperVersion, 'wrapper_version', 64);
    const rawToken = randomBytes(32).toString('base64url');
    const now = nowIso();
    const expiresAt = isoOffsetSeconds(AGENT_MESSAGING_RELAY_TOKEN_SECONDS);
    const fingerprint = hostAuthFingerprint(host);
    const relay = await this.db.transaction(async (tx) => {
      await this.requireEnabledLocked(tx);
      const lockedHost = await this.requireEligibleHostLocked(tx, host.id);
      if (!safeHashEqual(hostAuthFingerprint(lockedHost), fingerprint)) {
        throw new UnauthorizedError('Host credential changed during relay registration', 'agent_messaging_relay_host_auth_changed');
      }
      const rows = await tx
        .select()
        .from(agentBusRelays)
        .where(and(eq(agentBusRelays.hostId, host.id), eq(agentBusRelays.username, username)))
        .limit(1)
        .for('update');
      const existing = rows[0];
      if (!existing) {
        const created: AgentBusRelay = {
          id: randomUUID(),
          hostId: host.id,
          username,
          instanceId,
          generation: 1,
          tokenHash: sha256(rawToken),
          tokenExpiresAt: expiresAt,
          hostAuthFingerprint: fingerprint,
          wrapperVersion,
          capabilities: input.capabilities ?? null,
          status: 'active',
          heartbeatAt: now,
          stopRequestedAt: null,
          stoppedAt: null,
          createdAt: now,
          updatedAt: now,
        };
        await tx.insert(agentBusRelays).values(created);
        return created;
      }
      const generation = existing.generation + 1;
      await tx
        .update(agentBusRelays)
        .set({
          instanceId,
          generation,
          tokenHash: sha256(rawToken),
          tokenExpiresAt: expiresAt,
          hostAuthFingerprint: fingerprint,
          wrapperVersion,
          capabilities: input.capabilities ?? null,
          status: 'active',
          heartbeatAt: now,
          stopRequestedAt: null,
          stoppedAt: null,
          updatedAt: now,
        })
        .where(eq(agentBusRelays.id, existing.id));
      return { ...existing, instanceId, generation, tokenExpiresAt: expiresAt, status: 'active' };
    });
    wsPublisher.publish('agent_messaging.relay.changed', { relay_id: relay.id, host_id: host.id, status: 'active' });
    return {
      enabled: true,
      relay_id: relay.id,
      generation: relay.generation,
      relay_token: rawToken,
      expires_at: expiresAt,
      poll_seconds: 25,
    };
  }

  async heartbeatRelay(relayId: string, rawToken: string): Promise<Record<string, unknown>> {
    const relay = await this.authenticateRelay(relayId, rawToken);
    const now = nowIso();
    const expiresAt = isoOffsetSeconds(AGENT_MESSAGING_RELAY_TOKEN_SECONDS);
    await this.db
      .update(agentBusRelays)
      .set({ heartbeatAt: now, tokenExpiresAt: expiresAt, updatedAt: now })
      .where(and(eq(agentBusRelays.id, relay.id), eq(agentBusRelays.generation, relay.generation)));
    return { enabled: true, generation: relay.generation, expires_at: expiresAt, stop_requested: false };
  }

  async stopRelay(relayId: string, rawToken: string): Promise<Record<string, unknown>> {
    const relay = await this.authenticateRelay(relayId, rawToken);
    const now = nowIso();
    await this.db
      .update(agentBusRelays)
      .set({ status: 'stopped', tokenHash: null, tokenExpiresAt: null, stoppedAt: now, updatedAt: now })
      .where(and(eq(agentBusRelays.id, relay.id), eq(agentBusRelays.generation, relay.generation)));
    wsPublisher.publish('agent_messaging.relay.changed', { relay_id: relay.id, host_id: relay.hostId, status: 'stopped' });
    return { stopped: true };
  }

  async claimForRelay(relayId: string, rawToken: string, claimId: string): Promise<MessageDelivery | null> {
    const relay = await this.authenticateRelay(relayId, rawToken);
    const rows = await this.db
      .select({ id: agentBusAddresses.id, engine: agentBusAddresses.engine, hostEngines: hosts.engines })
      .from(agentBusAddresses)
      .innerJoin(hosts, eq(hosts.id, agentBusAddresses.hostId))
      .where(and(
        eq(agentBusAddresses.hostId, relay.hostId),
        eq(agentBusAddresses.username, relay.username),
        eq(agentBusAddresses.enabled, 1),
        isNull(agentBusAddresses.archivedAt),
        messagingHostEligibleSql(),
        isNull(agentBusAddresses.currentSessionId),
      ));
    if (rows.length === 0) return null;
    const eligible = rows.filter((row) => hostEnginesList(row.hostEngines).includes(row.engine as Engine));
    if (eligible.length === 0) return null;
    return await this.claimDelivery(eligible.map((row) => row.id), `relay:${relay.id}:${relay.generation}`, claimId, relay.generation, true);
  }

  async renewSessionDelivery(sessionId: string, bridgeToken: string, messageId: string, claimId: string): Promise<Record<string, unknown>> {
    await this.authenticateBridge(sessionId, bridgeToken);
    return await this.renewDelivery(messageId, claimId, `session:${sessionId}`, null);
  }

  async renewRelayDelivery(relayId: string, rawToken: string, messageId: string, claimId: string): Promise<Record<string, unknown>> {
    const relay = await this.authenticateRelay(relayId, rawToken);
    return await this.renewDelivery(
      messageId,
      claimId,
      `relay:${relay.id}:${relay.generation}`,
      relay.generation,
    );
  }

  async acknowledgeSessionDelivery(
    sessionId: string,
    bridgeToken: string,
    messageId: string,
    input: { claimId: string; outcome: AgentMessagingOutcome; upstreamSessionId?: string | null; errorCode?: string | null; error?: string | null },
  ): Promise<Record<string, unknown>> {
    const authenticated = await this.authenticateBridge(sessionId, bridgeToken);
    return await this.acknowledgeDelivery(messageId, input, `session:${sessionId}`, null, authenticated.session.id);
  }

  async acknowledgeRelayDelivery(
    relayId: string,
    rawToken: string,
    messageId: string,
    input: { claimId: string; outcome: AgentMessagingOutcome; deliverySessionId?: string | null; upstreamSessionId?: string | null; errorCode?: string | null; error?: string | null },
  ): Promise<Record<string, unknown>> {
    const relay = await this.authenticateRelay(relayId, rawToken);
    return await this.acknowledgeDelivery(
      messageId,
      input,
      `relay:${relay.id}:${relay.generation}`,
      relay.generation,
      input.deliverySessionId ?? null,
    );
  }

  async replyFromRelayDelivery(
    relayId: string,
    rawToken: string,
    parentMessageId: string,
    input: {
      claimId: string;
      content: string;
      clientMessageId: string;
      deliverySessionId?: string | null;
      upstreamSessionId?: string | null;
    },
  ): Promise<Record<string, unknown>> {
    const relay = await this.authenticateRelay(relayId, rawToken);
    const parentId = normalizeUuid(parentMessageId, 'message_id');
    const claimId = normalizeUuid(input.claimId, 'claim_id');
    const clientMessageId = normalizeUuid(input.clientMessageId, 'client_message_id');
    const deliverySessionId = input.deliverySessionId
      ? normalizeUuid(input.deliverySessionId, 'delivery_session_id')
      : null;
    const upstreamSessionId = normalizeOptionalText(input.upstreamSessionId, 255);
    const content = normalizeMessageBody(input.content);
    const result = await this.db.transaction(async (tx) => {
      await this.requireEnabledLocked(tx);
      await this.requireRelayGenerationLocked(tx, relay.id, relay.generation);
      const parentRows = await tx
        .select()
        .from(agentBusMessages)
        .where(eq(agentBusMessages.id, parentId))
        .limit(1)
        .for('update');
      const parent = parentRows[0];
      const leaseOwner = `relay:${relay.id}:${relay.generation}`;
      if (
        !parent ||
        parent.leaseOwner !== leaseOwner ||
        parent.claimId !== claimId ||
        parent.relayGeneration !== relay.generation ||
        (parent.status !== 'leased' && parent.status !== 'accepted')
      ) {
        throw new ConflictError('Message lease is no longer owned by this delivery', 'agent_messaging_lease_lost');
      }
      const sender = await this.requireAddressLocked(tx, parent.targetAddressId);
      if (sender.hostId !== relay.hostId || sender.username !== relay.username) {
        throw new ForbiddenError('Relay does not own this delivery address', 'agent_messaging_relay_target_mismatch');
      }
      const target = await this.requireAddressLocked(tx, parent.senderAddressId);
      await this.assertAddressEligibleLocked(tx, target);
      const existingRows = await tx
        .select()
        .from(agentBusMessages)
        .where(and(eq(agentBusMessages.replyToMessageId, parent.id), eq(agentBusMessages.senderAddressId, sender.id)))
        .limit(1)
        .for('update');
      if (existingRows[0]) {
        return { message: existingRows[0], sender, target, created: false };
      }
      const conversation = await this.requireConversationLocked(tx, parent.conversationId);
      this.assertConversationParticipants(conversation, sender.id, target.id);
      if (conversation.status !== 'open') {
        throw new ConflictError('Conversation is canceled', 'agent_messaging_conversation_canceled');
      }
      const now = nowIso();
      const messageId = randomUUID();
      const message: typeof agentBusMessages.$inferInsert = {
        id: messageId,
        conversationId: conversation.id,
        sequence: Number(conversation.nextSequence),
        replyToMessageId: parent.id,
        redriveOfMessageId: null,
        senderAddressId: sender.id,
        senderSessionId: deliverySessionId,
        targetAddressId: target.id,
        sourceEngine: sender.engine,
        targetEngine: target.engine,
        kind: 'reply',
        contentEnc: encrypt(content, this.keyring),
        contentBytes: Buffer.byteLength(content, 'utf8'),
        clientMessageId,
        status: 'queued',
        attempts: 0,
        nextAttemptAt: now,
        leaseOwner: null,
        leaseUntil: null,
        claimId: null,
        relayGeneration: null,
        targetBindingGeneration: null,
        deliverySessionId: null,
        deliveryUpstreamSessionId: null,
        expiresAt: isoOffsetSeconds(AGENT_MESSAGING_DEFAULT_TTL_SECONDS),
        lastErrorCode: null,
        lastErrorEnc: null,
        cancelRequestedAt: null,
        acceptedAt: null,
        completedAt: null,
        ambiguousAt: null,
        deadAt: null,
        expiredAt: null,
        canceledAt: null,
        createdAt: now,
        updatedAt: now,
      };
      await tx.insert(agentBusMessages).values(message);
      const persistedRows = await tx.select().from(agentBusMessages).where(eq(agentBusMessages.id, messageId)).limit(1);
      const persisted = persistedRows[0];
      if (!persisted) throw new Error('Inserted relay reply could not be read back');
      // A headless conference member never calls a tool: the relay correlates
      // its final output and posts it here, so this is where its dispatch ends.
      await this.settleConferenceDispatchLocked(tx, parent.id, now);
      await this.chargeConferenceBudgetLocked(tx, parent.conversationId, now);
      await tx
        .update(agentBusConversations)
        .set({ nextSequence: persisted.sequence + 1, lastActivityAt: now, updatedAt: now })
        .where(eq(agentBusConversations.id, conversation.id));
      await tx
        .update(agentBusMessages)
        .set({ deliverySessionId, deliveryUpstreamSessionId: upstreamSessionId, updatedAt: now })
        .where(eq(agentBusMessages.id, parent.id));
      return { message: persisted, sender, target, created: true };
    });
    if (result.created) {
      await this.recordRuntime('agent_message.replied', relay.hostId, result.sender.engine, {
        message_id: result.message.id,
        conversation_id: result.message.conversationId,
        reply_to_message_id: parentId,
        source_address_id: result.sender.id,
        target_address_id: result.target.id,
        content_bytes: result.message.contentBytes,
      });
      wsPublisher.publish('agent_messaging.message.changed', {
        message_id: result.message.id,
        conversation_id: result.message.conversationId,
        status: 'queued',
      });
    }
    return { created: result.created, message: messageMetadata(result.message, result.sender, result.target) };
  }

  async listAdminAddresses(): Promise<Record<string, unknown>> {
    const masterEnabled = await this.isEnabled();
    const rows = await this.db
      .select({
        address: agentBusAddresses,
        fqdn: hosts.fqdn,
        hostSecure: hosts.secure,
        hostStatus: hosts.status,
        hostWindowUntil: hosts.insecureEnabledUntil,
        hostEngines: hosts.engines,
      })
      .from(agentBusAddresses)
      .innerJoin(hosts, eq(hosts.id, agentBusAddresses.hostId))
      .where(isNull(agentBusAddresses.archivedAt))
      .orderBy(desc(agentBusAddresses.lastSeenAt));
    const queueRows = await this.db
      .select({ targetAddressId: agentBusMessages.targetAddressId, value: count() })
      .from(agentBusMessages)
      .where(inArray(agentBusMessages.status, [...LIVE_MESSAGE_STATUSES]))
      .groupBy(agentBusMessages.targetAddressId);
    const queues = new Map(queueRows.map((row) => [row.targetAddressId, Number(row.value)]));
    return {
      addresses: rows.map((row) => ({
        ...publicAddress(row.address, row.fqdn),
        current_session_id: row.address.currentSessionId,
        host_secure: row.hostSecure === 1,
        host_status: row.hostStatus,
        host_window_until: row.hostWindowUntil,
        host_engines: hostEnginesList(row.hostEngines),
        eligible:
          masterEnabled &&
          messagingHostEligible({
            status: row.hostStatus,
            secure: row.hostSecure,
            insecureEnabledUntil: row.hostWindowUntil,
          }) &&
          hostEnginesList(row.hostEngines).includes(row.address.engine as Engine),
        ineligible_reason: addressIneligibleReason(
          masterEnabled,
          messagingHostEligible({
            status: row.hostStatus,
            secure: row.hostSecure,
            insecureEnabledUntil: row.hostWindowUntil,
          }),
          row.hostSecure === 1,
          row.hostStatus,
          hostEnginesList(row.hostEngines),
          row.address.engine as Engine,
        ),
        queue_depth: queues.get(row.address.id) ?? 0,
      })),
    };
  }

  async setAddressAlias(addressId: string, displayAlias: string | null): Promise<Record<string, unknown>> {
    const id = normalizeUuid(addressId, 'address_id');
    const alias = normalizeAgentAlias(displayAlias);
    const now = nowIso();
    const rows = await this.db.select().from(agentBusAddresses).where(eq(agentBusAddresses.id, id)).limit(1);
    if (!rows[0] || rows[0].archivedAt) throw new NotFoundError('Agent address not found', 'agent_messaging_address_not_found');
    try {
      await this.db.update(agentBusAddresses).set({ displayAlias: alias, updatedAt: now }).where(eq(agentBusAddresses.id, id));
    } catch (error) {
      if (isDuplicateKeyError(error)) throw new ConflictError('Agent alias already exists', 'agent_messaging_alias_conflict');
      throw error;
    }
    wsPublisher.publish('agent_messaging.address.changed', { address_id: id });
    return { address: { ...publicAddress(rows[0]), alias } };
  }

  async setAddressEnabled(addressId: string, enabled: boolean): Promise<Record<string, unknown>> {
    const id = normalizeUuid(addressId, 'address_id');
    const now = nowIso();
    const result = await this.db.transaction(async (tx) => {
      const rows = await tx.select().from(agentBusAddresses).where(eq(agentBusAddresses.id, id)).limit(1).for('update');
      const address = rows[0];
      if (!address || address.archivedAt) throw new NotFoundError('Agent address not found', 'agent_messaging_address_not_found');
      if (enabled) {
        const [stateRows, hostRows] = await Promise.all([
          tx.select({ version: versions.version }).from(versions).where(eq(versions.name, AGENT_MESSAGING_ENABLED_KEY)).limit(1).for('update'),
          tx.select().from(hosts).where(eq(hosts.id, address.hostId)).limit(1).for('update'),
        ]);
        if (!isTruthyFlagValue(stateRows[0]?.version, false)) {
          throw new ConflictError('Agent Messaging is disabled', 'agent_messaging_disabled');
        }
        const host = hostRows[0];
        if (
          !host ||
          !messagingHostEligible(host) ||
          !hostEnginesList(host.engines).includes(address.engine as Engine)
        ) {
          throw new ConflictError('Agent Messaging requires an eligible active host', 'agent_messaging_host_ineligible');
        }
      }
      await tx
        .update(agentBusAddresses)
        .set({
          enabled: enabled ? 1 : 0,
          currentSessionId: enabled ? address.currentSessionId : null,
          // A disabled address must not stay dialable.
          callPin: enabled ? address.callPin : null,
          callPinExpiresAt: enabled ? address.callPinExpiresAt : null,
          readiness: enabled
            ? address.currentSessionId
              ? address.readiness
              : address.lastUpstreamSessionId
                ? 'resumable'
                : 'offline'
            : 'disabled',
          receiveHeartbeatAt: enabled ? address.receiveHeartbeatAt : null,
          bindingGeneration: enabled ? address.bindingGeneration : address.bindingGeneration + 1,
          updatedAt: now,
        })
        .where(eq(agentBusAddresses.id, id));
      if (enabled) return { canceled: 0, ambiguous: 0 };
      const scope = or(eq(agentBusMessages.senderAddressId, id), eq(agentBusMessages.targetAddressId, id));
      const [pending, uncertain] = await Promise.all([
        tx.select({ value: count() }).from(agentBusMessages).where(and(inArray(agentBusMessages.status, [...CANCELABLE_MESSAGE_STATUSES]), scope)),
        tx.select({ value: count() }).from(agentBusMessages).where(and(eq(agentBusMessages.status, 'accepted'), scope)),
      ]);
      await tx
        .update(agentBusMessages)
        .set({ status: 'canceled', cancelRequestedAt: now, canceledAt: now, leaseOwner: null, leaseUntil: null, updatedAt: now })
        .where(and(inArray(agentBusMessages.status, [...CANCELABLE_MESSAGE_STATUSES]), scope));
      await tx
        .update(agentBusMessages)
        .set({ status: 'ambiguous', ambiguousAt: now, lastErrorCode: 'address_disabled_after_accept', leaseOwner: null, leaseUntil: null, updatedAt: now })
        .where(and(eq(agentBusMessages.status, 'accepted'), scope));
      await tx
        .update(agentBusConversations)
        .set({
          status: 'canceled',
          canceledBy: 'system:address-disabled',
          cancelReason: 'Agent address disabled',
          canceledAt: now,
          updatedAt: now,
        })
        .where(and(eq(agentBusConversations.status, 'open'), or(eq(agentBusConversations.addressAId, id), eq(agentBusConversations.addressBId, id))));
      await tx
        .update(agentSessions)
        .set({ adapterProtocol: null, adapterCapabilities: null, receiveHeartbeatAt: null, bindingGeneration: sql`${agentSessions.bindingGeneration} + 1`, updatedAt: now })
        .where(eq(agentSessions.agentBusAddressId, id));
      return { canceled: Number(pending[0]?.value ?? 0), ambiguous: Number(uncertain[0]?.value ?? 0) };
    });
    wsPublisher.publish('agent_messaging.address.changed', { address_id: id, enabled, ...result });
    return { address_id: id, enabled, ...result };
  }

  async listAdminConversations(options: { status?: string; limit?: number } = {}): Promise<Record<string, unknown>> {
    const limit = Math.max(1, Math.min(500, Math.trunc(options.limit ?? 100)));
    const rows = options.status
      ? await this.db.select().from(agentBusConversations).where(eq(agentBusConversations.status, options.status)).orderBy(desc(agentBusConversations.lastActivityAt)).limit(limit)
      : await this.db.select().from(agentBusConversations).orderBy(desc(agentBusConversations.lastActivityAt)).limit(limit);
    const addresses = await this.addressMap(rows.flatMap((row) => [row.addressAId, row.addressBId]));
    return {
      conversations: rows.map((row) => ({
        ...conversationMetadata(row),
        address_a: publicAddress(addresses.get(row.addressAId)!),
        address_b: publicAddress(addresses.get(row.addressBId)!),
      })),
    };
  }

  async listAdminMessages(options: { conversationId?: string; status?: string; limit?: number } = {}): Promise<Record<string, unknown>> {
    const limit = Math.max(1, Math.min(500, Math.trunc(options.limit ?? 100)));
    const predicates = [];
    if (options.conversationId) predicates.push(eq(agentBusMessages.conversationId, normalizeUuid(options.conversationId, 'conversation_id')));
    if (options.status) predicates.push(eq(agentBusMessages.status, options.status));
    const rows = predicates.length > 0
      ? await this.db.select().from(agentBusMessages).where(and(...predicates)).orderBy(desc(agentBusMessages.createdAt)).limit(limit)
      : await this.db.select().from(agentBusMessages).orderBy(desc(agentBusMessages.createdAt)).limit(limit);
    const addresses = await this.addressMap(rows.flatMap((row) => [row.senderAddressId, row.targetAddressId]));
    return {
      messages: rows.map((row) => messageMetadata(row, addresses.get(row.senderAddressId), addresses.get(row.targetAddressId))),
    };
  }

  async revealMessage(messageId: string): Promise<Record<string, unknown>> {
    const id = normalizeUuid(messageId, 'message_id');
    const rows = await this.db.select().from(agentBusMessages).where(eq(agentBusMessages.id, id)).limit(1);
    const message = rows[0];
    if (!message) throw new NotFoundError('Message not found', 'agent_messaging_message_not_found');
    return { message_id: id, content: this.decodeContent(message) };
  }

  async adminCancelConversation(conversationId: string, reason?: string | null): Promise<Record<string, unknown>> {
    const id = normalizeUuid(conversationId, 'conversation_id');
    const result = await this.cancelConversationInternal(id, 'admin', reason ?? 'Canceled by administrator');
    wsPublisher.publish('agent_messaging.conversation.changed', { conversation_id: id, status: 'canceled' });
    return result;
  }

  async redriveMessage(messageId: string): Promise<Record<string, unknown>> {
    await this.requireEnabled();
    const id = normalizeUuid(messageId, 'message_id');
    const result = await this.db.transaction(async (tx) => {
      await this.requireEnabledLocked(tx);
      const rows = await tx.select().from(agentBusMessages).where(eq(agentBusMessages.id, id)).limit(1).for('update');
      const original = rows[0];
      if (!original) throw new NotFoundError('Message not found', 'agent_messaging_message_not_found');
      if (original.status !== 'dead' && original.status !== 'ambiguous') {
        throw new ConflictError('Only dead or ambiguous messages can be redriven', 'agent_messaging_redrive_not_allowed');
      }
      const conversation = await this.requireConversationLocked(tx, original.conversationId);
      if (conversation.status !== 'open') throw new ConflictError('Conversation is canceled', 'agent_messaging_conversation_canceled');
      const now = nowIso();
      const sequence = Number(conversation.nextSequence);
      const { dispatchOrder: _originalDispatchOrder, ...originalForRedrive } = original;
      const redriveId = randomUUID();
      const redrive: typeof agentBusMessages.$inferInsert = {
        ...originalForRedrive,
        id: redriveId,
        sequence,
        redriveOfMessageId: original.id,
        clientMessageId: randomUUID(),
        status: 'queued',
        attempts: 0,
        nextAttemptAt: now,
        leaseOwner: null,
        leaseUntil: null,
        claimId: null,
        relayGeneration: null,
        targetBindingGeneration: null,
        deliverySessionId: null,
        deliveryUpstreamSessionId: null,
        expiresAt: isoOffsetSeconds(AGENT_MESSAGING_DEFAULT_TTL_SECONDS),
        lastErrorCode: null,
        lastErrorEnc: null,
        cancelRequestedAt: null,
        acceptedAt: null,
        completedAt: null,
        ambiguousAt: null,
        deadAt: null,
        expiredAt: null,
        canceledAt: null,
        createdAt: now,
        updatedAt: now,
      };
      await tx.insert(agentBusMessages).values(redrive);
      const persistedRows = await tx.select().from(agentBusMessages).where(eq(agentBusMessages.id, redriveId)).limit(1);
      const persisted = persistedRows[0];
      if (!persisted) throw new Error('Redriven agent message could not be read back');
      await tx.update(agentBusConversations).set({ nextSequence: sequence + 1, lastActivityAt: now, updatedAt: now }).where(eq(agentBusConversations.id, conversation.id));
      return persisted;
    });
    wsPublisher.publish('agent_messaging.message.changed', { message_id: result.id, conversation_id: result.conversationId, status: 'queued', redrive_of: id });
    return { message: messageMetadata(result), redrive_of_message_id: id };
  }

  async maintenance(): Promise<Record<string, number>> {
    const now = nowIso();
    const staleRelay = isoOffsetSeconds(-2 * AGENT_MESSAGING_RECEIVE_FRESH_SECONDS);
    const result = await this.db.transaction(async (tx) => {
      const releasedBindings = await reapExpiredAgentMessagingBindingsLocked(tx, now);
      // Expired PINs are also swept at mint and redeem time; doing it here as
      // well means a PIN nobody ever dials does not squat its slot in the unique
      // index until the next `#call` happens to run.
      await this.sweepCallPinsLocked(tx, now);
      const expiring = await tx.select({ value: count() }).from(agentBusMessages).where(and(inArray(agentBusMessages.status, ['queued', 'leased']), lte(agentBusMessages.expiresAt, now)));
      const retryable = await tx.select({ value: count() }).from(agentBusMessages).where(and(eq(agentBusMessages.status, 'leased'), lte(agentBusMessages.leaseUntil, now), lte(agentBusMessages.attempts, AGENT_MESSAGING_MAX_DELIVERY_ATTEMPTS - 1), gt(agentBusMessages.expiresAt, now)));
      const exhausted = await tx.select({ value: count() }).from(agentBusMessages).where(and(eq(agentBusMessages.status, 'leased'), lte(agentBusMessages.leaseUntil, now), gt(agentBusMessages.attempts, AGENT_MESSAGING_MAX_DELIVERY_ATTEMPTS - 1)));
      const uncertain = await tx.select({ value: count() }).from(agentBusMessages).where(and(eq(agentBusMessages.status, 'accepted'), lte(agentBusMessages.leaseUntil, now)));
      await tx.update(agentBusMessages).set({ status: 'expired', expiredAt: now, leaseOwner: null, leaseUntil: null, updatedAt: now }).where(and(inArray(agentBusMessages.status, ['queued', 'leased']), lte(agentBusMessages.expiresAt, now)));
      await tx.update(agentBusMessages).set({ status: 'queued', nextAttemptAt: now, leaseOwner: null, leaseUntil: null, claimId: null, relayGeneration: null, updatedAt: now }).where(and(eq(agentBusMessages.status, 'leased'), lte(agentBusMessages.leaseUntil, now), lte(agentBusMessages.attempts, AGENT_MESSAGING_MAX_DELIVERY_ATTEMPTS - 1), gt(agentBusMessages.expiresAt, now)));
      await tx.update(agentBusMessages).set({ status: 'dead', deadAt: now, lastErrorCode: 'delivery_attempts_exhausted', leaseOwner: null, leaseUntil: null, updatedAt: now }).where(and(eq(agentBusMessages.status, 'leased'), lte(agentBusMessages.leaseUntil, now), gt(agentBusMessages.attempts, AGENT_MESSAGING_MAX_DELIVERY_ATTEMPTS - 1)));
      await tx.update(agentBusMessages).set({ status: 'ambiguous', ambiguousAt: now, lastErrorCode: 'accepted_lease_lost', leaseOwner: null, leaseUntil: null, updatedAt: now }).where(and(eq(agentBusMessages.status, 'accepted'), lte(agentBusMessages.leaseUntil, now)));
      await tx.update(agentBusRelays).set({ status: 'stale', updatedAt: now }).where(and(eq(agentBusRelays.status, 'active'), lte(agentBusRelays.heartbeatAt, staleRelay)));
      const conferences = await this.sweepConferencesLocked(tx, now);
      return {
        expired: Number(expiring[0]?.value ?? 0),
        retried: Number(retryable[0]?.value ?? 0),
        dead: Number(exhausted[0]?.value ?? 0),
        ambiguous: Number(uncertain[0]?.value ?? 0),
        released_bindings: releasedBindings,
        ...conferences,
      };
    });
    if (result.expired || result.retried || result.dead || result.ambiguous || result.released_bindings) wsPublisher.publish('agent_messaging.queue.changed', result);
    if (result.conferences_adjourned || result.dispatches_expired) {
      wsPublisher.publish('agent_messaging.conference.changed', {
        adjourned: result.conferences_adjourned,
        dispatches_expired: result.dispatches_expired,
      });
    }
    return result;
  }

  /**
   * Close rooms nobody is going to close, and un-strand members nobody is going
   * to answer for.
   *
   * Both halves exist because the failure they cover is silent. A chair that
   * simply walks away leaves an `open` conference holding a PIN that still
   * admits joiners; and a headless member whose engine died mid-task burns its
   * delivery attempts until the message goes `dead` without ever touching the
   * member row, so the chair waits forever on a report that is not coming. Any
   * budget that is only enforced by participants behaving well is not a budget.
   */
  private async sweepConferencesLocked(
    db: AgentMessagingDb,
    now: string,
  ): Promise<{ conferences_adjourned: number; dispatches_expired: number }> {
    const overdue = await db
      .select({ value: count() })
      .from(agentBusConferences)
      .where(and(ne(agentBusConferences.status, 'adjourned'), lte(agentBusConferences.deadlineAt, now)));
    await db
      .update(agentBusConferences)
      .set({ status: 'adjourned', adjournReason: 'Conference deadline passed', adjournedAt: now, pin: null, pinExpiresAt: null, updatedAt: now })
      .where(and(ne(agentBusConferences.status, 'adjourned'), lte(agentBusConferences.deadlineAt, now)));

    // A member whose task never came back returns to the floor rather than
    // vanishing: the chair can see the miss in `last_report_at` staying null and
    // decide whether to re-dispatch. Silently dropping it would hide the failure.
    const stranded = await db
      .select({ value: count() })
      .from(agentBusConferenceMembers)
      .where(and(eq(agentBusConferenceMembers.state, 'dispatched'), isNotNull(agentBusConferenceMembers.dispatchDeadlineAt), lte(agentBusConferenceMembers.dispatchDeadlineAt, now)));
    await db
      .update(agentBusConferenceMembers)
      .set({ state: 'seated', dispatchMessageId: null, dispatchDeadlineAt: null, updatedAt: now })
      .where(and(eq(agentBusConferenceMembers.state, 'dispatched'), isNotNull(agentBusConferenceMembers.dispatchDeadlineAt), lte(agentBusConferenceMembers.dispatchDeadlineAt, now)));

    // A graceful adjourn parks the room in `adjourning` while its last tasks run
    // out. Once none are left, nothing else is going to finish the job.
    const draining = await db
      .select({ id: agentBusConferences.id })
      .from(agentBusConferences)
      .where(eq(agentBusConferences.status, 'adjourning'))
      .for('update');
    let settled = 0;
    for (const row of draining) {
      const busy = await db
        .select({ value: count() })
        .from(agentBusConferenceMembers)
        .where(and(eq(agentBusConferenceMembers.conferenceId, row.id), eq(agentBusConferenceMembers.state, 'dispatched')));
      if (Number(busy[0]?.value ?? 0) > 0) continue;
      await db
        .update(agentBusConferences)
        .set({ status: 'adjourned', adjournedAt: now, pin: null, pinExpiresAt: null, updatedAt: now })
        .where(eq(agentBusConferences.id, row.id));
      await db
        .update(agentBusConferenceMembers)
        .set({ state: 'left', leftAt: now, updatedAt: now })
        .where(and(eq(agentBusConferenceMembers.conferenceId, row.id), ne(agentBusConferenceMembers.state, 'left')));
      settled += 1;
    }
    return {
      conferences_adjourned: Number(overdue[0]?.value ?? 0) + settled,
      dispatches_expired: Number(stranded[0]?.value ?? 0),
    };
  }

  private async claimDelivery(
    targetAddressIds: string[],
    leaseOwner: string,
    rawClaimId: string,
    relayGeneration: number | null,
    skipReceiveCapable: boolean,
  ): Promise<MessageDelivery | null> {
    const claimId = normalizeUuid(rawClaimId, 'claim_id');
    const now = nowIso();
    const leaseUntil = isoOffsetSeconds(AGENT_MESSAGING_LEASE_SECONDS);
    const receiveFreshAfter = isoOffsetSeconds(-AGENT_MESSAGING_RECEIVE_FRESH_SECONDS);
    const result = await this.db.transaction(async (tx) => {
      await this.requireEnabledLocked(tx);
      if (relayGeneration != null) {
        const relayId = relayIdFromLeaseOwner(leaseOwner);
        if (!relayId) throw new ConflictError('Relay lease owner is invalid', 'agent_messaging_lease_lost');
        await this.requireRelayGenerationLocked(tx, relayId, relayGeneration);
      } else {
        const sessionId = sessionIdFromLeaseOwner(leaseOwner);
        if (!sessionId) throw new ConflictError('Session lease owner is invalid', 'agent_messaging_lease_lost');
        const sessionRows = await tx.select().from(agentSessions).where(eq(agentSessions.id, sessionId)).limit(1).for('update');
        const session = sessionRows[0];
        if (!session?.agentBusAddressId || !targetAddressIds.includes(session.agentBusAddressId)) {
          throw new ConflictError('Agent address binding changed', 'agent_messaging_binding_stale');
        }
        const target = await this.requireAddressLocked(tx, session.agentBusAddressId);
        await this.assertSessionAddressLocked(tx, sessionId, target);
        if (!session.receiveHeartbeatAt || session.receiveHeartbeatAt <= receiveFreshAfter) {
          throw new ConflictError('Agent session is not receive-capable', 'agent_messaging_adapter_unavailable');
        }
      }
      await tx
        .update(agentBusMessages)
        .set({ status: 'expired', expiredAt: now, leaseOwner: null, leaseUntil: null, updatedAt: now })
        .where(and(inArray(agentBusMessages.targetAddressId, targetAddressIds), inArray(agentBusMessages.status, ['queued', 'leased']), lte(agentBusMessages.expiresAt, now)));
      await tx
        .update(agentBusMessages)
        .set({ status: 'queued', nextAttemptAt: now, leaseOwner: null, leaseUntil: null, claimId: null, relayGeneration: null, updatedAt: now })
        .where(and(inArray(agentBusMessages.targetAddressId, targetAddressIds), eq(agentBusMessages.status, 'leased'), lte(agentBusMessages.leaseUntil, now), gt(agentBusMessages.expiresAt, now), lte(agentBusMessages.attempts, AGENT_MESSAGING_MAX_DELIVERY_ATTEMPTS - 1)));
      await tx
        .update(agentBusMessages)
        .set({ status: 'dead', deadAt: now, lastErrorCode: 'delivery_attempts_exhausted', leaseOwner: null, leaseUntil: null, updatedAt: now })
        .where(and(inArray(agentBusMessages.targetAddressId, targetAddressIds), eq(agentBusMessages.status, 'leased'), lte(agentBusMessages.leaseUntil, now), gt(agentBusMessages.attempts, AGENT_MESSAGING_MAX_DELIVERY_ATTEMPTS - 1)));

      const replayRows = await tx
        .select()
        .from(agentBusMessages)
        .where(and(inArray(agentBusMessages.targetAddressId, targetAddressIds), eq(agentBusMessages.leaseOwner, leaseOwner), eq(agentBusMessages.claimId, claimId), eq(agentBusMessages.status, 'leased')))
        .limit(1)
        .for('update');
      if (replayRows[0]) {
        const target = await this.requireAddressLocked(tx, replayRows[0].targetAddressId);
        const sender = await this.requireAddressLocked(tx, replayRows[0].senderAddressId);
        return { message: replayRows[0], sender, target };
      }

      const candidates = await tx
        .select()
        .from(agentBusMessages)
        .where(and(
          inArray(agentBusMessages.targetAddressId, targetAddressIds),
          eq(agentBusMessages.status, 'queued'),
          lte(agentBusMessages.nextAttemptAt, now),
          gt(agentBusMessages.expiresAt, now),
          sql`NOT EXISTS (
            SELECT 1
              FROM agent_bus_messages AS earlier
             WHERE earlier.target_address_id = ${agentBusMessages.targetAddressId}
               AND earlier.status IN ('queued', 'leased', 'accepted')
               AND earlier.dispatch_order < ${agentBusMessages.dispatchOrder}
          )`,
          sql`NOT EXISTS (
            SELECT 1
              FROM agent_bus_messages AS in_flight
             WHERE in_flight.target_address_id = ${agentBusMessages.targetAddressId}
               AND in_flight.status IN ('leased', 'accepted')
               AND in_flight.id <> ${agentBusMessages.id}
          )`,
        ))
        .orderBy(asc(agentBusMessages.dispatchOrder))
        .limit(64)
        .for('update');
      for (const candidate of candidates) {
        const target = await this.requireAddressLocked(tx, candidate.targetAddressId);
        await this.assertAddressEligibleLocked(tx, target);
        // A relay must never write to a native upstream session while its
        // interactive wrapper is still attached. Receive-capable sessions
        // claim live; non-channel sessions leave work queued until they exit.
        if (skipReceiveCapable && target.currentSessionId) continue;
        const attempts = candidate.attempts + 1;
        await tx
          .update(agentBusMessages)
          .set({
            status: 'leased',
            attempts,
            leaseOwner,
            leaseUntil,
            claimId,
            relayGeneration,
            targetBindingGeneration: target.bindingGeneration,
            deliverySessionId: target.currentSessionId,
            deliveryUpstreamSessionId: target.lastUpstreamSessionId,
            updatedAt: now,
          })
          .where(and(eq(agentBusMessages.id, candidate.id), eq(agentBusMessages.status, 'queued')));
        const sender = await this.requireAddressLocked(tx, candidate.senderAddressId);
        return {
          message: {
            ...candidate,
            status: 'leased',
            attempts,
            leaseOwner,
            leaseUntil,
            claimId,
            relayGeneration,
            targetBindingGeneration: target.bindingGeneration,
            deliverySessionId: target.currentSessionId,
            deliveryUpstreamSessionId: target.lastUpstreamSessionId,
            updatedAt: now,
          },
          sender,
          target,
        };
      }
      return null;
    });
    if (!result) return null;
    return deliveryView(result.message, this.decodeContent(result.message), result.sender, result.target);
  }

  private async renewDelivery(
    messageId: string,
    rawClaimId: string,
    leaseOwner: string,
    relayGeneration: number | null,
  ): Promise<Record<string, unknown>> {
    const id = normalizeUuid(messageId, 'message_id');
    const claimId = normalizeUuid(rawClaimId, 'claim_id');
    const now = nowIso();
    const leaseUntil = isoOffsetSeconds(AGENT_MESSAGING_LEASE_SECONDS);
    const result = await this.db.transaction(async (tx) => {
      await this.requireEnabledLocked(tx);
      if (relayGeneration != null) {
        const relayId = relayIdFromLeaseOwner(leaseOwner);
        if (!relayId) throw new ConflictError('Relay lease owner is invalid', 'agent_messaging_lease_lost');
        await this.requireRelayGenerationLocked(tx, relayId, relayGeneration);
      }
      const rows = await tx.select().from(agentBusMessages).where(eq(agentBusMessages.id, id)).limit(1).for('update');
      const message = rows[0];
      if (!message || (message.status !== 'leased' && message.status !== 'accepted') || message.leaseOwner !== leaseOwner || message.claimId !== claimId) {
        throw new ConflictError('Message lease is no longer owned by this delivery', 'agent_messaging_lease_lost');
      }
      const sessionId = sessionIdFromLeaseOwner(leaseOwner);
      if (sessionId) {
        const target = await this.requireAddressLocked(tx, message.targetAddressId);
        await this.assertSessionAddressLocked(tx, sessionId, target);
        if (message.targetBindingGeneration !== target.bindingGeneration) {
          throw new ConflictError('Agent address binding changed', 'agent_messaging_binding_stale');
        }
      }
      if (message.expiresAt <= now && message.status !== 'accepted') {
        await tx.update(agentBusMessages).set({ status: 'expired', expiredAt: now, leaseOwner: null, leaseUntil: null, updatedAt: now }).where(eq(agentBusMessages.id, id));
        throw new ConflictError('Message expired', 'agent_messaging_message_expired');
      }
      await tx.update(agentBusMessages).set({ leaseUntil, updatedAt: now }).where(eq(agentBusMessages.id, id));
      return message;
    });
    return { message_id: result.id, lease_until: leaseUntil };
  }

  private async acknowledgeDelivery(
    messageId: string,
    input: { claimId: string; outcome: AgentMessagingOutcome; upstreamSessionId?: string | null; errorCode?: string | null; error?: string | null },
    leaseOwner: string,
    relayGeneration: number | null,
    deliverySessionId: string | null,
  ): Promise<Record<string, unknown>> {
    const id = normalizeUuid(messageId, 'message_id');
    const claimId = normalizeUuid(input.claimId, 'claim_id');
    const errorCode = normalizeErrorCode(input.errorCode);
    const errorText = normalizeOptionalText(input.error, 4096);
    const upstreamSessionId = normalizeOptionalText(input.upstreamSessionId, 255);
    const now = nowIso();
    const result = await this.db.transaction(async (tx) => {
      await this.requireEnabledLocked(tx);
      if (relayGeneration != null) {
        const relayId = relayIdFromLeaseOwner(leaseOwner);
        if (!relayId) throw new ConflictError('Relay lease owner is invalid', 'agent_messaging_lease_lost');
        await this.requireRelayGenerationLocked(tx, relayId, relayGeneration);
      }
      const rows = await tx.select().from(agentBusMessages).where(eq(agentBusMessages.id, id)).limit(1).for('update');
      const message = rows[0];
      if (!message) throw new NotFoundError('Message not found', 'agent_messaging_message_not_found');
      if (message.leaseOwner !== leaseOwner || message.claimId !== claimId || (relayGeneration != null && message.relayGeneration !== relayGeneration)) {
        throw new ConflictError('Message lease is no longer owned by this delivery', 'agent_messaging_lease_lost');
      }
      if (TERMINAL_MESSAGE_STATUSES.includes(message.status as (typeof TERMINAL_MESSAGE_STATUSES)[number])) {
        return message;
      }
      if (input.outcome === 'accepted' && message.status === 'accepted') return message;
      if (input.outcome === 'accepted' && message.status !== 'leased') {
        throw new ConflictError('Only a leased message can be accepted', 'agent_messaging_ack_invalid');
      }
      if (input.outcome === 'retry' && message.status === 'accepted') {
        throw new ConflictError('Accepted delivery cannot be retried safely', 'agent_messaging_ack_invalid');
      }
      if (relayGeneration == null && deliverySessionId) {
        const target = await this.requireAddressLocked(tx, message.targetAddressId);
        await this.assertSessionAddressLocked(tx, deliverySessionId, target);
        if (message.targetBindingGeneration !== target.bindingGeneration) {
          throw new ConflictError('Agent address binding changed', 'agent_messaging_binding_stale');
        }
      }
      const shared = {
        deliverySessionId: deliverySessionId ?? message.deliverySessionId,
        deliveryUpstreamSessionId: upstreamSessionId ?? message.deliveryUpstreamSessionId,
        lastErrorCode: errorCode,
        lastErrorEnc: errorText ? encrypt(errorText, this.keyring) : null,
        updatedAt: now,
      };
      let patch: Partial<typeof agentBusMessages.$inferInsert>;
      switch (input.outcome) {
        case 'accepted':
          patch = { ...shared, status: 'accepted', acceptedAt: message.acceptedAt ?? now, leaseUntil: isoOffsetSeconds(AGENT_MESSAGING_LEASE_SECONDS) };
          break;
        case 'completed':
          // Retain the terminal claim identity so an acknowledgement whose
          // response was lost can be retried idempotently. Terminal rows are
          // excluded from every in-flight query, so this is not a live lease.
          patch = { ...shared, status: 'completed', acceptedAt: message.acceptedAt ?? now, completedAt: now, leaseUntil: null };
          break;
        case 'ambiguous':
          patch = { ...shared, status: 'ambiguous', ambiguousAt: now, leaseUntil: null };
          break;
        case 'dead':
          patch = { ...shared, status: 'dead', deadAt: now, leaseUntil: null };
          break;
        case 'retry':
          patch = message.attempts >= AGENT_MESSAGING_MAX_DELIVERY_ATTEMPTS
            ? { ...shared, status: 'dead', deadAt: now, lastErrorCode: errorCode ?? 'delivery_attempts_exhausted', leaseUntil: null }
            : { ...shared, status: 'queued', nextAttemptAt: isoOffsetSeconds(deliveryBackoffSeconds(message.attempts)), leaseOwner: null, leaseUntil: null, claimId: null, relayGeneration: null };
          break;
      }
      await tx.update(agentBusMessages).set(patch).where(eq(agentBusMessages.id, id));
      if (upstreamSessionId && input.outcome !== 'retry' && input.outcome !== 'dead') {
        const targetRows = await tx
          .select()
          .from(agentBusAddresses)
          .where(eq(agentBusAddresses.id, message.targetAddressId))
          .limit(1)
          .for('update');
        const target = targetRows[0];
        if (target) {
          await tx
            .update(agentBusAddresses)
            .set({
              lastUpstreamSessionId: upstreamSessionId,
              continuity: 'native',
              readiness: target.currentSessionId ? target.readiness : 'resumable',
              lastSeenAt: now,
              updatedAt: now,
            })
            .where(eq(agentBusAddresses.id, target.id));
        }
      }
      return { ...message, ...patch } as AgentBusMessage;
    });
    const targetRows = await this.db.select({ hostId: agentBusAddresses.hostId }).from(agentBusAddresses).where(eq(agentBusAddresses.id, result.targetAddressId)).limit(1);
    const action = result.status === 'completed' ? 'agent_message.completed' : result.status === 'dead' ? 'agent_message.dead' : result.status === 'ambiguous' ? 'agent_message.ambiguous' : 'agent_message.delivery';
    await this.recordRuntime(action, targetRows[0]?.hostId ?? null, result.targetEngine, {
      message_id: result.id,
      conversation_id: result.conversationId,
      status: result.status,
      attempts: result.attempts,
      error_code: result.lastErrorCode,
    });
    wsPublisher.publish('agent_messaging.message.changed', { message_id: result.id, conversation_id: result.conversationId, status: result.status });
    return { message: messageMetadata(result) };
  }

  private async cancelConversationInternal(
    conversationId: string,
    canceledBy: string,
    reason: string,
    participantAddressId?: string,
    participantSessionId?: string,
  ): Promise<Record<string, unknown>> {
    const now = nowIso();
    return await this.db.transaction(async (tx) => {
      await this.requireEnabledLocked(tx);
      if (participantAddressId && participantSessionId) {
        const address = await this.requireAddressLocked(tx, participantAddressId);
        await this.assertSessionAddressLocked(tx, participantSessionId, address);
      }
      const conversation = await this.requireConversationLocked(tx, conversationId);
      if (participantAddressId && !conversationIncludes(conversation, participantAddressId)) {
        throw new NotFoundError('Conversation not found', 'agent_messaging_conversation_not_found');
      }
      if (conversation.status === 'canceled') return { conversation: conversationMetadata(conversation), canceled_messages: 0 };
      const [rows, uncertain] = await Promise.all([
        tx.select({ value: count() }).from(agentBusMessages).where(and(eq(agentBusMessages.conversationId, conversationId), inArray(agentBusMessages.status, [...CANCELABLE_MESSAGE_STATUSES]))),
        tx.select({ value: count() }).from(agentBusMessages).where(and(eq(agentBusMessages.conversationId, conversationId), eq(agentBusMessages.status, 'accepted'))),
      ]);
      await tx
        .update(agentBusConversations)
        .set({ status: 'canceled', canceledBy: normalizeOptionalText(canceledBy, 191), cancelReason: normalizeOptionalText(reason, 255), canceledAt: now, updatedAt: now })
        .where(eq(agentBusConversations.id, conversationId));
      await tx
        .update(agentBusMessages)
        .set({ status: 'canceled', cancelRequestedAt: now, canceledAt: now, leaseOwner: null, leaseUntil: null, updatedAt: now })
        .where(and(eq(agentBusMessages.conversationId, conversationId), inArray(agentBusMessages.status, [...CANCELABLE_MESSAGE_STATUSES])));
      await tx
        .update(agentBusMessages)
        .set({ status: 'ambiguous', ambiguousAt: now, lastErrorCode: 'conversation_canceled_after_accept', leaseOwner: null, leaseUntil: null, updatedAt: now })
        .where(and(eq(agentBusMessages.conversationId, conversationId), eq(agentBusMessages.status, 'accepted')));
      return {
        conversation: { ...conversationMetadata(conversation), status: 'canceled', canceled_at: now },
        canceled_messages: Number(rows[0]?.value ?? 0),
        ambiguous_messages: Number(uncertain[0]?.value ?? 0),
      };
    });
  }

  private async authenticateBridge(sessionId: string, rawToken: string, allowEnded = false): Promise<{ session: AgentSession; host: Host }> {
    await this.requireEnabled();
    const id = normalizeUuid(sessionId, 'session_id');
    const rows = await this.db
      .select({ session: agentSessions, host: hosts })
      .from(agentSessions)
      .innerJoin(hosts, eq(hosts.id, agentSessions.hostId))
      .where(eq(agentSessions.id, id))
      .limit(1);
    const row = rows[0];
    if (!row || !safeHashEqual(sha256(rawToken ?? ''), row.session.bridgeTokenHash)) {
      throw new UnauthorizedError('Invalid agent bridge credential', 'agent_bridge_unauthorized');
    }
    this.assertEligibleHost(row.host);
    if (!safeHashEqual(hostAuthFingerprint(row.host), row.session.hostAuthFingerprint)) {
      throw new UnauthorizedError('Agent bridge host credential changed', 'agent_bridge_host_auth_changed');
    }
    if (!hostEnginesList(row.host.engines).includes(row.session.engine as Engine)) {
      throw new ForbiddenError(`Engine ${row.session.engine} is disabled for this host`, 'engine_disabled');
    }
    if (row.session.endedAt && !allowEnded) throw new ConflictError('Agent session is finished', 'agent_session_finished');
    if (!row.session.endedAt && row.session.bridgeExpiresAt <= nowIso()) throw new UnauthorizedError('Agent bridge credential expired', 'agent_bridge_expired');
    return row;
  }

  private async authenticateRelay(relayId: string, rawToken: string): Promise<AgentBusRelay> {
    await this.requireEnabled();
    const id = normalizeUuid(relayId, 'relay_id');
    const rows = await this.db
      .select({ relay: agentBusRelays, host: hosts })
      .from(agentBusRelays)
      .innerJoin(hosts, eq(hosts.id, agentBusRelays.hostId))
      .where(eq(agentBusRelays.id, id))
      .limit(1);
    const row = rows[0];
    if (!row || row.relay.status !== 'active' || !row.relay.tokenHash || !safeHashEqual(sha256(rawToken ?? ''), row.relay.tokenHash)) {
      throw new UnauthorizedError('Invalid agent relay credential', 'agent_messaging_relay_unauthorized');
    }
    this.assertEligibleHost(row.host);
    if (row.relay.tokenExpiresAt == null || row.relay.tokenExpiresAt <= nowIso()) throw new UnauthorizedError('Agent relay credential expired', 'agent_messaging_relay_expired');
    if (!safeHashEqual(hostAuthFingerprint(row.host), row.relay.hostAuthFingerprint)) throw new UnauthorizedError('Agent relay host credential changed', 'agent_messaging_relay_host_auth_changed');
    return row.relay;
  }

  private async requireBridgeSessionLocked(db: AgentMessagingDb, sessionId: string, rawToken: string, hostId: number): Promise<AgentSession> {
    const rows = await db.select().from(agentSessions).where(eq(agentSessions.id, sessionId)).limit(1).for('update');
    const session = rows[0];
    if (!session || session.hostId !== hostId || !safeHashEqual(sha256(rawToken ?? ''), session.bridgeTokenHash)) {
      throw new UnauthorizedError('Invalid agent bridge credential', 'agent_bridge_unauthorized');
    }
    if (session.endedAt) throw new ConflictError('Agent session is finished', 'agent_session_finished');
    return session;
  }

  private async requireAddressLocked(db: AgentMessagingDb, id: string): Promise<AgentBusAddress> {
    const rows = await db.select().from(agentBusAddresses).where(eq(agentBusAddresses.id, id)).limit(1).for('update');
    const address = rows[0];
    if (!address) throw new NotFoundError('Agent address not found', 'agent_messaging_address_not_found');
    return address;
  }

  private async resolveAddressLocked(db: AgentMessagingDb, raw: string, forUpdate: boolean): Promise<AgentBusAddress> {
    const value = String(raw ?? '').trim().toLowerCase();
    if (!value) throw new ValidationError('to is required', { param: 'to' });
    const query = db
      .select()
      .from(agentBusAddresses)
      .where(or(eq(agentBusAddresses.address, value), eq(agentBusAddresses.displayAlias, value)))
      .limit(1);
    const rows = forUpdate ? await query.for('update') : await query;
    const address = rows[0];
    if (!address || address.archivedAt || address.enabled !== 1) {
      throw new NotFoundError('Agent address not found', 'agent_messaging_address_not_found');
    }
    return address;
  }

  private async requireConversationLocked(db: AgentMessagingDb, id: string): Promise<AgentBusConversation> {
    const rows = await db.select().from(agentBusConversations).where(eq(agentBusConversations.id, id)).limit(1).for('update');
    const conversation = rows[0];
    if (!conversation) throw new NotFoundError('Conversation not found', 'agent_messaging_conversation_not_found');
    return conversation;
  }

  private async assertAddressEligibleLocked(db: AgentMessagingDb, address: AgentBusAddress): Promise<void> {
    if (address.enabled !== 1 || address.archivedAt) throw new NotFoundError('Agent address not found', 'agent_messaging_address_not_found');
    const rows = await db.select().from(hosts).where(eq(hosts.id, address.hostId)).limit(1).for('update');
    if (!rows[0] || !messagingHostEligible(rows[0])) {
      throw new NotFoundError('Agent address not found', 'agent_messaging_address_not_found');
    }
    if (!hostEnginesList(rows[0].engines).includes(address.engine as Engine)) {
      throw new NotFoundError('Agent address not found', 'agent_messaging_address_not_found');
    }
  }

  private assertEligibleHost(host: Host): void {
    if (!messagingHostEligible(host)) {
      throw new ForbiddenError(
        host.secure === 1
          ? 'Agent Messaging requires an active host'
          : 'Agent Messaging on an insecure host requires an open allowed window',
        host.secure === 1 ? 'agent_messaging_host_ineligible' : 'agent_messaging_insecure_window_closed',
      );
    }
  }

  private assertSessionRegistration(
    session: AgentSession,
    host: Host,
    engine: Engine,
    username: string,
    cwd: string,
    invocationKind: string,
    bridgeToken: string,
  ): void {
    if (
      session.hostId !== host.id ||
      session.engine !== engine ||
      session.username !== username ||
      session.cwd !== cwd ||
      session.invocationKind !== invocationKind ||
      !safeHashEqual(sha256(bridgeToken), session.bridgeTokenHash)
    ) {
      throw new ConflictError('Agent session registration conflicts with an existing session', 'agent_session_conflict');
    }
  }

  private assertAddressRegistration(address: AgentBusAddress, host: Host, engine: Engine, username: string, cwd: string): void {
    if (address.hostId !== host.id || address.engine !== engine || address.username !== username || address.cwd !== cwd || address.archivedAt || address.enabled !== 1) {
      throw new ForbiddenError('Agent address cannot be rebound by this lifecycle', 'agent_messaging_address_mismatch');
    }
  }

  private assertConversationParticipants(conversation: AgentBusConversation, first: string, second: string): void {
    if (!conversationIncludes(conversation, first) || !conversationIncludes(conversation, second) || first === second) {
      throw new NotFoundError('Conversation not found', 'agent_messaging_conversation_not_found');
    }
  }

  private assertMessageIdempotency(
    row: AgentBusMessage,
    targetAddressId: string,
    conversationId: string | null,
    replyToMessageId: string | null,
    content: string,
    kind: string,
  ): void {
    if (
      row.targetAddressId !== targetAddressId ||
      (conversationId != null && row.conversationId !== conversationId) ||
      row.replyToMessageId !== replyToMessageId ||
      row.kind !== kind ||
      this.decodeContent(row) !== content
    ) {
      throw new ConflictError('client_message_id was already used for different content', 'agent_messaging_client_message_id_conflict');
    }
  }

  private decodeContent(message: Pick<AgentBusMessage, 'contentEnc'>): string {
    return decrypt(message.contentEnc, this.keyring);
  }

  private async addressMap(ids: string[]): Promise<Map<string, AgentBusAddress>> {
    const unique = [...new Set(ids)];
    if (unique.length === 0) return new Map();
    const rows = await this.db.select().from(agentBusAddresses).where(inArray(agentBusAddresses.id, unique));
    return new Map(rows.map((row) => [row.id, row]));
  }

  private async requireEnabled(): Promise<void> {
    if (!(await this.isEnabled())) throw new ServiceUnavailableError('Agent Messaging is disabled', 'agent_messaging_disabled');
  }

  private async requireEnabledLocked(db: AgentMessagingDb): Promise<void> {
    const rows = await db
      .select({ version: versions.version })
      .from(versions)
      .where(eq(versions.name, AGENT_MESSAGING_ENABLED_KEY))
      .limit(1)
      .for('update');
    if (!isTruthyFlagValue(rows[0]?.version, false)) {
      throw new ServiceUnavailableError('Agent Messaging is disabled', 'agent_messaging_disabled');
    }
  }

  private async requireEligibleHostLocked(db: AgentMessagingDb, hostId: number): Promise<Host> {
    const rows = await db.select().from(hosts).where(eq(hosts.id, hostId)).limit(1).for('update');
    const host = rows[0];
    if (!host) throw new NotFoundError('Host not found', 'host_not_found');
    this.assertEligibleHost(host);
    return host;
  }

  private async requireRelayGenerationLocked(
    db: AgentMessagingDb,
    relayId: string,
    generation: number,
  ): Promise<AgentBusRelay> {
    const rows = await db.select().from(agentBusRelays).where(eq(agentBusRelays.id, relayId)).limit(1).for('update');
    const relay = rows[0];
    if (!relay || relay.status !== 'active' || relay.generation !== generation) {
      throw new ConflictError('Agent relay generation changed', 'agent_messaging_lease_lost');
    }
    return relay;
  }

  private async assertSessionAddressLocked(
    db: AgentMessagingDb,
    sessionId: string,
    address: AgentBusAddress,
  ): Promise<void> {
    const rows = await db.select().from(agentSessions).where(eq(agentSessions.id, sessionId)).limit(1).for('update');
    const session = rows[0];
    if (
      !session ||
      session.endedAt ||
      session.agentBusAddressId !== address.id ||
      address.currentSessionId !== sessionId ||
      address.enabled !== 1 ||
      address.archivedAt
    ) {
      throw new ConflictError('Agent address binding changed', 'agent_messaging_binding_stale');
    }
    await this.assertAddressEligibleLocked(db, address);
  }

  private async recordRuntime(action: string, hostId: number | null, engine: string, details: Record<string, unknown>): Promise<void> {
    await this.db.insert(logs).values({
      hostId,
      action,
      details: JSON.stringify(details),
      engine,
      createdAt: nowIso(),
    });
  }
}

/**
 * Apply the destructive half of an eligibility transition inside the caller's
 * transaction. Host security, engine, uninstall, and pruning code use this
 * primitive so their host-row mutation cannot commit while bus cleanup fails.
 */
export async function suspendAgentMessagingRuntimeLocked(
  db: AgentMessagingDb,
  hostId: number,
  reason: 'host_inactive' | 'host_auth_rotated' | 'engine_disabled',
  engines?: Engine[],
): Promise<{ canceled: number; ambiguous: number; conversations: number; relays: number; bindings: number }> {
  const now = nowIso();
  const hostRows = await db.select().from(hosts).where(eq(hosts.id, hostId)).limit(1).for('update');
  if (!hostRows[0]) throw new NotFoundError('Host not found', 'host_not_found');
  const addressPredicate = engines?.length
    ? and(eq(agentBusAddresses.hostId, hostId), inArray(agentBusAddresses.engine, engines))
    : eq(agentBusAddresses.hostId, hostId);
  const addressRows = await db
    .select({ id: agentBusAddresses.id })
    .from(agentBusAddresses)
    .where(addressPredicate)
    .for('update');
  const addressIds = addressRows.map((row) => row.id);
  let canceled = 0;
  let ambiguous = 0;
  let conversations = 0;
  if (addressIds.length > 0) {
    const messageScope = or(
      inArray(agentBusMessages.senderAddressId, addressIds),
      inArray(agentBusMessages.targetAddressId, addressIds),
    );
    const conversationScope = or(
      inArray(agentBusConversations.addressAId, addressIds),
      inArray(agentBusConversations.addressBId, addressIds),
    );
    const [pending, uncertain, open] = await Promise.all([
      db.select({ value: count() }).from(agentBusMessages).where(and(inArray(agentBusMessages.status, [...CANCELABLE_MESSAGE_STATUSES]), messageScope)),
      db.select({ value: count() }).from(agentBusMessages).where(and(eq(agentBusMessages.status, 'accepted'), messageScope)),
      db.select({ value: count() }).from(agentBusConversations).where(and(eq(agentBusConversations.status, 'open'), conversationScope)),
    ]);
    canceled = Number(pending[0]?.value ?? 0);
    ambiguous = Number(uncertain[0]?.value ?? 0);
    conversations = Number(open[0]?.value ?? 0);
    await db
      .update(agentBusMessages)
      .set({ status: 'canceled', cancelRequestedAt: now, canceledAt: now, leaseOwner: null, leaseUntil: null, updatedAt: now })
      .where(and(inArray(agentBusMessages.status, [...CANCELABLE_MESSAGE_STATUSES]), messageScope));
    await db
      .update(agentBusMessages)
      .set({ status: 'ambiguous', ambiguousAt: now, lastErrorCode: `${reason}_after_accept`, leaseOwner: null, leaseUntil: null, updatedAt: now })
      .where(and(eq(agentBusMessages.status, 'accepted'), messageScope));
    await db
      .update(agentBusConversations)
      .set({
        status: 'canceled',
        canceledBy: `system:${reason}`,
        cancelReason: reason === 'engine_disabled'
          ? 'Agent engine disabled for host'
          : 'Host is no longer eligible for Agent Messaging',
        canceledAt: now,
        updatedAt: now,
      })
      .where(and(eq(agentBusConversations.status, 'open'), conversationScope));
    // Conferences outlive individual conversations, so cancelling the spokes is
    // not enough: a room whose chair has just been made ineligible would stay
    // `open` forever, holding its PIN and admitting joiners to a meeting nobody
    // can run. Close the rooms these addresses chair, and seat-release them from
    // any room they merely attend.
    await db
      .update(agentBusConferences)
      .set({
        status: 'adjourned',
        adjournReason: reason === 'engine_disabled' ? 'Agent engine disabled for host' : 'Host is no longer eligible for Agent Messaging',
        adjournedAt: now,
        pin: null,
        pinExpiresAt: null,
        updatedAt: now,
      })
      .where(and(ne(agentBusConferences.status, 'adjourned'), inArray(agentBusConferences.ownerAddressId, addressIds)));
    await db
      .update(agentBusConferenceMembers)
      .set({ state: 'left', leftAt: now, dispatchMessageId: null, dispatchDeadlineAt: null, updatedAt: now })
      .where(and(ne(agentBusConferenceMembers.state, 'left'), inArray(agentBusConferenceMembers.addressId, addressIds)));
    await db
      .update(agentBusAddresses)
      .set({
        currentSessionId: null,
        readiness: 'disabled',
        receiveHeartbeatAt: null,
        bindingGeneration: sql`${agentBusAddresses.bindingGeneration} + 1`,
        updatedAt: now,
      })
      .where(inArray(agentBusAddresses.id, addressIds));
    await db
      .update(agentSessions)
      .set({
        adapterProtocol: null,
        adapterCapabilities: null,
        receiveHeartbeatAt: null,
        bindingGeneration: sql`${agentSessions.bindingGeneration} + 1`,
        updatedAt: now,
      })
      .where(inArray(agentSessions.agentBusAddressId, addressIds));
  }
  const relayRows = engines?.length
    ? [{ value: 0 }]
    : await db.select({ value: count() }).from(agentBusRelays).where(and(eq(agentBusRelays.hostId, hostId), eq(agentBusRelays.status, 'active')));
  if (!engines?.length) {
    await db
      .update(agentBusRelays)
      .set({ status: 'revoked', tokenHash: null, tokenExpiresAt: null, stopRequestedAt: now, updatedAt: now })
      .where(and(eq(agentBusRelays.hostId, hostId), eq(agentBusRelays.status, 'active')));
  }
  return {
    canceled,
    ambiguous,
    conversations,
    relays: Number(relayRows[0]?.value ?? 0),
    bindings: addressIds.length,
  };
}

export async function releaseAgentMessagingBindingsLocked(
  db: AgentMessagingDb,
  sessionIds: string[],
  now = nowIso(),
): Promise<number> {
  if (sessionIds.length === 0) return 0;
  const rows = await db
    .select({ address: agentBusAddresses, session: agentSessions })
    .from(agentBusAddresses)
    .innerJoin(agentSessions, eq(agentSessions.id, agentBusAddresses.currentSessionId))
    .where(inArray(agentSessions.id, sessionIds))
    .for('update');
  for (const row of rows) {
    const upstream = row.session.upstreamSessionId ?? row.address.lastUpstreamSessionId;
    await db
      .update(agentBusAddresses)
      .set({
        currentSessionId: null,
        lastUpstreamSessionId: upstream,
        adapterProtocol: null,
        adapterCapabilities: null,
        readiness: upstream ? 'resumable' : 'offline',
        receiveHeartbeatAt: null,
        // Same reason as finishSession: a reaped binding must not leave a live
        // PIN pointing at an address that is no longer on the line.
        callPin: null,
        callPinExpiresAt: null,
        bindingGeneration: row.address.bindingGeneration + 1,
        lastSeenAt: now,
        updatedAt: now,
      })
      .where(and(eq(agentBusAddresses.id, row.address.id), eq(agentBusAddresses.currentSessionId, row.session.id)));
  }
  const boundSessionIds = rows.map((row) => row.session.id);
  if (boundSessionIds.length > 0) {
    await db
      .update(agentSessions)
      .set({
        adapterProtocol: null,
        adapterCapabilities: null,
        receiveHeartbeatAt: null,
        bindingGeneration: sql`${agentSessions.bindingGeneration} + 1`,
        updatedAt: now,
      })
      .where(inArray(agentSessions.id, boundSessionIds));
  }
  return rows.length;
}

export async function reapExpiredAgentMessagingBindingsLocked(
  db: AgentMessagingDb,
  now = nowIso(),
  scope: { hostId?: number; engine?: Engine; username?: string } = {},
): Promise<number> {
  const predicates = [
    or(isNotNull(agentSessions.endedAt), lte(agentSessions.bridgeExpiresAt, now)),
  ];
  if (scope.hostId != null) predicates.push(eq(agentBusAddresses.hostId, scope.hostId));
  if (scope.engine) predicates.push(eq(agentBusAddresses.engine, scope.engine));
  if (scope.username) predicates.push(eq(agentBusAddresses.username, scope.username));
  const rows = await db
    .select({ sessionId: agentSessions.id })
    .from(agentBusAddresses)
    .innerJoin(agentSessions, eq(agentSessions.id, agentBusAddresses.currentSessionId))
    .where(and(...predicates))
    .for('update');
  return await releaseAgentMessagingBindingsLocked(
    db,
    [...new Set(rows.map((row) => row.sessionId))],
    now,
  );
}

export function createAgentMessagingService(db: Database, env: Env, keyring: Keyring): AgentMessagingService {
  return new AgentMessagingService(db, env, keyring);
}

/**
 * One queued message row, with every column that has no per-call meaning set to
 * its neutral value.
 *
 * `sendMessage`, `replyMessage`, `replyFromRelayDelivery` and `redriveMessage`
 * each carry their own hand-written copy of this 30-field literal. Those are
 * left alone; this exists so `joinCall` does not become the fifth.
 */
function newQueuedMessage(input: {
  id: string;
  conversationId: string;
  sequence: number;
  sender: AgentBusAddress;
  senderSessionId: string | null;
  target: AgentBusAddress;
  kind: string;
  content: string;
  contentEnc: string;
  clientMessageId: string;
  expiresAt: string;
  now: string;
}): typeof agentBusMessages.$inferInsert {
  return {
    id: input.id,
    conversationId: input.conversationId,
    sequence: input.sequence,
    replyToMessageId: null,
    redriveOfMessageId: null,
    senderAddressId: input.sender.id,
    senderSessionId: input.senderSessionId,
    targetAddressId: input.target.id,
    sourceEngine: input.sender.engine,
    targetEngine: input.target.engine,
    kind: input.kind,
    contentEnc: input.contentEnc,
    contentBytes: Buffer.byteLength(input.content, 'utf8'),
    clientMessageId: input.clientMessageId,
    status: 'queued',
    attempts: 0,
    nextAttemptAt: input.now,
    leaseOwner: null,
    leaseUntil: null,
    claimId: null,
    relayGeneration: null,
    targetBindingGeneration: null,
    deliverySessionId: null,
    deliveryUpstreamSessionId: null,
    expiresAt: input.expiresAt,
    lastErrorCode: null,
    lastErrorEnc: null,
    cancelRequestedAt: null,
    acceptedAt: null,
    completedAt: null,
    ambiguousAt: null,
    deadAt: null,
    expiredAt: null,
    canceledAt: null,
    createdAt: input.now,
    updatedAt: input.now,
  };
}

/**
 * The wire envelope: `CONF/1 <VERB> k=v ...` on the first line, free text below.
 *
 * Composed server-side so the conference id always travels with the message. A
 * relay-woken member is a fresh process whose entire context is the prompt it
 * was booted with -- if the id were left to the sender to remember to include,
 * a headless participant would have no way to call `agent_conf_join` and answer.
 *
 * Values are sanitised to a single line: the header is exactly the first line,
 * so a newline smuggled into a topic would push the body up into the header and
 * change how a peer parses the whole message.
 */
function conferenceEnvelope(
  verb: string,
  headers: Record<string, string | number | null | undefined>,
  body: string,
): string {
  const parts = [`CONF/1 ${verb}`];
  for (const [key, value] of Object.entries(headers)) {
    if (value === null || value === undefined || value === '') continue;
    parts.push(`${key}=${String(value).replace(/[\r\n]+/g, ' ').trim()}`);
  }
  const header = parts.join(' ');
  const text = body.trim();
  return text ? `${header}\n${text}` : header;
}

function conferenceInviteBody(conference: AgentBusConference, note: string): string {
  const lines = [
    `You are invited to a conference chaired by another agent.`,
    conference.topic ? `Topic: ${conference.topic}` : null,
    conference.purpose ? `Purpose: ${conference.purpose}` : null,
    '',
    `To accept, call agent_conf_join with conference_id="${conference.id}" and a short purpose`,
    `describing what you bring. The chair runs the room: it dispatches tasks and adjourns.`,
    `Reply to this message to decline.`,
    note ? `\n${note}` : null,
  ];
  return lines.filter((line) => line !== null).join('\n');
}

/**
 * A conference message must not outlive the room it belongs to, and must still
 * satisfy the bus's own TTL bounds.
 */
function conferenceMessageExpiry(conference: AgentBusConference, now: string): string {
  const remaining = Math.ceil((Date.parse(conference.deadlineAt) - Date.parse(now)) / 1000);
  const ttl = Math.min(
    AGENT_MESSAGING_MAX_TTL_SECONDS,
    Math.max(AGENT_MESSAGING_MIN_TTL_SECONDS, Number.isFinite(remaining) ? remaining : AGENT_MESSAGING_MIN_TTL_SECONDS),
  );
  return isoOffsetSeconds(ttl);
}

/**
 * Roster projection.
 *
 * `fqdn` and `engine` are read off the joined host and address rather than off
 * the member row, because a member declares only its `purpose`. Everything else
 * about who it is comes from what the fleet already knows, so a participant
 * cannot misreport the box it is running on.
 */
function publicConferenceMember(
  member: AgentBusConferenceMember,
  address: AgentBusAddress,
  fqdn: string | null,
): Record<string, unknown> {
  return {
    address: address.address,
    alias: address.displayAlias,
    engine: address.engine,
    fqdn,
    username: address.username,
    cwd: address.cwd,
    role: member.role,
    purpose: member.purpose,
    mode: member.mode,
    state: member.state,
    messages_used: member.messageCount,
    messages_budget: AGENT_MESSAGING_CONFERENCE_MEMBER_MESSAGE_CAP,
    dispatched_at: member.dispatchedAt,
    dispatch_deadline_at: member.dispatchDeadlineAt,
    last_report_at: member.lastReportAt,
    joined_at: member.joinedAt,
  };
}

/** Fan-out reports per member, so a caller needs the code without the stack. */
function errorCodeOf(error: unknown): string {
  const code = (error as { code?: unknown })?.code;
  return typeof code === 'string' ? code : 'agent_messaging_conference_send_failed';
}

function errorMessageOf(error: unknown): string {
  const message = (error as { message?: unknown })?.message;
  return typeof message === 'string' ? message : 'Delivery failed';
}

/**
 * `presence` is supplied only by the surfaces that enumerate peers, because it
 * is the one field here that cannot be read off the address row — deriving it
 * needs the joined session. Point payloads (a registration ack, the peer on a
 * call) omit it rather than guess: an absent field is honest, a stale one is
 * the bug this whole change removes. `readiness` is retained on the wire for
 * compatibility and carries no liveness meaning for a non-relay session.
 */
function publicAddress(address: AgentBusAddress, fqdn?: string, presence?: AgentAddressPresence): Record<string, unknown> {
  return {
    id: address.id,
    address: address.address,
    alias: address.displayAlias,
    engine: address.engine,
    host_id: address.hostId,
    ...(fqdn ? { fqdn } : {}),
    username: address.username,
    cwd: address.cwd,
    enabled: address.enabled === 1,
    continuity: address.continuity,
    ...(presence ? { presence } : {}),
    readiness: address.readiness,
    adapter_protocol: address.adapterProtocol,
    adapter_capabilities: jsonRecord(address.adapterCapabilities),
    binding_generation: address.bindingGeneration,
    receive_heartbeat_at: address.receiveHeartbeatAt,
    last_seen_at: address.lastSeenAt,
    created_at: address.createdAt,
  };
}

function messageMetadata(message: AgentBusMessage, sender?: AgentBusAddress, target?: AgentBusAddress): Record<string, unknown> {
  return {
    id: message.id,
    conversation_id: message.conversationId,
    sequence: message.sequence,
    reply_to_message_id: message.replyToMessageId,
    redrive_of_message_id: message.redriveOfMessageId,
    sender: sender ? publicAddress(sender) : { id: message.senderAddressId, engine: message.sourceEngine },
    target: target ? publicAddress(target) : { id: message.targetAddressId, engine: message.targetEngine },
    kind: message.kind,
    content_bytes: message.contentBytes,
    status: message.status,
    attempts: message.attempts,
    expires_at: message.expiresAt,
    last_error_code: message.lastErrorCode,
    accepted_at: message.acceptedAt,
    completed_at: message.completedAt,
    ambiguous_at: message.ambiguousAt,
    dead_at: message.deadAt,
    expired_at: message.expiredAt,
    canceled_at: message.canceledAt,
    created_at: message.createdAt,
    updated_at: message.updatedAt,
  };
}

function messageForParticipant(message: AgentBusMessage, content: string, sender: AgentBusAddress, target: AgentBusAddress): Record<string, unknown> {
  return { ...messageMetadata(message, sender, target), content };
}

function deliveryView(message: AgentBusMessage, content: string, sender: AgentBusAddress, target: AgentBusAddress): MessageDelivery {
  return {
    message_id: message.id,
    conversation_id: message.conversationId,
    sequence: message.sequence,
    reply_to_message_id: message.replyToMessageId,
    kind: message.kind,
    content,
    content_bytes: message.contentBytes,
    sender: publicAddress(sender),
    target: {
      ...publicAddress(target),
      upstream_session_id: target.lastUpstreamSessionId,
    },
    attempts: message.attempts,
    claim_id: message.claimId!,
    lease_owner: message.leaseOwner!,
    lease_until: message.leaseUntil!,
    expires_at: message.expiresAt,
  };
}

function conversationMetadata(conversation: AgentBusConversation): Record<string, unknown> {
  return {
    id: conversation.id,
    address_a_id: conversation.addressAId,
    address_b_id: conversation.addressBId,
    created_by_address_id: conversation.createdByAddressId,
    status: conversation.status,
    next_sequence: conversation.nextSequence,
    last_activity_at: conversation.lastActivityAt,
    canceled_by: conversation.canceledBy,
    cancel_reason: conversation.cancelReason,
    canceled_at: conversation.canceledAt,
    created_at: conversation.createdAt,
    updated_at: conversation.updatedAt,
  };
}

function conversationIncludes(conversation: AgentBusConversation, addressId: string): boolean {
  return conversation.addressAId === addressId || conversation.addressBId === addressId;
}

/**
 * The single host-eligibility rule for Agent Messaging. The fleet switch is
 * the only switch: once it is on the bus is on for every host, including
 * insecure ones. An insecure host is authorized per operation for as long as
 * its allowed window is open, which is read, never extended — see
 * `insecureWindowActive`. Status and engine remain gates because an inactive
 * host or a removed engine has no agent to address.
 */
export function messagingHostEligible(
  host: Pick<Host, 'status' | 'secure' | 'insecureEnabledUntil'>,
): boolean {
  return host.status === 'active' && (host.secure === 1 || insecureWindowActive(host));
}

/**
 * The SQL half of `messagingHostEligible`, for queries that select candidate
 * hosts instead of checking one row. `gt` is given a `Date` on purpose:
 * drizzle's `datetime` column maps it through `toISOString()`, matching how
 * the window was stored. Passing an ISO string here would compare the `T`/`Z`
 * form against a MySQL DATETIME and silently return the wrong host set.
 *
 * Exported so the fleet-window suite can assert against the real predicate:
 * being SQL, it cannot consult the fleet-window settings key and is only right
 * if the deadline stamped on the host row is right, which is precisely what a
 * DB-less fake cannot check.
 */
export function messagingHostEligibleSql(now: Date = new Date()) {
  return and(
    eq(hosts.status, 'active'),
    or(eq(hosts.secure, 1), gt(hosts.insecureEnabledUntil, now)),
  );
}

function addressIneligibleReason(
  masterEnabled: boolean,
  eligible: boolean,
  secure: boolean,
  hostStatus: string,
  engines: Engine[],
  engine: Engine,
): string | null {
  if (!masterEnabled) return 'master_disabled';
  if (hostStatus !== 'active') return 'host_inactive';
  if (!secure && !eligible) return 'insecure_window_closed';
  if (!engines.includes(engine)) return 'engine_disabled';
  return null;
}

function relayIdFromLeaseOwner(value: string): string | null {
  const match = /^relay:([0-9a-f-]{36}):\d+$/.exec(value);
  return match?.[1] && UUID_RE.test(match[1]) ? match[1] : null;
}

function sessionIdFromLeaseOwner(value: string): string | null {
  const match = /^session:([0-9a-f-]{36})$/.exec(value);
  return match?.[1] && UUID_RE.test(match[1]) ? match[1] : null;
}

function normalizeRequiredText(value: unknown, param: string, maxBytes: number): string {
  if (typeof value !== 'string' || !value.trim()) throw new ValidationError(`${param} is required`, { param });
  const normalized = value.trim();
  if (Buffer.byteLength(normalized, 'utf8') > maxBytes) throw new ValidationError(`${param} is too long`, { param });
  return normalized;
}

function normalizeOptionalText(value: unknown, maxBytes: number): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  if (!normalized) return null;
  if (Buffer.byteLength(normalized, 'utf8') > maxBytes) throw new ValidationError('text is too long');
  return normalized;
}

function normalizeUuid(value: unknown, param: string): string {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (!UUID_RE.test(normalized)) throw new ValidationError(`${param} must be a UUID`, { param });
  return normalized;
}

function normalizeBridgeToken(value: unknown): string {
  const token = String(value ?? '').trim();
  if (token.length < 43 || token.length > 128 || !/^[A-Za-z0-9_-]+$/.test(token)) {
    throw new ValidationError('bridge_token must be a 43-128 character base64url value', { param: 'bridge_token' });
  }
  return token;
}

export function normalizeAgentAlias(value: unknown): string | null {
  if (value === null || value === undefined || String(value).trim() === '') return null;
  const normalized = String(value).trim().toLowerCase();
  if (!/^(?:agent:)?[a-z0-9][a-z0-9._-]{0,63}$/.test(normalized)) {
    throw new ValidationError('alias must use lowercase letters, digits, dot, underscore or dash', { param: 'alias' });
  }
  const alias = normalized.startsWith('agent:') ? normalized : `agent:${normalized}`;
  if (UUID_RE.test(alias.slice('agent:'.length))) {
    throw new ValidationError('alias cannot use the reserved canonical address format', { param: 'alias' });
  }
  return alias;
}

function normalizeErrorCode(value: unknown): string | null {
  if (value === null || value === undefined || String(value).trim() === '') return null;
  const normalized = String(value).trim().toLowerCase().replace(/[^a-z0-9._-]/g, '_').slice(0, 64);
  return normalized || null;
}

function normalizeSessionStatus(value: unknown): string | null {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return ['starting', 'active', 'waiting', 'offline'].includes(normalized) ? normalized : null;
}

function jsonRecord(value: unknown): Record<string, unknown> | null {
  if (!value) return null;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value) as unknown;
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  }
  return typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function safeHashEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'hex');
  const right = Buffer.from(b, 'hex');
  return left.length === right.length && left.length > 0 && timingSafeEqual(left, right);
}

function hostAuthFingerprint(host: Pick<Host, 'apiKey' | 'apiKeyHash'>): string {
  return sha256(host.apiKeyHash || host.apiKey);
}

function isDuplicateKeyError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as { code?: unknown; errno?: unknown };
  return candidate.code === 'ER_DUP_ENTRY' || candidate.errno === 1062;
}
