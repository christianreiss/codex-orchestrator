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
  agentBusConversations,
  agentBusMessages,
  agentBusRelays,
  agentSessions,
  hosts,
  logs,
  versions,
  type AgentBusAddress,
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
export const AGENT_MESSAGING_WAIT_PAGE_SIZE = 100;
export const AGENT_MESSAGING_CALL_PIN_TTL_SECONDS = 10 * 60;
export const AGENT_MESSAGING_CALL_PIN_MIN_TTL_SECONDS = 60;
export const AGENT_MESSAGING_CALL_PIN_MAX_TTL_SECONDS = 60 * 60;
/** `0000`..`9999`. The PIN is read aloud off one terminal into another, so it stays four digits. */
export const AGENT_MESSAGING_CALL_PIN_SPACE = 10_000;

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
        .select({ address: agentBusAddresses, fqdn: hosts.fqdn, hostEngines: hosts.engines })
        .from(agentBusAddresses)
        .innerJoin(hosts, eq(hosts.id, agentBusAddresses.hostId))
        .where(and(...predicates))
        .orderBy(asc(agentBusAddresses.address));
    });
    return {
      addresses: rows
        .filter((row) => hostEnginesList(row.hostEngines).includes(row.address.engine as Engine))
        .filter((row) => filters.includeOffline !== false || !['offline', 'disabled'].includes(row.address.readiness))
        .map((row) => publicAddress(row.address, row.fqdn)),
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
  }

  /**
   * Pick a free PIN and bind it to this address.
   *
   * Chooses from the complement of the live set rather than retrying random
   * values against the unique index: a duplicate insert inside a transaction
   * would surface as a driver-level ER_DUP_ENTRY that this layer would have to
   * pattern-match, and exhaustion would be indistinguishable from bad luck.
   */
  private async mintCallPinLocked(
    db: AgentMessagingDb,
    addressId: string,
    expiresAt: string,
    now: string,
  ): Promise<string> {
    const takenRows = await db
      .select({ callPin: agentBusAddresses.callPin })
      .from(agentBusAddresses)
      .where(isNotNull(agentBusAddresses.callPin))
      .for('update');
    const taken = new Set(takenRows.map((row) => row.callPin));
    const free: string[] = [];
    for (let candidate = 0; candidate < AGENT_MESSAGING_CALL_PIN_SPACE; candidate += 1) {
      const pin = String(candidate).padStart(4, '0');
      if (!taken.has(pin)) free.push(pin);
    }
    if (free.length === 0) {
      throw new ConflictError('No call PIN is available', 'agent_messaging_call_pin_exhausted');
    }
    const pin = free[randomInt(free.length)]!;
    await db
      .update(agentBusAddresses)
      .set({ callPin: pin, callPinExpiresAt: expiresAt, updatedAt: now })
      .where(eq(agentBusAddresses.id, addressId));
    return pin;
  }

  /**
   * Resolve a PIN to the address that opened it.
   *
   * Deliberately does not clear the PIN: the caller clears it only once the join
   * has fully succeeded, so a join that fails validation, targets itself, or
   * finds an ineligible opener leaves the rendezvous intact. One mistyped join
   * must not burn a PIN the human is still holding.
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
      throw new NotFoundError('Call PIN not found or expired', 'agent_messaging_call_pin_not_found');
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
      return { expired: Number(expiring[0]?.value ?? 0), retried: Number(retryable[0]?.value ?? 0), dead: Number(exhausted[0]?.value ?? 0), ambiguous: Number(uncertain[0]?.value ?? 0), released_bindings: releasedBindings };
    });
    if (result.expired || result.retried || result.dead || result.ambiguous || result.released_bindings) wsPublisher.publish('agent_messaging.queue.changed', result);
    return result;
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

function publicAddress(address: AgentBusAddress, fqdn?: string): Record<string, unknown> {
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
 */
function messagingHostEligibleSql(now: Date = new Date()) {
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
