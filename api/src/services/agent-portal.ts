import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import {
  and,
  asc,
  count,
  desc,
  eq,
  gt,
  inArray,
  isNull,
  lt,
  lte,
  or,
  sql,
} from 'drizzle-orm';
import type { Database } from '../db/client.js';
import {
  agentEvents,
  agentMatrixOutbox,
  agentMessages,
  agentPortalBrowserSessions,
  agentPortalUsers,
  agentPrompts,
  agentSessions,
  hosts,
  versions,
  type AgentMessage,
  type AgentPortalUser,
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
import { decrypt, encrypt } from '../security/secret-box.js';
import { randomHex, sha256 } from '../security/hash.js';
import type { Keyring } from '../security/keyring.js';
import { isTruthyFlagValue, SettingsService } from './settings.js';
import { isoOffsetSeconds, nowIso, parseIso } from '../util/timestamp.js';
import { ENGINE_CLAUDE, ENGINE_CODEX, type Engine } from '../util/engine.js';
import { wsPublisher } from '../ws/publisher.js';
import { hostEnginesList } from './host-engine-policy.js';

export const AGENT_PORTAL_ENABLED_KEY = 'agent_portal_enabled';
export const AGENT_PORTAL_MESSAGE_MAX_BYTES = 32 * 1024;
export const AGENT_PORTAL_EVENT_TEXT_MAX_BYTES = 128 * 1024;
export const AGENT_PORTAL_MAX_DELIVERY_ATTEMPTS = 12;
export const AGENT_PORTAL_RELAY_FRESH_SECONDS = 90;
export const AGENT_PORTAL_HEARTBEAT_FRESH_SECONDS = 45;

export const AGENT_EVENT_TYPES = [
  'started',
  'resumed',
  'user_message',
  'assistant_message',
  'progress',
  'waiting_input',
  'terminal_block',
  'message_accepted',
  'attention',
  'failed',
  'completed',
] as const;
export type AgentEventType = (typeof AGENT_EVENT_TYPES)[number];

export const AGENT_BRIDGE_EVENT_TYPES = [
  'assistant_message',
  'progress',
  'waiting_input',
  'terminal_block',
  'attention',
] as const satisfies readonly AgentEventType[];

const AGENT_EVENT_TYPE_SET = new Set<string>(AGENT_EVENT_TYPES);
const NOTIFY_EVENT_TYPES = new Set<AgentEventType>([
  'started',
  'resumed',
  'progress',
  'waiting_input',
  'terminal_block',
  'attention',
  'failed',
  'completed',
]);
const LIVE_SESSION_STATES = ['starting', 'active', 'waiting', 'offline'] as const;
const LIVE_SESSION_STATE_SET = new Set<string>(LIVE_SESSION_STATES);

export interface PortalUserView {
  id: number;
  display_name: string;
  matrix_room: string;
  enabled: boolean;
  public_id: string;
  created_at: string;
  updated_at: string;
  last_used_at: string | null;
  disabled_at: string | null;
  rotated_at: string | null;
}

export interface PortalIdentity {
  user: PortalUserView;
  browserSessionId: number;
}

export interface RegisterAgentInput {
  engine: Engine;
  username: string;
  cwd: string;
  upstreamSessionId?: string | null;
  invocationKind: 'interactive' | 'execute';
  resumed?: boolean;
  sessionId?: string;
  bridgeToken?: string;
}

export interface AgentEventInput {
  clientEventId: string;
  type: AgentEventType;
  source: 'engine' | 'terminal' | 'bridge' | 'portal';
  payload?: Record<string, unknown>;
}

export interface ClaimedMessage {
  message_id: string;
  sequence: number;
  kind: 'message' | 'answer';
  prompt_id: string | null;
  content: string;
  attempts: number;
  lease_owner: string;
  created_at: string;
}

export interface MatrixDelivery {
  id: number;
  event_key: string;
  idempotency_key: string;
  matrix_room: string;
  magic_url: string;
  payload: MatrixPayload;
  attempts: number;
  lease_owner: string;
}

interface MatrixPayload {
  kind: string;
  title: string;
  status: string;
  summary?: string;
  engine?: string;
  host?: string;
  username?: string;
  cwd?: string;
}

interface MatrixDeliveryEnvelope {
  version: 1;
  idempotency_key: string;
  matrix_room: string;
  magic_url: string;
  payload: MatrixPayload;
}

interface NormalizedEvent {
  payload: Record<string, unknown>;
  prompt?: {
    id: string;
    question: string;
    options: string[];
    expiresAt: string | null;
  };
}

interface EventTransactionOptions {
  bridge?: {
    token: string;
    hostId: number;
    allowEnded?: boolean;
  };
  terminal?: {
    status: 'completed' | 'failed';
    expiresAt: string;
  };
}

// MySqlTransaction implements this query surface but intentionally lacks the
// driver's `$client`, so it is not directly assignable to Database.
type AgentPortalDb = Pick<Database, 'insert' | 'update' | 'select' | 'delete'>;

export class AgentPortalService {
  private readonly settings: SettingsService;

  constructor(
    private readonly db: Database,
    private readonly env: Env,
    private readonly keyring: Keyring,
  ) {
    this.settings = new SettingsService(db);
  }

  async isEnabled(): Promise<boolean> {
    return await this.settings.getFlag(AGENT_PORTAL_ENABLED_KEY, false);
  }

  configured(): boolean {
    return Boolean(
      this.env.PUBLIC_BASE_URL?.trim() &&
        this.env.MATRIX_API_URL?.trim() &&
        this.env.MATRIX_API_KEY?.trim(),
    );
  }

  async state(): Promise<Record<string, unknown>> {
    const enabled = await this.isEnabled();
    const health = await this.health();
    return { enabled, initial_default: false, configured: this.configured(), ...health };
  }

  async setEnabled(enabled: boolean): Promise<{ enabled: boolean; canceled: number; revoked_sessions: number }> {
    if (enabled && !this.configured()) {
      throw new ServiceUnavailableError(
        'PUBLIC_BASE_URL, MATRIX_API_URL and MATRIX_API_KEY are required before enabling the agent portal',
        'agent_portal_not_configured',
      );
    }
    const now = nowIso();
    const result = await this.db.transaction(async (tx) => {
      const setting = await tx
        .select({ version: versions.version })
        .from(versions)
        .where(eq(versions.name, AGENT_PORTAL_ENABLED_KEY))
        .limit(1)
        .for('update');
      if (setting.length === 0) {
        await tx.insert(versions).values({
          name: AGENT_PORTAL_ENABLED_KEY,
          version: enabled ? '1' : '0',
          updatedAt: now,
        });
      } else {
        await tx
          .update(versions)
          .set({ version: enabled ? '1' : '0', updatedAt: now })
          .where(eq(versions.name, AGENT_PORTAL_ENABLED_KEY));
      }
      if (enabled) return { enabled: true as const, canceled: 0, revoked_sessions: 0 };

      const pending = await tx
        .select({ value: count() })
        .from(agentMessages)
        .where(inArray(agentMessages.status, ['queued', 'leased']));
      const browser = await tx
        .select({ value: count() })
        .from(agentPortalBrowserSessions)
        .where(isNull(agentPortalBrowserSessions.revokedAt));
      const pendingAnswers = await tx
        .select({ messageId: agentMessages.messageId })
        .from(agentMessages)
        .where(and(eq(agentMessages.kind, 'answer'), inArray(agentMessages.status, ['queued', 'leased'])));
      await tx
        .update(agentMessages)
        .set({ status: 'canceled', canceledAt: now, leaseOwner: null, leaseUntil: null, updatedAt: now })
        .where(inArray(agentMessages.status, ['queued', 'leased']));
      await tx
        .update(agentPrompts)
        .set({ status: 'expired', expiresAt: now, version: sql`${agentPrompts.version} + 1` })
        .where(eq(agentPrompts.status, 'open'));
      await this.expirePromptsForAnswerMessages(
        pendingAnswers.map((row) => row.messageId),
        now,
        tx,
      );
      await tx
        .update(agentMatrixOutbox)
        .set({ status: 'canceled', canceledAt: now, leaseOwner: null, leaseUntil: null, updatedAt: now })
        .where(inArray(agentMatrixOutbox.status, ['queued', 'leased']));
      await tx
        .update(agentPortalBrowserSessions)
        .set({ revokedAt: now })
        .where(isNull(agentPortalBrowserSessions.revokedAt));
      await tx
        .update(agentSessions)
        .set({ relayEnabled: 0, relayHeartbeatAt: null, updatedAt: now })
        .where(inArray(agentSessions.status, [...LIVE_SESSION_STATES]));
      return {
        enabled: false as const,
        canceled: Number(pending[0]?.value ?? 0),
        revoked_sessions: Number(browser[0]?.value ?? 0),
      };
    });
    wsPublisher.publish('settings.changed', { key: AGENT_PORTAL_ENABLED_KEY });
    if (enabled) {
      const users = await this.enabledUsers();
      for (const user of users) await this.enqueueOnboardingAuthorized(user.id, 'enabled');
    }
    return result;
  }

  async listUsers(): Promise<PortalUserView[]> {
    const rows = await this.db
      .select()
      .from(agentPortalUsers)
      .where(isNull(agentPortalUsers.deletedAt))
      .orderBy(asc(agentPortalUsers.displayName), asc(agentPortalUsers.id));
    return rows.map(portalUserView);
  }

  async createUser(input: { displayName: string; matrixRoom: string; enabled?: boolean }): Promise<{ user: PortalUserView; magic_url: string }> {
    const displayName = normalizeRequiredText(input.displayName, 'display_name', 255);
    const matrixRoom = normalizeMatrixRoom(input.matrixRoom);
    const token = randomBytes(32).toString('base64url');
    const now = nowIso();
    const publicId = randomHex(16);
    await this.db.insert(agentPortalUsers).values({
      displayName,
      matrixRoom,
      enabled: input.enabled === false ? 0 : 1,
      publicId,
      tokenHash: sha256(token),
      tokenEnc: encrypt(token, this.keyring),
      createdAt: now,
      updatedAt: now,
      lastUsedAt: null,
      disabledAt: input.enabled === false ? now : null,
      rotatedAt: now,
      deletedAt: null,
    });
    const user = await this.userByPublicId(publicId);
    if (!user) throw new ServiceUnavailableError('Portal user creation did not persist', 'agent_portal_write_failed');
    if (user.enabled === 1) await this.enqueueOnboardingAuthorized(user.id, 'created');
    return { user: portalUserView(user), magic_url: this.magicUrl(user, token) };
  }

  async setUserEnabled(id: number, enabled: boolean): Promise<{ user: PortalUserView; canceled: number; revoked_sessions: number }> {
    const now = nowIso();
    const result = await this.db.transaction(async (tx) => {
      await this.portalEnabledLocked(tx);
      await this.requireUserLocked(tx, id);
      await tx
        .update(agentPortalUsers)
        .set({ enabled: enabled ? 1 : 0, disabledAt: enabled ? null : now, updatedAt: now })
        .where(eq(agentPortalUsers.id, id));
      const disabled = enabled
        ? { canceled: 0, revoked_sessions: 0 }
        : await this.disableUserRows(id, now, tx);
      const rows = await tx.select().from(agentPortalUsers).where(eq(agentPortalUsers.id, id)).limit(1);
      return { user: portalUserView(rows[0]!), ...disabled };
    });
    if (enabled) await this.enqueueOnboardingAuthorized(id, 're-enabled');
    return result;
  }

  async updateUser(id: number, input: { displayName?: string; matrixRoom?: string }): Promise<PortalUserView> {
    const patch: Partial<typeof agentPortalUsers.$inferInsert> = { updatedAt: nowIso() };
    if (input.displayName !== undefined) patch.displayName = normalizeRequiredText(input.displayName, 'display_name', 255);
    if (input.matrixRoom !== undefined) patch.matrixRoom = normalizeMatrixRoom(input.matrixRoom);
    const result = await this.db.transaction(async (tx) => {
      await this.portalEnabledLocked(tx);
      const prior = await this.requireUserLocked(tx, id);
      const roomChanged = patch.matrixRoom !== undefined && patch.matrixRoom !== prior.matrixRoom;
      if (roomChanged) {
        const now = nowIso();
        await tx
          .update(agentMatrixOutbox)
          .set({ status: 'canceled', canceledAt: now, leaseOwner: null, leaseUntil: null, updatedAt: now })
          .where(and(eq(agentMatrixOutbox.portalUserId, id), inArray(agentMatrixOutbox.status, ['queued', 'leased'])));
      }
      await tx.update(agentPortalUsers).set(patch).where(eq(agentPortalUsers.id, id));
      const rows = await tx.select().from(agentPortalUsers).where(eq(agentPortalUsers.id, id)).limit(1);
      return { user: rows[0]!, roomChanged };
    });
    if (result.roomChanged && result.user.enabled === 1) {
      await this.enqueueOnboardingAuthorized(id, `room:${Date.now()}`);
    }
    return portalUserView(result.user);
  }

  async rotateUser(id: number): Promise<{ user: PortalUserView; magic_url: string; revoked_sessions: number }> {
    const token = randomBytes(32).toString('base64url');
    const now = nowIso();
    const result = await this.db.transaction(async (tx) => {
      await this.portalEnabledLocked(tx);
      await this.requireUserLocked(tx, id);
      const sessions = await tx
        .select({ value: count() })
        .from(agentPortalBrowserSessions)
        .where(and(eq(agentPortalBrowserSessions.userId, id), isNull(agentPortalBrowserSessions.revokedAt)));
      await tx
        .update(agentPortalUsers)
        .set({ tokenHash: sha256(token), tokenEnc: encrypt(token, this.keyring), rotatedAt: now, updatedAt: now })
        .where(eq(agentPortalUsers.id, id));
      await tx
        .update(agentPortalBrowserSessions)
        .set({ revokedAt: now })
        .where(and(eq(agentPortalBrowserSessions.userId, id), isNull(agentPortalBrowserSessions.revokedAt)));
      // The rendered Matrix body contains the permanent link. Cancel every
      // undelivered old-generation body before swapping the token; the new
      // onboarding row below receives its own outbox ID/idempotency boundary.
      await tx
        .update(agentMatrixOutbox)
        .set({ status: 'canceled', canceledAt: now, leaseOwner: null, leaseUntil: null, updatedAt: now })
        .where(and(eq(agentMatrixOutbox.portalUserId, id), inArray(agentMatrixOutbox.status, ['queued', 'leased'])));
      const rows = await tx.select().from(agentPortalUsers).where(eq(agentPortalUsers.id, id)).limit(1);
      return { user: rows[0]!, revoked: Number(sessions[0]?.value ?? 0) };
    });
    if (result.user.enabled === 1) await this.enqueueOnboardingAuthorized(id, 'rotated');
    return {
      user: portalUserView(result.user),
      magic_url: this.magicUrl(result.user, token),
      revoked_sessions: result.revoked,
    };
  }

  async resendUserLink(id: number): Promise<{ queued: boolean }> {
    return { queued: await this.enqueueOnboardingAuthorized(id, `resend:${Date.now()}`) };
  }

  async deleteUser(id: number): Promise<{ canceled: number; revoked_sessions: number }> {
    const now = nowIso();
    return await this.db.transaction(async (tx) => {
      await this.portalEnabledLocked(tx);
      await this.requireUserLocked(tx, id);
      await tx
        .update(agentPortalUsers)
        .set({ enabled: 0, disabledAt: now, deletedAt: now, updatedAt: now })
        .where(eq(agentPortalUsers.id, id));
      return await this.disableUserRows(id, now, tx);
    });
  }

  async exchangeMagicLink(input: {
    publicId: string;
    token: string;
    ip?: string | null;
    userAgent?: string | null;
  }): Promise<{ identity: PortalIdentity; sessionToken: string; expiresAt: string }> {
    const submittedHash = sha256(input.token ?? '');
    const raw = randomBytes(32).toString('base64url');
    const now = nowIso();
    const expiresAt = isoOffsetSeconds(this.env.AGENT_PORTAL_SESSION_TTL_HOURS * 3600);
    return await this.db.transaction(async (tx) => {
      await this.requirePortalEnabledLocked(tx);
      const users = await tx
        .select()
        .from(agentPortalUsers)
        .where(eq(agentPortalUsers.publicId, String(input.publicId ?? '').trim()))
        .limit(1)
        .for('update');
      const user = users[0];
      if (!user || user.deletedAt || !safeHashEqual(submittedHash, user.tokenHash)) {
        throw new UnauthorizedError('Invalid portal link', 'agent_portal_link_invalid');
      }
      if (user.enabled !== 1) throw new ForbiddenError('Portal user is disabled', 'agent_portal_user_disabled');
      const inserted = await tx.insert(agentPortalBrowserSessions).values({
        userId: user.id,
        tokenHash: sha256(raw),
        ip: normalizeOptionalText(input.ip, 64),
        userAgent: normalizeOptionalText(input.userAgent, 255),
        expiresAt,
        lastSeenAt: now,
        createdAt: now,
        revokedAt: null,
      });
      await tx
        .update(agentPortalUsers)
        .set({ lastUsedAt: now, updatedAt: now })
        .where(eq(agentPortalUsers.id, user.id));
      return {
        identity: {
          user: portalUserView({ ...user, lastUsedAt: now, updatedAt: now }),
          browserSessionId: extractInsertId(inserted),
        },
        sessionToken: raw,
        expiresAt,
      };
    });
  }

  async authenticateBrowser(rawToken: string | undefined, touch = true): Promise<PortalIdentity> {
    await this.requireEnabled();
    if (!rawToken) throw new UnauthorizedError('Portal login required', 'agent_portal_login_required');
    const rows = await this.db
      .select({ session: agentPortalBrowserSessions, user: agentPortalUsers })
      .from(agentPortalBrowserSessions)
      .innerJoin(agentPortalUsers, eq(agentPortalUsers.id, agentPortalBrowserSessions.userId))
      .where(eq(agentPortalBrowserSessions.tokenHash, sha256(rawToken)))
      .limit(1);
    const row = rows[0];
    const now = nowIso();
    if (
      !row ||
      row.session.revokedAt ||
      row.session.expiresAt <= now ||
      row.user.deletedAt ||
      row.user.enabled !== 1
    ) {
      throw new UnauthorizedError('Portal session expired', 'agent_portal_session_expired');
    }
    if (touch) {
      await this.db
        .update(agentPortalBrowserSessions)
        .set({ lastSeenAt: now })
        .where(eq(agentPortalBrowserSessions.id, row.session.id));
    }
    return { user: portalUserView(row.user), browserSessionId: row.session.id };
  }

  async logoutBrowser(rawToken: string | undefined): Promise<void> {
    if (!rawToken) return;
    await this.db.transaction(async (tx) => {
      // Serialize with SSE's shared master-setting lock so logout returning is
      // a strict boundary: no later event page can pass browser validation.
      await this.portalEnabledLocked(tx);
      await tx
        .update(agentPortalBrowserSessions)
        .set({ revokedAt: nowIso() })
        .where(eq(agentPortalBrowserSessions.tokenHash, sha256(rawToken)));
    });
  }

  async registerAgent(host: Host, input: RegisterAgentInput): Promise<{ enabled: true; session_id: string; bridge_token: string; expires_at: string } | { enabled: false }> {
    const username = normalizeRequiredText(input.username, 'username', 255);
    const cwd = normalizeRequiredText(input.cwd, 'cwd', 1024);
    if (input.engine !== ENGINE_CODEX && input.engine !== ENGINE_CLAUDE) {
      throw new ValidationError('engine must be codex or claude', { param: 'engine' });
    }
    const sessionId = input.sessionId ? normalizeUuid(input.sessionId, 'session_id') : randomUUID();
    const bridgeToken = input.bridgeToken ? normalizeBridgeToken(input.bridgeToken) : randomBytes(32).toString('base64url');
    const now = nowIso();
    const expiresAt = isoOffsetSeconds(this.env.AGENT_PORTAL_BRIDGE_TTL_SECONDS);
    const fingerprint = hostAuthFingerprint(host);
    const registered = await this.db.transaction(async (tx) => {
      if (!(await this.portalEnabledLocked(tx))) return false;
      const existing = await tx
        .select()
        .from(agentSessions)
        .where(eq(agentSessions.id, sessionId))
        .limit(1)
        .for('update');
      if (existing[0]) {
        const session = existing[0];
        if (
          session.hostId !== host.id ||
          session.engine !== input.engine ||
          session.username !== username ||
          session.cwd !== cwd ||
          session.invocationKind !== input.invocationKind ||
          !safeHashEqual(sha256(bridgeToken), session.bridgeTokenHash)
        ) {
          throw new ConflictError('Agent session registration conflicts with an existing session', 'agent_session_conflict');
        }
        if (session.endedAt) throw new ConflictError('Agent session is finished', 'agent_session_finished');
        await tx
          .update(agentSessions)
          .set({
            hostAuthFingerprint: fingerprint,
            bridgeExpiresAt: expiresAt,
            heartbeatAt: now,
            updatedAt: now,
          })
          .where(eq(agentSessions.id, sessionId));
        return true;
      }
      await tx.insert(agentSessions).values({
        id: sessionId,
        hostId: host.id,
        engine: input.engine,
        username,
        cwd,
        upstreamSessionId: normalizeOptionalText(input.upstreamSessionId, 255),
        invocationKind: input.invocationKind,
        status: 'active',
        relayEnabled: 0,
        relayHeartbeatAt: null,
        activeTurnId: null,
        hostAuthFingerprint: fingerprint,
        bridgeTokenHash: sha256(bridgeToken),
        bridgeExpiresAt: expiresAt,
        startedAt: now,
        heartbeatAt: now,
        endedAt: null,
        expiresAt: null,
        createdAt: now,
        updatedAt: now,
      });
      return true;
    });
    if (!registered) return { enabled: false };
    await this.addEventInternal(sessionId, {
      clientEventId: 'server:started',
      type: input.resumed ? 'resumed' : 'started',
      source: 'bridge',
      payload: { summary: input.resumed ? 'Agent resumed' : 'Agent started' },
    });
    return { enabled: true, session_id: sessionId, bridge_token: bridgeToken, expires_at: expiresAt };
  }

  async heartbeatAgent(sessionId: string, bridgeToken: string, input: { status?: string; activeTurnId?: string | null; relayAction?: 'poll' | 'close' }, hostId?: number): Promise<Record<string, unknown>> {
    const session = await this.authenticateBridge(sessionId, bridgeToken, hostId);
    const now = nowIso();
    const expiresAt = isoOffsetSeconds(this.env.AGENT_PORTAL_BRIDGE_TTL_SECONDS);
    const requested = input.status?.trim().toLowerCase();
    const result = await this.db.transaction(async (tx) => {
      await this.requirePortalEnabledLocked(tx);
      const locked = await this.requireBridgeSessionLocked(
        tx,
        sessionId,
        bridgeToken,
        session.hostId,
      );
      const status = requested && LIVE_SESSION_STATE_SET.has(requested) ? requested : locked.status;
      const patch: Partial<typeof agentSessions.$inferInsert> = {
        heartbeatAt: now,
        bridgeExpiresAt: expiresAt,
        status,
        updatedAt: now,
      };
      if (input.activeTurnId !== undefined) patch.activeTurnId = normalizeOptionalText(input.activeTurnId, 255);
      if (input.relayAction === 'poll') {
        patch.relayEnabled = 1;
        patch.relayHeartbeatAt = now;
      } else if (input.relayAction === 'close') {
        patch.relayEnabled = 0;
        patch.relayHeartbeatAt = null;
        await this.cancelSessionPending(sessionId, now, tx);
      }
      await tx.update(agentSessions).set(patch).where(eq(agentSessions.id, sessionId));
      return {
        status,
        relay_active: input.relayAction === 'close' ? false : input.relayAction === 'poll' || locked.relayEnabled === 1,
      };
    });
    return { enabled: true, expires_at: expiresAt, ...result };
  }

  async addAgentEvent(sessionId: string, bridgeToken: string, input: AgentEventInput, hostId?: number): Promise<Record<string, unknown>> {
    const session = await this.authenticateBridge(sessionId, bridgeToken, hostId);
    return await this.addEventInternal(sessionId, input, {
      bridge: { token: bridgeToken, hostId: session.hostId },
    });
  }

  async finishAgent(sessionId: string, bridgeToken: string, input: { status: 'completed' | 'failed'; summary?: string }, hostId?: number): Promise<Record<string, unknown>> {
    const session = await this.authenticateBridge(sessionId, bridgeToken, hostId, true);
    const expiresAt = isoOffsetSeconds(this.env.AGENT_PORTAL_RETENTION_HOURS * 3600);
    const event = await this.addEventInternal(session.id, {
      clientEventId: `server:${input.status}`,
      type: input.status,
      source: 'bridge',
      payload: { summary: normalizeOptionalText(input.summary, 1000) ?? (input.status === 'failed' ? 'Agent failed' : 'Agent completed') },
    }, {
      bridge: { token: bridgeToken, hostId: session.hostId, allowEnded: true },
      terminal: { status: input.status, expiresAt },
    });
    return { ...event, status: input.status, expires_at: expiresAt };
  }

  async listAgents(): Promise<Array<Record<string, unknown>>> {
    const now = nowIso();
    const rows = await this.db
      .select({ session: agentSessions, fqdn: hosts.fqdn })
      .from(agentSessions)
      .innerJoin(hosts, eq(hosts.id, agentSessions.hostId))
      .where(or(isNull(agentSessions.endedAt), gt(agentSessions.expiresAt, now)))
      .orderBy(desc(agentSessions.startedAt));
    const sessionIds = rows.map((row) => row.session.id);
    const prompts = sessionIds.length
      ? await this.db
          .select({ id: agentPrompts.id, sessionId: agentPrompts.sessionId, questionEnc: agentPrompts.questionEnc, optionsEnc: agentPrompts.optionsEnc, version: agentPrompts.version, createdAt: agentPrompts.createdAt })
          .from(agentPrompts)
          .where(and(inArray(agentPrompts.sessionId, sessionIds), eq(agentPrompts.status, 'open')))
          .orderBy(desc(agentPrompts.createdAt))
      : [];
    const promptBySession = new Map<string, Record<string, unknown>>();
    for (const prompt of prompts) {
      if (promptBySession.has(prompt.sessionId)) continue;
      promptBySession.set(prompt.sessionId, {
        id: prompt.id,
        question: this.decodeText(prompt.questionEnc),
        options: prompt.optionsEnc ? this.decodeJson<string[]>(prompt.optionsEnc, []) : [],
        version: prompt.version,
        created_at: prompt.createdAt,
      });
    }
    const offlineBefore = Date.now() - AGENT_PORTAL_HEARTBEAT_FRESH_SECONDS * 1000;
    const relayBefore = Date.now() - AGENT_PORTAL_RELAY_FRESH_SECONDS * 1000;
    return rows.map(({ session, fqdn }) => {
      const heartbeat = parseIso(session.heartbeatAt)?.getTime() ?? 0;
      const effectiveStatus = LIVE_SESSION_STATE_SET.has(session.status) && heartbeat < offlineBefore ? 'offline' : session.status;
      const relayHeartbeat = parseIso(session.relayHeartbeatAt ?? '')?.getTime() ?? 0;
      const relayReady = !session.endedAt && heartbeat >= offlineBefore && session.relayEnabled === 1 && relayHeartbeat >= relayBefore;
      return {
        id: session.id,
        engine: session.engine,
        host: fqdn,
        host_id: session.hostId,
        username: session.username,
        cwd: session.cwd,
        invocation_kind: session.invocationKind,
        upstream_session_id: session.upstreamSessionId,
        status: effectiveStatus,
        relay_ready: relayReady,
        active_turn_id: session.activeTurnId,
        started_at: session.startedAt,
        heartbeat_at: session.heartbeatAt,
        ended_at: session.endedAt,
        expires_at: session.expiresAt,
        read_only: Boolean(session.endedAt),
        pending_prompt: promptBySession.get(session.id) ?? null,
      };
    });
  }

  async listEvents(sessionId: string, after = 0, limit = 250, tail = false): Promise<{ events: Array<Record<string, unknown>>; next_cursor: number }> {
    await this.requireVisibleSession(sessionId);
    const bounded = Math.max(1, Math.min(500, Math.trunc(limit)));
    if (tail) {
      const rows = await this.db
        .select()
        .from(agentEvents)
        .where(eq(agentEvents.sessionId, sessionId))
        .orderBy(desc(agentEvents.id))
        .limit(bounded);
      rows.reverse();
      const events = rows.map((event) => ({
        cursor: event.id,
        session_id: event.sessionId,
        type: event.eventType,
        source: event.source,
        payload: this.decodeJson<Record<string, unknown>>(event.payloadEnc, {}),
        created_at: event.createdAt,
      }));
      return { events, next_cursor: rows.at(-1)?.id ?? 0 };
    }
    const rows = await this.db
      .select()
      .from(agentEvents)
      .where(and(eq(agentEvents.sessionId, sessionId), gt(agentEvents.id, Math.max(0, Math.trunc(after)))))
      .orderBy(asc(agentEvents.id))
      .limit(bounded);
    const events = rows.map((event) => ({
      cursor: event.id,
      session_id: event.sessionId,
      type: event.eventType,
      source: event.source,
      payload: this.decodeJson<Record<string, unknown>>(event.payloadEnc, {}),
      created_at: event.createdAt,
    }));
    return { events, next_cursor: rows.at(-1)?.id ?? Math.max(0, Math.trunc(after)) };
  }

  async listEventsAfter(after = 0, limit = 250): Promise<{ events: Array<Record<string, unknown>>; next_cursor: number }> {
    const bounded = Math.max(1, Math.min(500, Math.trunc(limit)));
    const rows = await this.db
      .select()
      .from(agentEvents)
      .where(gt(agentEvents.id, Math.max(0, Math.trunc(after))))
      .orderBy(asc(agentEvents.id))
      .limit(bounded);
    const events = rows.map((event) => ({
      cursor: event.id,
      session_id: event.sessionId,
      type: event.eventType,
      source: event.source,
      payload: this.decodeJson<Record<string, unknown>>(event.payloadEnc, {}),
      created_at: event.createdAt,
    }));
    return { events, next_cursor: rows.at(-1)?.id ?? Math.max(0, Math.trunc(after)) };
  }

  async listEventsAfterAuthenticated(
    rawToken: string | undefined,
    after = 0,
    limit = 250,
  ): Promise<{ events: Array<Record<string, unknown>>; next_cursor: number }> {
    if (!rawToken) throw new UnauthorizedError('Portal login required', 'agent_portal_login_required');
    const bounded = Math.max(1, Math.min(500, Math.trunc(limit)));
    const cursor = Math.max(0, Math.trunc(after));
    return await this.db.transaction(async (tx) => {
      const setting = await tx
        .select({ version: versions.version })
        .from(versions)
        .where(eq(versions.name, AGENT_PORTAL_ENABLED_KEY))
        .limit(1)
        .for('share');
      if (!isTruthyFlagValue(setting[0]?.version)) {
        throw new ServiceUnavailableError('Agent portal is disabled', 'agent_portal_disabled');
      }
      const identities = await tx
        .select({ session: agentPortalBrowserSessions, user: agentPortalUsers })
        .from(agentPortalBrowserSessions)
        .innerJoin(agentPortalUsers, eq(agentPortalUsers.id, agentPortalBrowserSessions.userId))
        .where(eq(agentPortalBrowserSessions.tokenHash, sha256(rawToken)))
        .limit(1);
      const identity = identities[0];
      const now = nowIso();
      if (
        !identity ||
        identity.session.revokedAt ||
        identity.session.expiresAt <= now ||
        identity.user.deletedAt ||
        identity.user.enabled !== 1
      ) {
        throw new UnauthorizedError('Portal session expired', 'agent_portal_session_expired');
      }
      const rows = await tx
        .select()
        .from(agentEvents)
        .where(gt(agentEvents.id, cursor))
        .orderBy(asc(agentEvents.id))
        .limit(bounded);
      const events = rows.map((event) => ({
        cursor: event.id,
        session_id: event.sessionId,
        type: event.eventType,
        source: event.source,
        payload: this.decodeJson<Record<string, unknown>>(event.payloadEnc, {}),
        created_at: event.createdAt,
      }));
      return { events, next_cursor: rows.at(-1)?.id ?? cursor };
    });
  }

  async latestEventCursor(): Promise<number> {
    const rows = await this.db.select({ id: agentEvents.id }).from(agentEvents).orderBy(desc(agentEvents.id)).limit(1);
    return rows[0]?.id ?? 0;
  }

  async enqueueMessage(identity: PortalIdentity, input: { sessionId: string; clientMessageId: string; content: string }): Promise<Record<string, unknown>> {
    const content = normalizeMessage(input.content);
    const clientMessageId = normalizeUuid(input.clientMessageId, 'client_message_id');
    const messageId = randomUUID();
    const now = nowIso();
    const inserted = await this.db.transaction(async (tx) => {
      await this.requirePortalEnabledLocked(tx);
      const user = await this.requireIdentityLocked(tx, identity, now);
      const session = await this.requireVisibleSessionLocked(tx, input.sessionId, now);
      const raced = await this.findMessageByClientId(input.sessionId, clientMessageId, tx, true);
      if (raced) {
        this.assertMessageIdempotency(raced, user.id, 'message', null, content);
        return raced;
      }
      this.assertLiveSession(session);
      this.assertRelayReady(session);
      await tx.insert(agentMessages).values({
        messageId,
        sessionId: input.sessionId,
        portalUserId: user.id,
        kind: 'message',
        promptId: null,
        clientMessageId,
        contentEnc: this.encodeText(content),
        status: 'queued',
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
      });
      await this.insertPortalMessageEvent(tx, input.sessionId, messageId, {
        message_id: messageId,
        text: content,
        author: user.displayName,
        delivery_status: 'queued',
      }, now);
      const rows = await tx.select().from(agentMessages).where(eq(agentMessages.messageId, messageId)).limit(1);
      if (!rows[0]) throw new ServiceUnavailableError('Message queue insert was not readable', 'agent_message_write_failed');
      return rows[0];
    });
    return messageView(inserted);
  }

  async answerPrompt(identity: PortalIdentity, input: { sessionId: string; promptId: string; clientMessageId: string; answer: string; version?: number }): Promise<Record<string, unknown>> {
    const answer = normalizeMessage(input.answer);
    const clientMessageId = normalizeUuid(input.clientMessageId, 'client_message_id');
    const messageId = randomUUID();
    const now = nowIso();
    const inserted = await this.db.transaction(async (tx) => {
      await this.requirePortalEnabledLocked(tx);
      const user = await this.requireIdentityLocked(tx, identity, now);
      const session = await this.requireVisibleSessionLocked(tx, input.sessionId, now);
      const raced = await this.findMessageByClientId(input.sessionId, clientMessageId, tx, true);
      if (raced) {
        this.assertMessageIdempotency(raced, user.id, 'answer', input.promptId, answer);
        return raced;
      }
      this.assertLiveSession(session);
      this.assertRelayReady(session);
      const prompts = await tx
        .select()
        .from(agentPrompts)
        .where(and(eq(agentPrompts.id, input.promptId), eq(agentPrompts.sessionId, input.sessionId)))
        .limit(1)
        .for('update');
      const prompt = prompts[0];
      if (!prompt) throw new NotFoundError('Prompt not found', 'agent_prompt_not_found');
      if (prompt.status !== 'open') {
        throw new ConflictError('Prompt was already answered', 'already_answered', {
          answered_by_user_id: prompt.answeredByUserId,
          answered_at: prompt.answeredAt,
        });
      }
      if (input.version !== undefined && input.version !== prompt.version) {
        throw new ConflictError('Prompt version changed', 'prompt_version_conflict', { current_version: prompt.version });
      }
      await tx.insert(agentMessages).values({
        messageId,
        sessionId: input.sessionId,
        portalUserId: user.id,
        kind: 'answer',
        promptId: input.promptId,
        clientMessageId,
        contentEnc: this.encodeText(answer),
        status: 'queued',
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
      });
      await tx
        .update(agentPrompts)
        .set({
          status: 'answered',
          answeredByUserId: user.id,
          answerMessageId: messageId,
          answeredAt: now,
          version: prompt.version + 1,
        })
        .where(eq(agentPrompts.id, prompt.id));
      await this.insertPortalMessageEvent(tx, input.sessionId, messageId, {
        message_id: messageId,
        prompt_id: input.promptId,
        text: answer,
        author: user.displayName,
        delivery_status: 'queued',
      }, now);
      const rows = await tx.select().from(agentMessages).where(eq(agentMessages.messageId, messageId)).limit(1);
      if (!rows[0]) throw new ServiceUnavailableError('Answer queue insert was not readable', 'agent_message_write_failed');
      return rows[0];
    });
    return messageView(inserted);
  }

  async claimMessage(sessionId: string, bridgeToken: string, claimId: string, hostId?: number): Promise<ClaimedMessage | null> {
    const leaseClaimId = normalizeUuid(claimId, 'claim_id');
    const authenticated = await this.authenticateBridge(sessionId, bridgeToken, hostId);
    for (;;) {
      const candidateRows = await this.db
        .select({ id: agentMessages.id, portalUserId: agentMessages.portalUserId })
        .from(agentMessages)
        .where(and(eq(agentMessages.sessionId, sessionId), inArray(agentMessages.status, ['queued', 'leased'])))
        .orderBy(asc(agentMessages.id))
        .limit(1);
      const candidate = candidateRows[0];
      const result = await this.db.transaction(async (tx): Promise<ClaimedMessage | null | 'retry'> => {
        await this.requirePortalEnabledLocked(tx);
        let user: AgentPortalUser | undefined;
        if (candidate) {
          const users = await tx
            .select()
            .from(agentPortalUsers)
            .where(eq(agentPortalUsers.id, candidate.portalUserId))
            .limit(1)
            .for('update');
          user = users[0];
        }
        const session = await this.requireBridgeSessionLocked(
          tx,
          sessionId,
          bridgeToken,
          authenticated.hostId,
        );
        this.assertRelayReady(session);
        const now = nowIso();
        await tx
          .update(agentSessions)
          .set({ heartbeatAt: now, relayHeartbeatAt: now, updatedAt: now })
          .where(eq(agentSessions.id, sessionId));
        if (!candidate) return null;
        const rows = await tx
          .select()
          .from(agentMessages)
          .where(eq(agentMessages.id, candidate.id))
          .limit(1)
          .for('update');
        const row = rows[0];
        if (!row || row.sessionId !== sessionId || (row.status !== 'queued' && row.status !== 'leased')) return 'retry';
        if (!user || user.enabled !== 1 || user.deletedAt) {
          await tx
            .update(agentMessages)
            .set({ status: 'canceled', canceledAt: now, leaseOwner: null, leaseUntil: null, updatedAt: now })
            .where(eq(agentMessages.id, row.id));
          await this.releaseUndeliveredAnswerPrompt(row, session, now, tx);
          return 'retry';
        }
        if (
          row.status === 'leased' &&
          row.leaseOwner === leaseClaimId &&
          row.leaseUntil &&
          row.leaseUntil > now
        ) {
          return {
            message_id: row.messageId,
            sequence: row.id,
            kind: row.kind === 'answer' ? 'answer' : 'message',
            prompt_id: row.promptId,
            content: this.decodeText(row.contentEnc),
            attempts: row.attempts,
            lease_owner: leaseClaimId,
            created_at: row.createdAt,
          };
        }
        if (row.status === 'leased' && row.leaseUntil && row.leaseUntil > now) return null;
        if (row.status === 'queued' && row.nextAttemptAt > now) return null;
        if (row.attempts >= AGENT_PORTAL_MAX_DELIVERY_ATTEMPTS) {
          await tx
            .update(agentMessages)
            .set({ status: 'dead', lastError: 'maximum delivery attempts reached', leaseOwner: null, leaseUntil: null, updatedAt: now })
            .where(eq(agentMessages.id, row.id));
          await this.releaseUndeliveredAnswerPrompt(row, session, now, tx);
          return 'retry';
        }
        const leaseUntil = isoOffsetSeconds(30);
        await tx
          .update(agentMessages)
          .set({ status: 'leased', attempts: row.attempts + 1, leaseOwner: leaseClaimId, leaseUntil, updatedAt: now })
          .where(eq(agentMessages.id, row.id));
        return {
          message_id: row.messageId,
          sequence: row.id,
          kind: row.kind === 'answer' ? 'answer' : 'message',
          prompt_id: row.promptId,
          content: this.decodeText(row.contentEnc),
          attempts: row.attempts + 1,
          lease_owner: leaseClaimId,
          created_at: row.createdAt,
        };
      });
      if (result !== 'retry') return result;
    }
  }

  async acknowledgeMessage(sessionId: string, bridgeToken: string, input: { messageId: string; leaseOwner: string; outcome: 'accepted' | 'retry' | 'failed'; upstreamId?: string | null; error?: string | null }, hostId?: number): Promise<Record<string, unknown>> {
    const authenticated = await this.authenticateBridge(sessionId, bridgeToken, hostId);
    const updated = await this.db.transaction(async (tx) => {
      await this.requirePortalEnabledLocked(tx);
      const session = await this.requireBridgeSessionLocked(
        tx,
        sessionId,
        bridgeToken,
        authenticated.hostId,
      );
      const rows = await tx
        .select()
        .from(agentMessages)
        .where(and(eq(agentMessages.sessionId, sessionId), eq(agentMessages.messageId, input.messageId)))
        .limit(1)
        .for('update');
      const row = rows[0];
      if (!row) throw new NotFoundError('Message not found', 'agent_message_not_found');
      if (row.status === 'accepted') return row;
      if (row.status !== 'leased' || row.leaseOwner !== input.leaseOwner) {
        throw new ConflictError('Message lease is no longer owned by this bridge', 'agent_message_lease_lost');
      }
      const now = nowIso();
      if (input.outcome === 'accepted') {
        const upstreamId = normalizeOptionalText(input.upstreamId, 255);
        await tx
          .update(agentMessages)
          .set({ status: 'accepted', acceptedAt: now, upstreamId, lastError: null, leaseOwner: null, leaseUntil: null, updatedAt: now })
          .where(eq(agentMessages.id, row.id));
        const acceptedPayload = normalizeEvent('message_accepted', {
          message_id: row.messageId,
          upstream_id: upstreamId,
          delivery_status: 'accepted',
        }).payload;
        await tx.insert(agentEvents).values({
          sessionId,
          clientEventId: `server:accepted:${row.messageId}`,
          eventType: 'message_accepted',
          source: 'bridge',
          payloadEnc: this.encodeJson(acceptedPayload),
          createdAt: now,
        });
        await tx
          .update(agentSessions)
          .set({ status: 'active', updatedAt: now })
          .where(and(eq(agentSessions.id, sessionId), isNull(agentSessions.endedAt)));
      } else if (input.outcome === 'retry' && row.attempts < AGENT_PORTAL_MAX_DELIVERY_ATTEMPTS) {
        await tx
          .update(agentMessages)
          .set({
            status: 'queued',
            nextAttemptAt: isoOffsetSeconds(backoffSeconds(row.attempts)),
            lastError: normalizeOptionalText(input.error, 2000),
            leaseOwner: null,
            leaseUntil: null,
            updatedAt: now,
          })
          .where(eq(agentMessages.id, row.id));
      } else {
        await tx
          .update(agentMessages)
          .set({ status: 'dead', lastError: normalizeOptionalText(input.error, 2000) ?? 'delivery failed', leaseOwner: null, leaseUntil: null, updatedAt: now })
          .where(eq(agentMessages.id, row.id));
        await this.releaseUndeliveredAnswerPrompt(row, session, now, tx);
      }
      const refreshed = await tx.select().from(agentMessages).where(eq(agentMessages.id, row.id)).limit(1);
      return refreshed[0]!;
    });
    return messageView(updated);
  }

  async claimMatrixDelivery(workerId: string): Promise<MatrixDelivery | null> {
    return await this.db.transaction(async (tx) => {
      if (!(await this.portalEnabledLocked(tx))) return null;
      const now = nowIso();
      await tx
        .update(agentMatrixOutbox)
        .set({ status: 'queued', leaseOwner: null, leaseUntil: null, updatedAt: now })
        .where(and(eq(agentMatrixOutbox.status, 'leased'), lt(agentMatrixOutbox.leaseUntil, now)));
      const rows = await tx
        .select({ outbox: agentMatrixOutbox, user: agentPortalUsers })
        .from(agentMatrixOutbox)
        .innerJoin(agentPortalUsers, eq(agentPortalUsers.id, agentMatrixOutbox.portalUserId))
        .where(and(eq(agentMatrixOutbox.status, 'queued'), lte(agentMatrixOutbox.nextAttemptAt, now), eq(agentPortalUsers.enabled, 1), isNull(agentPortalUsers.deletedAt)))
        .orderBy(asc(agentMatrixOutbox.id))
        .limit(1)
        .for('update');
      const row = rows[0];
      if (!row) return null;
      if (row.outbox.attempts >= AGENT_PORTAL_MAX_DELIVERY_ATTEMPTS) {
        await tx.update(agentMatrixOutbox).set({ status: 'dead', lastError: 'maximum delivery attempts reached', updatedAt: now }).where(eq(agentMatrixOutbox.id, row.outbox.id));
        return null;
      }
      const leaseOwner = `${workerId}:${randomUUID()}`;
      const leaseSeconds = Math.max(30, this.env.AGENT_PORTAL_MATRIX_TIMEOUT_SECONDS + 5);
      await tx
        .update(agentMatrixOutbox)
        .set({ status: 'leased', attempts: row.outbox.attempts + 1, leaseOwner, leaseUntil: isoOffsetSeconds(leaseSeconds), updatedAt: now })
        .where(eq(agentMatrixOutbox.id, row.outbox.id));
      const stored = this.decodeJson<unknown>(row.outbox.payloadEnc, null);
      const envelope = isMatrixDeliveryEnvelope(stored)
        ? stored
        : {
            version: 1 as const,
            idempotency_key: `agent-portal-legacy:${row.outbox.id}`,
            matrix_room: row.user.matrixRoom,
            magic_url: this.magicUrl(row.user, this.decodeText(row.user.tokenEnc)),
            payload: isMatrixPayload(stored)
              ? stored
              : { kind: row.outbox.kind, title: 'Agent portal', status: row.outbox.kind },
          };
      return {
        id: row.outbox.id,
        event_key: row.outbox.eventKey,
        idempotency_key: envelope.idempotency_key,
        matrix_room: envelope.matrix_room,
        magic_url: envelope.magic_url,
        payload: envelope.payload,
        attempts: row.outbox.attempts + 1,
        lease_owner: leaseOwner,
      };
    });
  }

  async completeMatrixDelivery(id: number, leaseOwner: string): Promise<void> {
    const now = nowIso();
    await this.db
      .update(agentMatrixOutbox)
      .set({ status: 'delivered', deliveredAt: now, leaseOwner: null, leaseUntil: null, lastError: null, updatedAt: now })
      .where(and(eq(agentMatrixOutbox.id, id), eq(agentMatrixOutbox.leaseOwner, leaseOwner)));
  }

  async failMatrixDelivery(id: number, leaseOwner: string, attempts: number, error: string): Promise<void> {
    const now = nowIso();
    const dead = attempts >= AGENT_PORTAL_MAX_DELIVERY_ATTEMPTS;
    await this.db
      .update(agentMatrixOutbox)
      .set({
        status: dead ? 'dead' : 'queued',
        nextAttemptAt: dead ? now : isoOffsetSeconds(backoffSeconds(attempts)),
        leaseOwner: null,
        leaseUntil: null,
        lastError: normalizeOptionalText(error, 2000),
        updatedAt: now,
      })
      .where(and(eq(agentMatrixOutbox.id, id), eq(agentMatrixOutbox.leaseOwner, leaseOwner)));
  }

  async purgeExpired(): Promise<{ sessions: number; browser_sessions: number; abandoned_sessions: number }> {
    const now = nowIso();
    const abandonedSessions = await this.expireAbandonedSessions(now);
    const expired = await this.db
      .select({ id: agentSessions.id })
      .from(agentSessions)
      .where(and(lte(agentSessions.expiresAt, now), or(eq(agentSessions.status, 'completed'), eq(agentSessions.status, 'failed'))));
    const ids = expired.map((row) => row.id);
    if (ids.length > 0) {
      await this.db.delete(agentMessages).where(inArray(agentMessages.sessionId, ids));
      await this.db.delete(agentPrompts).where(inArray(agentPrompts.sessionId, ids));
      await this.db.delete(agentEvents).where(inArray(agentEvents.sessionId, ids));
      await this.db.delete(agentMatrixOutbox).where(inArray(agentMatrixOutbox.sessionId, ids));
      await this.db.delete(agentSessions).where(inArray(agentSessions.id, ids));
    }
    const browser = await this.db
      .select({ value: count() })
      .from(agentPortalBrowserSessions)
      .where(or(lte(agentPortalBrowserSessions.expiresAt, now), lt(agentPortalBrowserSessions.revokedAt, isoOffsetSeconds(-7 * 86400))));
    await this.db
      .delete(agentPortalBrowserSessions)
      .where(or(lte(agentPortalBrowserSessions.expiresAt, now), lt(agentPortalBrowserSessions.revokedAt, isoOffsetSeconds(-7 * 86400))));
    return {
      sessions: ids.length,
      browser_sessions: Number(browser[0]?.value ?? 0),
      abandoned_sessions: abandonedSessions,
    };
  }

  async health(): Promise<Record<string, unknown>> {
    const [users, sessions, queued, dead, matrixQueued, matrixDead] = await Promise.all([
      this.db.select({ value: count() }).from(agentPortalUsers).where(and(isNull(agentPortalUsers.deletedAt), eq(agentPortalUsers.enabled, 1))),
      this.db.select({ value: count() }).from(agentSessions).where(inArray(agentSessions.status, [...LIVE_SESSION_STATES])),
      this.db.select({ value: count() }).from(agentMessages).where(inArray(agentMessages.status, ['queued', 'leased'])),
      this.db.select({ value: count() }).from(agentMessages).where(eq(agentMessages.status, 'dead')),
      this.db.select({ value: count() }).from(agentMatrixOutbox).where(inArray(agentMatrixOutbox.status, ['queued', 'leased'])),
      this.db.select({ value: count() }).from(agentMatrixOutbox).where(eq(agentMatrixOutbox.status, 'dead')),
    ]);
    return {
      enabled_users: Number(users[0]?.value ?? 0),
      active_sessions: Number(sessions[0]?.value ?? 0),
      queued_messages: Number(queued[0]?.value ?? 0),
      dead_messages: Number(dead[0]?.value ?? 0),
      queued_matrix: Number(matrixQueued[0]?.value ?? 0),
      dead_matrix: Number(matrixDead[0]?.value ?? 0),
      matrix_configured: Boolean(this.env.MATRIX_API_URL && this.env.MATRIX_API_KEY),
    };
  }

  private async addEventInternal(
    sessionId: string,
    input: AgentEventInput,
    options: EventTransactionOptions = {},
  ): Promise<Record<string, unknown>> {
    if (!AGENT_EVENT_TYPE_SET.has(input.type)) throw new ValidationError('Unsupported agent event type', { param: 'type' });
    const clientEventId = normalizeEventId(input.clientEventId);
    const normalized = normalizeEvent(input.type, input.payload ?? {});
    if (normalized.prompt) {
      normalized.payload.prompt_id = normalized.prompt.id;
      normalized.payload.prompt_version = 1;
    }
    const result = await this.db.transaction(async (tx) => {
      await this.requirePortalEnabledLocked(tx);
      const recipients = NOTIFY_EVENT_TYPES.has(input.type) ? await this.enabledUsersLocked(tx) : [];
      const session = options.bridge
        ? await this.requireBridgeSessionLocked(
            tx,
            sessionId,
            options.bridge.token,
            options.bridge.hostId,
            options.bridge.allowEnded,
          )
        : await this.requireVisibleSessionLocked(tx, sessionId, nowIso());
      if (options.terminal && session.endedAt && session.status !== options.terminal.status) {
        throw new ConflictError('Agent session already ended with a different status', 'agent_session_finished');
      }
      const existing = await tx
        .select()
        .from(agentEvents)
        .where(and(eq(agentEvents.sessionId, sessionId), eq(agentEvents.clientEventId, clientEventId)))
        .limit(1)
        .for('update');
      if (existing[0]) {
        const payload = this.decodeJson<Record<string, unknown>>(existing[0].payloadEnc, {});
        this.assertEventIdempotency(existing[0], input, normalized.payload, payload);
        if (options.terminal && !session.endedAt) {
          await this.applyTerminalState(tx, sessionId, options.terminal.status, options.terminal.expiresAt);
        }
        return { row: existing[0], payload };
      }
      const now = nowIso();
      if (normalized.prompt) {
        await tx
          .update(agentPrompts)
          .set({ status: 'expired', expiresAt: now })
          .where(and(eq(agentPrompts.sessionId, sessionId), eq(agentPrompts.status, 'open')));
        await tx.insert(agentPrompts).values({
          id: normalized.prompt.id,
          sessionId,
          eventId: null,
          questionEnc: this.encodeText(normalized.prompt.question),
          optionsEnc: normalized.prompt.options.length ? this.encodeJson(normalized.prompt.options) : null,
          status: 'open',
          answeredByUserId: null,
          answerMessageId: null,
          version: 1,
          createdAt: now,
          answeredAt: null,
          expiresAt: normalized.prompt.expiresAt,
        });
      }
      await tx.insert(agentEvents).values({
        sessionId,
        clientEventId,
        eventType: input.type,
        source: input.source,
        payloadEnc: this.encodeJson(normalized.payload),
        createdAt: now,
      });
      const inserted = await tx
        .select()
        .from(agentEvents)
        .where(and(eq(agentEvents.sessionId, sessionId), eq(agentEvents.clientEventId, clientEventId)))
        .limit(1);
      const row = inserted[0];
      if (!row) throw new ServiceUnavailableError('Agent event insert was not readable', 'agent_event_write_failed');
      if (normalized.prompt) {
        await tx.update(agentPrompts).set({ eventId: row.id }).where(eq(agentPrompts.id, normalized.prompt.id));
      }
      if (options.terminal) {
        await this.applyTerminalState(tx, sessionId, options.terminal.status, options.terminal.expiresAt, now);
      } else if (input.type === 'waiting_input') {
        await tx
          .update(agentSessions)
          .set({ status: 'waiting', updatedAt: now })
          .where(and(eq(agentSessions.id, sessionId), isNull(agentSessions.endedAt)));
      }
      if (!options.terminal && (input.type === 'assistant_message' || input.type === 'message_accepted')) {
        await tx
          .update(agentSessions)
          .set({ status: 'active', updatedAt: now })
          .where(and(eq(agentSessions.id, sessionId), isNull(agentSessions.endedAt)));
      }
      if (NOTIFY_EVENT_TYPES.has(input.type)) {
        await this.enqueueLifecycleNotifications(sessionId, row.id, input.type, normalized.payload, tx, recipients);
      }
      return { row, payload: normalized.payload };
    });
    return eventView(result.row, result.payload);
  }

  private async enqueueLifecycleNotifications(
    sessionId: string,
    eventId: number,
    type: AgentEventType,
    payload: Record<string, unknown>,
    db: AgentPortalDb = this.db,
    recipients?: AgentPortalUser[],
  ): Promise<void> {
    const sessionRows = await db
      .select({ session: agentSessions, fqdn: hosts.fqdn })
      .from(agentSessions)
      .innerJoin(hosts, eq(hosts.id, agentSessions.hostId))
      .where(eq(agentSessions.id, sessionId))
      .limit(1);
    const row = sessionRows[0];
    if (!row) return;
    const users = recipients ?? await this.enabledUsers(db);
    const title = `${row.session.engine === ENGINE_CLAUDE ? 'Claude' : 'Codex'} on ${row.fqdn}`;
    const status = lifecycleLabel(type);
    const summary = typeof payload.summary === 'string' ? payload.summary : typeof payload.question === 'string' ? 'Agent needs an answer' : undefined;
    const matrixPayload: MatrixPayload = {
      kind: type,
      title,
      status,
      summary: normalizeOptionalText(summary, 1000) ?? undefined,
      engine: row.session.engine,
      host: row.fqdn,
      username: row.session.username,
      cwd: row.session.cwd,
    };
    const minuteBucket = Math.floor(Date.now() / 60_000);
    for (const user of users) {
      const eventKey = type === 'progress' ? `${sessionId}:progress:${minuteBucket}` : `${sessionId}:${eventId}:${type}`;
      await this.insertMatrixOutbox(user, sessionId, eventId, eventKey, type, matrixPayload, db);
    }
  }

  private async expireAbandonedSessions(now: string): Promise<number> {
    const candidates = await this.db
      .select({ id: agentSessions.id })
      .from(agentSessions)
      .where(and(isNull(agentSessions.endedAt), lte(agentSessions.bridgeExpiresAt, now)))
      .orderBy(asc(agentSessions.bridgeExpiresAt))
      .limit(100);
    let expired = 0;
    for (const candidate of candidates) {
      const changed = await this.db.transaction(async (tx) => {
        const enabled = await this.portalEnabledLocked(tx);
        const recipients = enabled ? await this.enabledUsersLocked(tx) : [];
        const rows = await tx
          .select()
          .from(agentSessions)
          .where(eq(agentSessions.id, candidate.id))
          .limit(1)
          .for('update');
        const session = rows[0];
        if (!session || session.endedAt || session.bridgeExpiresAt > now) return false;
        const payload = { summary: 'Agent disconnected before finalization' };
        const existing = await tx
          .select()
          .from(agentEvents)
          .where(and(eq(agentEvents.sessionId, session.id), eq(agentEvents.clientEventId, 'server:abandoned')))
          .limit(1)
          .for('update');
        let eventId = existing[0]?.id;
        if (!eventId) {
          await tx.insert(agentEvents).values({
            sessionId: session.id,
            clientEventId: 'server:abandoned',
            eventType: 'failed',
            source: 'bridge',
            payloadEnc: this.encodeJson(payload),
            createdAt: now,
          });
          const inserted = await tx
            .select({ id: agentEvents.id })
            .from(agentEvents)
            .where(and(eq(agentEvents.sessionId, session.id), eq(agentEvents.clientEventId, 'server:abandoned')))
            .limit(1);
          eventId = inserted[0]?.id;
        }
        if (!eventId) throw new ServiceUnavailableError('Abandoned event insert was not readable', 'agent_event_write_failed');
        await this.applyTerminalState(
          tx,
          session.id,
          'failed',
          isoOffsetSeconds(this.env.AGENT_PORTAL_RETENTION_HOURS * 3600),
          now,
        );
        if (enabled) {
          await this.enqueueLifecycleNotifications(session.id, eventId, 'failed', payload, tx, recipients);
        }
        return true;
      });
      if (changed) expired += 1;
    }
    return expired;
  }

  private async enqueueOnboardingAuthorized(userId: number, reason: string): Promise<boolean> {
    return await this.db.transaction(async (tx) => {
      if (!(await this.portalEnabledLocked(tx))) return false;
      const user = await this.requireUserLocked(tx, userId);
      if (user.enabled !== 1) return false;
      await this.enqueueOnboarding(user, reason, tx);
      return true;
    });
  }

  private async enqueueOnboarding(user: AgentPortalUser, reason: string, db: AgentPortalDb = this.db): Promise<void> {
    const payload: MatrixPayload = {
      kind: 'portal_link',
      title: 'Agent portal',
      status: 'Your permanent fleet agent link',
      summary: 'Open the portal to view and instruct active Codex and Claude agents.',
    };
    await this.insertMatrixOutbox(user, null, null, `portal-link:${reason}:${user.rotatedAt ?? user.updatedAt}`, 'portal_link', payload, db);
  }

  private async insertMatrixOutbox(user: AgentPortalUser, sessionId: string | null, eventId: number | null, eventKey: string, kind: string, payload: MatrixPayload, db: AgentPortalDb = this.db): Promise<void> {
    const now = nowIso();
    const envelope: MatrixDeliveryEnvelope = {
      version: 1,
      idempotency_key: `agent-portal:${randomUUID()}`,
      matrix_room: user.matrixRoom,
      magic_url: this.magicUrl(user, this.decodeText(user.tokenEnc)),
      payload,
    };
    try {
      await db.insert(agentMatrixOutbox).values({
        portalUserId: user.id,
        sessionId,
        eventId,
        eventKey: eventKey.slice(0, 191),
        kind,
        payloadEnc: this.encodeJson(envelope),
        status: 'queued',
        attempts: 0,
        nextAttemptAt: now,
        leaseOwner: null,
        leaseUntil: null,
        lastError: null,
        deliveredAt: null,
        canceledAt: null,
        createdAt: now,
        updatedAt: now,
      });
    } catch (error) {
      // Unique (user,event_key) prevents duplicate outbox work. The encrypted
      // envelope keeps the destination, rendered-link input, payload and
      // cross-service idempotency key immutable across every retry.
      if (!isDuplicateKeyError(error)) throw error;
    }
  }

  private async authenticateBridge(
    sessionId: string,
    rawToken: string,
    hostId?: number,
    allowEnded = false,
  ): Promise<AgentSession> {
    await this.requireEnabled();
    const rows = await this.db
      .select({ session: agentSessions, host: hosts })
      .from(agentSessions)
      .innerJoin(hosts, eq(hosts.id, agentSessions.hostId))
      .where(eq(agentSessions.id, sessionId))
      .limit(1);
    const row = rows[0];
    const session = row?.session;
    if (!session || !safeHashEqual(sha256(rawToken ?? ''), session.bridgeTokenHash)) {
      throw new UnauthorizedError('Invalid agent bridge credential', 'agent_bridge_unauthorized');
    }
    if (hostId !== undefined && session.hostId !== hostId) {
      throw new ForbiddenError('Agent bridge belongs to a different host', 'agent_bridge_host_mismatch');
    }
    if (row.host.status !== 'active') {
      throw new ForbiddenError('Agent bridge host is inactive', 'agent_bridge_host_inactive');
    }
    if (!hostEnginesList(row.host.engines).includes(session.engine as Engine)) {
      throw new ForbiddenError(`Engine ${session.engine} is disabled for this host`, 'engine_disabled');
    }
    if (!safeHashEqual(hostAuthFingerprint(row.host), session.hostAuthFingerprint)) {
      throw new UnauthorizedError('Agent bridge host credential changed', 'agent_bridge_host_auth_changed');
    }
    if (session.endedAt && !allowEnded) throw new ConflictError('Agent session is finished', 'agent_session_finished');
    if (!session.endedAt && session.bridgeExpiresAt <= nowIso()) {
      throw new UnauthorizedError('Agent bridge credential expired', 'agent_bridge_expired');
    }
    return session;
  }

  private async requireEnabled(): Promise<void> {
    if (!(await this.isEnabled())) throw new ServiceUnavailableError('Agent portal is disabled', 'agent_portal_disabled');
  }

  private async portalEnabledLocked(db: AgentPortalDb): Promise<boolean> {
    const rows = await db
      .select({ version: versions.version })
      .from(versions)
      .where(eq(versions.name, AGENT_PORTAL_ENABLED_KEY))
      .limit(1)
      .for('update');
    return isTruthyFlagValue(rows[0]?.version);
  }

  private async requirePortalEnabledLocked(db: AgentPortalDb): Promise<void> {
    if (!(await this.portalEnabledLocked(db))) {
      throw new ServiceUnavailableError('Agent portal is disabled', 'agent_portal_disabled');
    }
  }

  private async requireUser(id: number): Promise<AgentPortalUser> {
    const rows = await this.db
      .select()
      .from(agentPortalUsers)
      .where(and(eq(agentPortalUsers.id, id), isNull(agentPortalUsers.deletedAt)))
      .limit(1);
    if (!rows[0]) throw new NotFoundError('Portal user not found', 'agent_portal_user_not_found');
    return rows[0];
  }

  private async requireUserLocked(db: AgentPortalDb, id: number): Promise<AgentPortalUser> {
    const rows = await db
      .select()
      .from(agentPortalUsers)
      .where(and(eq(agentPortalUsers.id, id), isNull(agentPortalUsers.deletedAt)))
      .limit(1)
      .for('update');
    if (!rows[0]) throw new NotFoundError('Portal user not found', 'agent_portal_user_not_found');
    return rows[0];
  }

  private async userByPublicId(publicId: string): Promise<AgentPortalUser | null> {
    const rows = await this.db
      .select()
      .from(agentPortalUsers)
      .where(eq(agentPortalUsers.publicId, String(publicId ?? '').trim()))
      .limit(1);
    return rows[0] ?? null;
  }

  private async enabledUsers(db: AgentPortalDb = this.db): Promise<AgentPortalUser[]> {
    return await db.select().from(agentPortalUsers).where(and(eq(agentPortalUsers.enabled, 1), isNull(agentPortalUsers.deletedAt)));
  }

  private async enabledUsersLocked(db: AgentPortalDb): Promise<AgentPortalUser[]> {
    return await db
      .select()
      .from(agentPortalUsers)
      .where(and(eq(agentPortalUsers.enabled, 1), isNull(agentPortalUsers.deletedAt)))
      .orderBy(asc(agentPortalUsers.id))
      .for('update');
  }

  private async requireVisibleSession(id: string): Promise<AgentSession> {
    const rows = await this.db.select().from(agentSessions).where(eq(agentSessions.id, id)).limit(1);
    const session = rows[0];
    if (!session || (session.expiresAt && session.expiresAt <= nowIso())) throw new NotFoundError('Agent session not found', 'agent_session_not_found');
    return session;
  }

  private async requireLiveSession(id: string): Promise<AgentSession> {
    const session = await this.requireVisibleSession(id);
    if (session.endedAt || !LIVE_SESSION_STATE_SET.has(session.status)) throw new ConflictError('Agent session is read-only', 'agent_session_finished');
    return session;
  }

  private async requireIdentityLocked(db: AgentPortalDb, identity: PortalIdentity, now: string): Promise<AgentPortalUser> {
    const user = await this.requireUserLocked(db, identity.user.id);
    if (user.enabled !== 1) throw new ForbiddenError('Portal user is disabled', 'agent_portal_user_disabled');
    const sessions = await db
      .select()
      .from(agentPortalBrowserSessions)
      .where(eq(agentPortalBrowserSessions.id, identity.browserSessionId))
      .limit(1)
      .for('update');
    const browser = sessions[0];
    if (
      !browser ||
      browser.userId !== user.id ||
      browser.revokedAt ||
      browser.expiresAt <= now
    ) {
      throw new UnauthorizedError('Portal session expired', 'agent_portal_session_expired');
    }
    return user;
  }

  private async requireVisibleSessionLocked(db: AgentPortalDb, id: string, now: string): Promise<AgentSession> {
    const rows = await db
      .select()
      .from(agentSessions)
      .where(eq(agentSessions.id, id))
      .limit(1)
      .for('update');
    const session = rows[0];
    if (!session || (session.expiresAt && session.expiresAt <= now)) {
      throw new NotFoundError('Agent session not found', 'agent_session_not_found');
    }
    return session;
  }

  private assertLiveSession(session: AgentSession): void {
    if (session.endedAt || !LIVE_SESSION_STATE_SET.has(session.status)) {
      throw new ConflictError('Agent session is read-only', 'agent_session_finished');
    }
  }

  private assertRelayReady(session: AgentSession): void {
    const heartbeat = parseIso(session.heartbeatAt)?.getTime() ?? 0;
    const relayHeartbeat = parseIso(session.relayHeartbeatAt ?? '')?.getTime() ?? 0;
    if (
      heartbeat < Date.now() - AGENT_PORTAL_HEARTBEAT_FRESH_SECONDS * 1000 ||
      session.relayEnabled !== 1 ||
      relayHeartbeat < Date.now() - AGENT_PORTAL_RELAY_FRESH_SECONDS * 1000
    ) {
      throw new ConflictError(
        'Agent is visible but is not currently accepting portal instructions',
        'agent_relay_unavailable',
      );
    }
  }

  private async requireBridgeSessionLocked(
    db: AgentPortalDb,
    sessionId: string,
    rawToken: string,
    expectedHostId: number,
    allowEnded = false,
  ): Promise<AgentSession> {
    const hostRows = await db
      .select()
      .from(hosts)
      .where(eq(hosts.id, expectedHostId))
      .limit(1)
      .for('update');
    const host = hostRows[0];
    const sessions = await db
      .select()
      .from(agentSessions)
      .where(eq(agentSessions.id, sessionId))
      .limit(1)
      .for('update');
    const session = sessions[0];
    if (!session) throw new NotFoundError('Agent session not found', 'agent_session_not_found');
    if (!safeHashEqual(sha256(rawToken ?? ''), session.bridgeTokenHash)) {
      throw new UnauthorizedError('Invalid agent bridge credential', 'agent_bridge_unauthorized');
    }
    if (session.hostId !== expectedHostId) {
      throw new ForbiddenError('Agent bridge belongs to a different host', 'agent_bridge_host_mismatch');
    }
    if (!host || host.status !== 'active') {
      throw new ForbiddenError('Agent bridge host is inactive', 'agent_bridge_host_inactive');
    }
    if (!hostEnginesList(host.engines).includes(session.engine as Engine)) {
      throw new ForbiddenError(`Engine ${session.engine} is disabled for this host`, 'engine_disabled');
    }
    if (!safeHashEqual(hostAuthFingerprint(host), session.hostAuthFingerprint)) {
      throw new UnauthorizedError('Agent bridge host credential changed', 'agent_bridge_host_auth_changed');
    }
    if (session.endedAt && !allowEnded) {
      throw new ConflictError('Agent session is finished', 'agent_session_finished');
    }
    if (!session.endedAt && session.bridgeExpiresAt <= nowIso()) {
      throw new UnauthorizedError('Agent bridge credential expired', 'agent_bridge_expired');
    }
    return session;
  }

  private async applyTerminalState(
    db: AgentPortalDb,
    sessionId: string,
    status: 'completed' | 'failed',
    expiresAt: string,
    now = nowIso(),
  ): Promise<void> {
    await db
      .update(agentSessions)
      .set({
        status,
        relayEnabled: 0,
        relayHeartbeatAt: null,
        endedAt: now,
        expiresAt,
        activeTurnId: null,
        updatedAt: now,
      })
      .where(eq(agentSessions.id, sessionId));
    await this.cancelSessionPending(sessionId, now, db);
  }

  private async findMessageByClientId(
    sessionId: string,
    clientMessageId: string,
    db: AgentPortalDb = this.db,
    forUpdate = false,
  ): Promise<AgentMessage | null> {
    const query = db
      .select()
      .from(agentMessages)
      .where(and(eq(agentMessages.sessionId, sessionId), eq(agentMessages.clientMessageId, clientMessageId)))
      .limit(1);
    const rows = forUpdate ? await query.for('update') : await query;
    return rows[0] ?? null;
  }

  private assertMessageIdempotency(
    row: AgentMessage,
    portalUserId: number,
    kind: 'message' | 'answer',
    promptId: string | null,
    content: string,
  ): void {
    if (
      row.portalUserId !== portalUserId ||
      row.kind !== kind ||
      row.promptId !== promptId ||
      this.decodeText(row.contentEnc) !== content
    ) {
      throw new ConflictError(
        'client_message_id was already used for different content',
        'client_message_id_conflict',
      );
    }
  }

  private assertEventIdempotency(
    row: typeof agentEvents.$inferSelect,
    input: AgentEventInput,
    requestedPayload: Record<string, unknown>,
    storedPayload: Record<string, unknown>,
  ): void {
    if (
      row.eventType !== input.type ||
      row.source !== input.source ||
      JSON.stringify(storedPayload) !== JSON.stringify(requestedPayload)
    ) {
      throw new ConflictError(
        'client_event_id was already used for a different event',
        'client_event_id_conflict',
      );
    }
  }

  private async insertPortalMessageEvent(
    db: AgentPortalDb,
    sessionId: string,
    messageId: string,
    payload: Record<string, unknown>,
    now: string,
  ): Promise<void> {
    const normalized = normalizeEvent('user_message', payload);
    await db.insert(agentEvents).values({
      sessionId,
      clientEventId: `portal:${messageId}`,
      eventType: 'user_message',
      source: 'portal',
      payloadEnc: this.encodeJson(normalized.payload),
      createdAt: now,
    });
  }

  private async disableUserRows(userId: number, now: string, db: AgentPortalDb = this.db): Promise<{ canceled: number; revoked_sessions: number }> {
    const pendingAnswers = await db
      .select({ messageId: agentMessages.messageId, promptId: agentMessages.promptId, sessionId: agentMessages.sessionId })
      .from(agentMessages)
      .where(and(
        eq(agentMessages.portalUserId, userId),
        eq(agentMessages.kind, 'answer'),
        inArray(agentMessages.status, ['queued', 'leased']),
      ));
    const pending = await db
      .select({ value: count() })
      .from(agentMessages)
      .where(and(eq(agentMessages.portalUserId, userId), inArray(agentMessages.status, ['queued', 'leased'])));
    const sessions = await db
      .select({ value: count() })
      .from(agentPortalBrowserSessions)
      .where(and(eq(agentPortalBrowserSessions.userId, userId), isNull(agentPortalBrowserSessions.revokedAt)));
    await db
      .update(agentMessages)
      .set({ status: 'canceled', canceledAt: now, leaseOwner: null, leaseUntil: null, updatedAt: now })
      .where(and(eq(agentMessages.portalUserId, userId), inArray(agentMessages.status, ['queued', 'leased'])));
    await this.reconcileDisabledUserAnswers(pendingAnswers, now, db);
    await db
      .update(agentMatrixOutbox)
      .set({ status: 'canceled', canceledAt: now, leaseOwner: null, leaseUntil: null, updatedAt: now })
      .where(and(eq(agentMatrixOutbox.portalUserId, userId), inArray(agentMatrixOutbox.status, ['queued', 'leased'])));
    await db
      .update(agentPortalBrowserSessions)
      .set({ revokedAt: now })
      .where(and(eq(agentPortalBrowserSessions.userId, userId), isNull(agentPortalBrowserSessions.revokedAt)));
    return { canceled: Number(pending[0]?.value ?? 0), revoked_sessions: Number(sessions[0]?.value ?? 0) };
  }

  private async cancelSessionPending(sessionId: string, now: string, db: AgentPortalDb = this.db): Promise<void> {
    const pendingAnswers = await db
      .select({ messageId: agentMessages.messageId })
      .from(agentMessages)
      .where(and(
        eq(agentMessages.sessionId, sessionId),
        eq(agentMessages.kind, 'answer'),
        inArray(agentMessages.status, ['queued', 'leased']),
      ));
    await db
      .update(agentMessages)
      .set({ status: 'canceled', canceledAt: now, leaseOwner: null, leaseUntil: null, updatedAt: now })
      .where(and(eq(agentMessages.sessionId, sessionId), inArray(agentMessages.status, ['queued', 'leased'])));
    await db
      .update(agentPrompts)
      .set({ status: 'expired', expiresAt: now, version: sql`${agentPrompts.version} + 1` })
      .where(and(eq(agentPrompts.sessionId, sessionId), eq(agentPrompts.status, 'open')));
    await this.expirePromptsForAnswerMessages(
      pendingAnswers.map((row) => row.messageId),
      now,
      db,
    );
  }

  private async reconcileDisabledUserAnswers(
    answers: Array<{ messageId: string; promptId: string | null; sessionId: string }>,
    now: string,
    db: AgentPortalDb,
  ): Promise<void> {
    if (answers.length === 0) return;
    const messageById = new Map(answers.map((answer) => [answer.messageId, answer]));
    const sessionIds = [...new Set(answers.map((answer) => answer.sessionId))];
    const sessions = await db
      .select()
      .from(agentSessions)
      .where(inArray(agentSessions.id, sessionIds))
      .for('update');
    const sessionById = new Map(sessions.map((session) => [session.id, session]));
    const prompts = await db
      .select()
      .from(agentPrompts)
      .where(and(
        eq(agentPrompts.status, 'answered'),
        inArray(agentPrompts.answerMessageId, answers.map((answer) => answer.messageId)),
      ))
      .for('update');
    for (const prompt of prompts) {
      const answer = prompt.answerMessageId ? messageById.get(prompt.answerMessageId) : undefined;
      const session = answer ? sessionById.get(answer.sessionId) : undefined;
      const canReopen = Boolean(
        answer?.promptId === prompt.id &&
        session &&
        !session.endedAt &&
        LIVE_SESSION_STATE_SET.has(session.status) &&
        (!prompt.expiresAt || prompt.expiresAt > now),
      );
      await db
        .update(agentPrompts)
        .set({
          status: canReopen ? 'open' : 'expired',
          answeredByUserId: null,
          answerMessageId: null,
          answeredAt: null,
          expiresAt: canReopen ? prompt.expiresAt : now,
          version: sql`${agentPrompts.version} + 1`,
        })
        .where(eq(agentPrompts.id, prompt.id));
    }
  }

  private async expirePromptsForAnswerMessages(
    messageIds: string[],
    now: string,
    db: AgentPortalDb,
  ): Promise<void> {
    if (messageIds.length === 0) return;
    await db
      .update(agentPrompts)
      .set({
        status: 'expired',
        answeredByUserId: null,
        answerMessageId: null,
        answeredAt: null,
        expiresAt: now,
        version: sql`${agentPrompts.version} + 1`,
      })
      .where(and(
        eq(agentPrompts.status, 'answered'),
        inArray(agentPrompts.answerMessageId, messageIds),
      ));
  }

  private async releaseUndeliveredAnswerPrompt(
    message: AgentMessage,
    session: AgentSession,
    now: string,
    db: AgentPortalDb,
  ): Promise<void> {
    if (message.kind !== 'answer' || !message.promptId) return;
    const rows = await db
      .select()
      .from(agentPrompts)
      .where(eq(agentPrompts.id, message.promptId))
      .limit(1)
      .for('update');
    const prompt = rows[0];
    if (
      !prompt ||
      prompt.status !== 'answered' ||
      prompt.answerMessageId !== message.messageId
    ) return;
    const canReopen = !session.endedAt &&
      LIVE_SESSION_STATE_SET.has(session.status) &&
      (!prompt.expiresAt || prompt.expiresAt > now);
    await db
      .update(agentPrompts)
      .set({
        status: canReopen ? 'open' : 'expired',
        answeredByUserId: null,
        answerMessageId: null,
        answeredAt: null,
        expiresAt: canReopen ? prompt.expiresAt : now,
        version: sql`${agentPrompts.version} + 1`,
      })
      .where(eq(agentPrompts.id, prompt.id));
  }

  private async countPendingMessages(): Promise<number> {
    const rows = await this.db.select({ value: count() }).from(agentMessages).where(inArray(agentMessages.status, ['queued', 'leased']));
    return Number(rows[0]?.value ?? 0);
  }

  private magicUrl(user: Pick<AgentPortalUser, 'publicId'>, token: string): string {
    const base = this.env.PUBLIC_BASE_URL?.trim().replace(/\/$/, '');
    if (!base) throw new ServiceUnavailableError('PUBLIC_BASE_URL is not configured', 'agent_portal_not_configured');
    return `${base}/go/u/${encodeURIComponent(user.publicId)}#t=${encodeURIComponent(token)}`;
  }

  private encodeText(value: string): string {
    return encrypt(value, this.keyring);
  }

  private decodeText(value: string): string {
    return decrypt(value, this.keyring);
  }

  private encodeJson(value: unknown): string {
    return encrypt(JSON.stringify(value), this.keyring);
  }

  private decodeJson<T>(value: string, fallback: T): T {
    try {
      return JSON.parse(decrypt(value, this.keyring)) as T;
    } catch {
      return fallback;
    }
  }
}

export function createAgentPortalService(db: Database, env: Env, keyring: Keyring): AgentPortalService {
  return new AgentPortalService(db, env, keyring);
}

function portalUserView(user: AgentPortalUser): PortalUserView {
  return {
    id: user.id,
    display_name: user.displayName,
    matrix_room: user.matrixRoom,
    enabled: user.enabled === 1,
    public_id: user.publicId,
    created_at: user.createdAt,
    updated_at: user.updatedAt,
    last_used_at: user.lastUsedAt,
    disabled_at: user.disabledAt,
    rotated_at: user.rotatedAt,
  };
}

function normalizeRequiredText(value: unknown, param: string, max: number): string {
  if (typeof value !== 'string' || !value.trim()) throw new ValidationError(`${param} is required`, { param });
  const normalized = value.trim();
  if (Buffer.byteLength(normalized, 'utf8') > max) throw new ValidationError(`${param} is too long`, { param });
  return normalized;
}

function normalizeOptionalText(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  if (!normalized) return null;
  return Buffer.byteLength(normalized, 'utf8') > max ? Buffer.from(normalized).subarray(0, max).toString('utf8') : normalized;
}

function normalizeMatrixRoom(value: unknown): string {
  const room = normalizeRequiredText(value, 'matrix_room', 255);
  if (/\p{Cc}/u.test(room)) throw new ValidationError('matrix_room contains control characters', { param: 'matrix_room' });
  return room;
}

function normalizeMessage(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) throw new ValidationError('message text is required', { param: 'content' });
  const text = value.trim();
  if (Buffer.byteLength(text, 'utf8') > AGENT_PORTAL_MESSAGE_MAX_BYTES) {
    throw new ValidationError(`message exceeds ${AGENT_PORTAL_MESSAGE_MAX_BYTES} bytes`, { param: 'content' });
  }
  return text;
}

function normalizeUuid(value: unknown, param: string): string {
  const text = String(value ?? '').trim().toLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(text)) {
    throw new ValidationError(`${param} must be a UUID`, { param });
  }
  return text;
}

function normalizeBridgeToken(value: unknown): string {
  const token = String(value ?? '').trim();
  if (token.length < 43 || token.length > 128 || !/^[A-Za-z0-9_-]+$/.test(token)) {
    throw new ValidationError('bridge_token must be a 43-128 character base64url value', { param: 'bridge_token' });
  }
  return token;
}

function normalizeEventId(value: unknown): string {
  const text = String(value ?? '').trim();
  if (!text || text.length > 64 || !/^[A-Za-z0-9._:-]+$/.test(text)) {
    throw new ValidationError('client_event_id must contain only letters, digits, dot, underscore, colon or dash', { param: 'client_event_id' });
  }
  return text;
}

function normalizeEvent(type: AgentEventType, input: Record<string, unknown>): NormalizedEvent {
  const payload: Record<string, unknown> = {};
  if (type === 'user_message' || type === 'assistant_message') {
    const text = normalizeRequiredText(input.text, 'text', AGENT_PORTAL_EVENT_TEXT_MAX_BYTES);
    payload.text = text;
  }
  const summary = normalizeOptionalText(input.summary, 1000);
  if (summary) payload.summary = summary;
  const messageId = normalizeOptionalText(input.message_id, 64);
  if (messageId) payload.message_id = messageId;
  const promptId = normalizeOptionalText(input.prompt_id, 36);
  if (promptId && /^[0-9a-f-]{36}$/i.test(promptId)) payload.prompt_id = promptId;
  const upstreamId = normalizeOptionalText(input.upstream_id, 255);
  if (upstreamId) payload.upstream_id = upstreamId;
  const author = normalizeOptionalText(input.author, 255);
  if (author) payload.author = author;
  const deliveryStatus = normalizeOptionalText(input.delivery_status, 32);
  if (deliveryStatus) payload.delivery_status = deliveryStatus;

  if (type === 'waiting_input') {
    const question = normalizeRequiredText(input.question, 'question', 16 * 1024);
    payload.question = question;
    const allowAnswer = input.allow_answer !== false;
    payload.allow_answer = allowAnswer;
    const options = Array.isArray(input.options)
      ? input.options.slice(0, 20).map((value) => normalizeRequiredText(String(value), 'options', 500))
      : [];
    if (options.length) payload.options = options;
    if (allowAnswer) {
      const promptId = normalizeUuid(input.prompt_id, 'prompt_id');
      return {
        payload,
        prompt: {
          id: promptId,
          question,
          options,
          expiresAt: typeof input.expires_at === 'string' && parseIso(input.expires_at) ? input.expires_at : null,
        },
      };
    }
  }
  return { payload };
}

function isMatrixPayload(value: unknown): value is MatrixPayload {
  if (!value || typeof value !== 'object') return false;
  const payload = value as Record<string, unknown>;
  return typeof payload.kind === 'string' && typeof payload.title === 'string' && typeof payload.status === 'string';
}

function isMatrixDeliveryEnvelope(value: unknown): value is MatrixDeliveryEnvelope {
  if (!value || typeof value !== 'object') return false;
  const envelope = value as Record<string, unknown>;
  return envelope.version === 1 &&
    typeof envelope.idempotency_key === 'string' &&
    typeof envelope.matrix_room === 'string' &&
    typeof envelope.magic_url === 'string' &&
    isMatrixPayload(envelope.payload);
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

function extractInsertId(result: unknown): number {
  if (Array.isArray(result)) {
    for (const entry of result) {
      const id = extractInsertId(entry);
      if (id) return id;
    }
    return 0;
  }
  if (result && typeof result === 'object' && 'insertId' in result) {
    const value = Number((result as { insertId?: unknown }).insertId ?? 0);
    return Number.isFinite(value) ? value : 0;
  }
  return 0;
}

function messageView(row: typeof agentMessages.$inferSelect): Record<string, unknown> {
  return {
    message_id: row.messageId,
    sequence: row.id,
    session_id: row.sessionId,
    kind: row.kind,
    prompt_id: row.promptId,
    client_message_id: row.clientMessageId,
    status: row.status,
    attempts: row.attempts,
    upstream_id: row.upstreamId,
    last_error: row.lastError,
    accepted_at: row.acceptedAt,
    canceled_at: row.canceledAt,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  };
}

function eventView(row: typeof agentEvents.$inferSelect, payload: Record<string, unknown>): Record<string, unknown> {
  return { cursor: row.id, session_id: row.sessionId, type: row.eventType, source: row.source, payload, created_at: row.createdAt };
}

function lifecycleLabel(type: AgentEventType): string {
  switch (type) {
    case 'started': return 'Started';
    case 'resumed': return 'Resumed';
    case 'progress': return 'Progress';
    case 'waiting_input': return 'Needs your answer';
    case 'terminal_block': return 'Terminal approval required';
    case 'attention': return 'Attention requested';
    case 'failed': return 'Failed';
    case 'completed': return 'Completed';
    default: return type;
  }
}

function backoffSeconds(attempts: number): number {
  return Math.min(300, Math.max(2, 2 ** Math.min(8, Math.max(1, attempts))));
}
