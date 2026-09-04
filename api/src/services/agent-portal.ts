import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
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
  lt,
  lte,
  not,
  or,
  sql,
} from 'drizzle-orm';
import type { Database } from '../db/client.js';
import {
  agentEvents,
  agentMessages,
  agentPortalBrowserSessions,
  agentPortalUsers,
  agentPrompts,
  agentSessions,
  adminUsers,
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
import { releaseAgentMessagingBindingsLocked } from './agent-messaging.js';

export const AGENT_PORTAL_ENABLED_KEY = 'agent_portal_enabled';
export const AGENT_PORTAL_MESSAGE_MAX_BYTES = 32 * 1024;
export const AGENT_PORTAL_EVENT_TEXT_MAX_BYTES = 128 * 1024;
export const AGENT_PORTAL_MAX_DELIVERY_ATTEMPTS = 12;
/**
 * How long an `active_turn_id` may stand before the session stops counting as
 * `working`, expressed as a multiple of the relay window so there is one knob
 * to reason about rather than a third constant.
 *
 * The ceiling exists because `active_turn_id` is sticky: it is stamped by
 * `cxx portal accept` and cleared by `say`/`wait`/`leave`, so a model turn that
 * dies mid-instruction leaves it set while the wrapper's 15s ticker keeps the
 * heartbeat fresh. Without a bound that reads as "Working" -- and stays
 * writable -- until the bridge TTL lapses, which is a worse lie than the one
 * the relay window was tightened to remove.
 */
export const AGENT_PORTAL_WORKING_RELAY_MULTIPLE = 10;
export const AGENT_PORTAL_CLOSE_NOTE_MAX_BYTES = 1000;
export const AGENT_PORTAL_DEFAULT_CLOSE_NOTE = 'The operator closed this channel from the portal.';

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
  'close_requested',
  // The operator's instruction was accepted into the queue and then discarded
  // without any agent ever claiming it. Server-written only: an agent that is
  // in a position to report this is by definition still polling.
  'message_canceled',
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
const LIVE_SESSION_STATES = ['starting', 'active', 'waiting', 'offline'] as const;
const LIVE_SESSION_STATE_SET = new Set<string>(LIVE_SESSION_STATES);

/**
 * How the portal describes a session to the browser.
 *
 * `agent_sessions.status` cannot answer this. `registerAgent` writes 'active'
 * once and the wrapper's heartbeat ticker posts an empty status every 15s, which
 * `heartbeatAgent` deliberately treats as "keep what you had" -- so `status`
 * reads 'active' for the entire life of the wrapper process whether or not the
 * agent is reachable. `presence` is the honest signal and is what the UI shows.
 *
 * `idle` is the state that was previously invisible: the wrapper is alive and
 * heartbeating, but no `#afk` relay is open, so instructions would be refused.
 *
 * `working` splits the case `idle` used to swallow. The relay loop is
 * wait -> accept -> execute -> say -> wait, and nothing polls during execute,
 * so a busy agent's relay heartbeat goes stale and it used to read "Not
 * listening -- run #afk to open the relay" while it was doing exactly what it
 * was asked. It is derived from `active_turn_id` and is bounded: see
 * AGENT_PORTAL_WORKING_RELAY_MULTIPLE.
 */
export const AGENT_PRESENCE_STATES = ['ended', 'offline', 'idle', 'listening', 'working'] as const;
export type AgentPresence = (typeof AGENT_PRESENCE_STATES)[number];

/**
 * An outstanding attention notice is one the operator has not acted on yet. It
 * is derived from event cursors rather than stored, so there is no read state to
 * keep in sync: a notice counts as outstanding while its cursor is newer than
 * every acknowledging event.
 *
 * `insertPortalMessageEvent` writes `user_message` for plain messages *and* for
 * prompt answers, so answering a prompt clears the notice -- intended, and
 * pinned by a test. Requesting a close is a stronger acknowledgement still.
 */
const AGENT_ATTENTION_CLEARING_EVENT_TYPES = ['user_message', 'close_requested'] as const;

/** Lifecycle of the operator's close note, read off the queued message row. */
export const AGENT_CLOSE_STATES = ['pending', 'acknowledged', 'undeliverable'] as const;
export type AgentCloseState = (typeof AGENT_CLOSE_STATES)[number];

export interface PortalUserView {
  id: number;
  display_name: string;
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

/**
 * Who is acting on a session.
 *
 * The portal authenticates a magic-link `agent_portal_users` row; the console
 * authenticates an `admin_users` row over its own session cookie. They are
 * separate identity tables, and `0027_agent_messages_admin_actor.sql` is what
 * lets both reach the message queue: `agent_messages` now carries a nullable
 * column for each, exactly one set.
 *
 * The kind travels with the id everywhere, and that is not decoration. Message
 * idempotency compares the author, so comparing bare numbers across two tables
 * would let admin #3 silently satisfy a retry authored by portal user #3.
 */
export type PortalActor =
  | { kind: 'portal'; identity: PortalIdentity }
  | { kind: 'admin'; user: { id: number; displayName: string } };

/** An actor resolved against its own identity table, inside the write's lock. */
interface ResolvedActor {
  kind: 'portal' | 'admin';
  id: number;
  /** What the agent's own timeline shows as the author of the message. */
  displayName: string;
}

/** The `agent_messages` author columns for an actor; exactly one is non-null. */
function actorColumns(actor: ResolvedActor): { portalUserId: number | null; adminUserId: number | null } {
  return actor.kind === 'admin'
    ? { portalUserId: null, adminUserId: actor.id }
    : { portalUserId: actor.id, adminUserId: null };
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
  kind: 'message' | 'answer' | 'close';
  prompt_id: string | null;
  content: string;
  attempts: number;
  lease_owner: string;
  created_at: string;
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

  /**
   * The portal is entirely pull-based: the only thing it needs configured is the
   * origin its permanent links are rendered against.
   */
  configured(): boolean {
    return Boolean(this.env.PUBLIC_BASE_URL?.trim());
  }

  /** Ceiling on how long an `active_turn_id` may stand. See the constant. */
  private workingMaxSeconds(): number {
    return this.env.AGENT_PORTAL_RELAY_FRESH_SECONDS * AGENT_PORTAL_WORKING_RELAY_MULTIPLE;
  }

  /**
   * The freshness windows the browser needs to age presence between polls
   * without duplicating the numbers. They used to be literals on both sides.
   */
  timings(): { heartbeat_fresh_seconds: number; relay_fresh_seconds: number; retention_hours: number } {
    return {
      heartbeat_fresh_seconds: this.env.AGENT_PORTAL_HEARTBEAT_FRESH_SECONDS,
      relay_fresh_seconds: this.env.AGENT_PORTAL_RELAY_FRESH_SECONDS,
      retention_hours: this.env.AGENT_PORTAL_RETENTION_HOURS,
    };
  }

  async state(): Promise<Record<string, unknown>> {
    const enabled = await this.isEnabled();
    const health = await this.health();
    return { enabled, initial_default: false, configured: this.configured(), ...health };
  }

  async setEnabled(enabled: boolean): Promise<{ enabled: boolean; canceled: number; revoked_sessions: number }> {
    if (enabled && !this.configured()) {
      throw new ServiceUnavailableError(
        'PUBLIC_BASE_URL is required before enabling the agent portal',
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

  async createUser(input: { displayName: string; enabled?: boolean }): Promise<{ user: PortalUserView; magic_url: string }> {
    const displayName = normalizeRequiredText(input.displayName, 'display_name', 255);
    const token = randomBytes(32).toString('base64url');
    const now = nowIso();
    const publicId = randomHex(16);
    await this.db.insert(agentPortalUsers).values({
      displayName,
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
    return { user: portalUserView(user), magic_url: this.magicUrl(user, token) };
  }

  /**
   * Re-renders the stored permanent link for an owner/admin so it can be
   * bookmarked from the admin page without rotating the token. Deliberately its
   * own owner/admin-gated call: `PortalUserView` is also served to the portal
   * itself, so the bearer material never rides along on a listing.
   */
  async revealUserLink(id: number): Promise<{ user: PortalUserView; magic_url: string }> {
    const rows = await this.db
      .select()
      .from(agentPortalUsers)
      .where(and(eq(agentPortalUsers.id, id), isNull(agentPortalUsers.deletedAt)))
      .limit(1);
    const user = rows[0];
    if (!user) throw new NotFoundError('Portal user not found', 'agent_portal_user_not_found');
    return { user: portalUserView(user), magic_url: this.magicUrl(user, this.decodeText(user.tokenEnc)) };
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
    return result;
  }

  async updateUser(id: number, input: { displayName?: string }): Promise<PortalUserView> {
    const patch: Partial<typeof agentPortalUsers.$inferInsert> = { updatedAt: nowIso() };
    if (input.displayName !== undefined) patch.displayName = normalizeRequiredText(input.displayName, 'display_name', 255);
    const user = await this.db.transaction(async (tx) => {
      await this.portalEnabledLocked(tx);
      await this.requireUserLocked(tx, id);
      await tx.update(agentPortalUsers).set(patch).where(eq(agentPortalUsers.id, id));
      const rows = await tx.select().from(agentPortalUsers).where(eq(agentPortalUsers.id, id)).limit(1);
      return rows[0]!;
    });
    return portalUserView(user);
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
      const rows = await tx.select().from(agentPortalUsers).where(eq(agentPortalUsers.id, id)).limit(1);
      return { user: rows[0]!, revoked: Number(sessions[0]?.value ?? 0) };
    });
    return {
      user: portalUserView(result.user),
      magic_url: this.magicUrl(result.user, token),
      revoked_sessions: result.revoked,
    };
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
        // `cxx portal leave` is how an agent acts *on* a close note, so a close
        // it has already claimed must survive its own leave.
        await this.cancelSessionPending(sessionId, now, tx, { keepLeasedClose: true });
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
    // One grouped aggregate over every visible session, served by
    // idx_agent_events_session_cursor. Ordering is by `id`, never `created_at`:
    // nowIso() strips milliseconds while other writers keep them, so a
    // lexicographic compare mis-orders the two forms inside the same second.
    const eventStats = sessionIds.length
      ? await this.db
          .select({
            sessionId: agentEvents.sessionId,
            lastId: sql<number>`MAX(${agentEvents.id})`,
            attentionId: sql<
              number | null
            >`MAX(CASE WHEN ${agentEvents.eventType} = 'attention' THEN ${agentEvents.id} END)`,
            clearedId: sql<number | null>`MAX(CASE WHEN ${agentEvents.eventType} IN (${sql.join(
              AGENT_ATTENTION_CLEARING_EVENT_TYPES.map((type) => sql`${type}`),
              sql`, `,
            )}) THEN ${agentEvents.id} END)`,
            // When the current turn began. `agent_sessions` records which turn
            // is active but not when it started, and the acceptance event
            // already carries that timestamp -- so the working ceiling needs no
            // migration.
            turnStartedId: sql<
              number | null
            >`MAX(CASE WHEN ${agentEvents.eventType} = 'message_accepted' THEN ${agentEvents.id} END)`,
          })
          .from(agentEvents)
          .where(inArray(agentEvents.sessionId, sessionIds))
          .groupBy(agentEvents.sessionId)
      : [];

    // Only fetch the rows actually rendered: the newest event of every session
    // (for last_event_at) plus the specific attention notice that is still
    // outstanding. Payloads are secretbox-encrypted, so the summary has to be
    // decoded in JS -- doing that for every event would be needless work.
    const statsBySession = new Map<string, (typeof eventStats)[number]>();
    const detailIds = new Set<number>();
    const turnSessions = new Set(rows.filter((row) => row.session.activeTurnId).map((row) => row.session.id));
    for (const stat of eventStats) {
      statsBySession.set(stat.sessionId, stat);
      detailIds.add(Number(stat.lastId));
      const attentionId = Number(stat.attentionId ?? 0);
      if (attentionId > Number(stat.clearedId ?? 0)) detailIds.add(attentionId);
      const turnStartedId = Number(stat.turnStartedId ?? 0);
      if (turnStartedId && turnSessions.has(stat.sessionId)) detailIds.add(turnStartedId);
    }
    const detailRows = detailIds.size
      ? await this.db
          .select({ id: agentEvents.id, createdAt: agentEvents.createdAt, payloadEnc: agentEvents.payloadEnc })
          .from(agentEvents)
          .where(inArray(agentEvents.id, [...detailIds]))
      : [];
    const detailById = new Map(detailRows.map((row) => [Number(row.id), row]));

    // The close note's own row is what distinguishes "asked, not claimed yet"
    // from "the agent honoured it and left" -- both leave presence at 'idle',
    // and close_requested_at is never cleared, so it cannot tell them apart.
    const closeRows = sessionIds.length
      ? await this.db
          .select({
            id: agentMessages.id,
            sessionId: agentMessages.sessionId,
            status: agentMessages.status,
            createdAt: agentMessages.createdAt,
          })
          .from(agentMessages)
          .where(and(inArray(agentMessages.sessionId, sessionIds), eq(agentMessages.kind, 'close')))
          .orderBy(desc(agentMessages.id))
      : [];
    const closeBySession = new Map<string, (typeof closeRows)[number]>();
    for (const row of closeRows) {
      if (!closeBySession.has(row.sessionId)) closeBySession.set(row.sessionId, row);
    }

    const offlineBefore = Date.now() - this.env.AGENT_PORTAL_HEARTBEAT_FRESH_SECONDS * 1000;
    const relayBefore = Date.now() - this.env.AGENT_PORTAL_RELAY_FRESH_SECONDS * 1000;
    const workingBefore = Date.now() - this.workingMaxSeconds() * 1000;
    return rows.map(({ session, fqdn }) => {
      const heartbeat = parseIso(session.heartbeatAt)?.getTime() ?? 0;
      const heartbeatFresh = heartbeat >= offlineBefore;
      const effectiveStatus = LIVE_SESSION_STATE_SET.has(session.status) && !heartbeatFresh ? 'offline' : session.status;
      const relayHeartbeat = parseIso(session.relayHeartbeatAt ?? '')?.getTime() ?? 0;
      const relayReady = !session.endedAt && heartbeatFresh && session.relayEnabled === 1 && relayHeartbeat >= relayBefore;

      // A session with no events yet (registered, `server:started` not committed)
      // produces no aggregate row at all.
      const stats = statsBySession.get(session.id);
      const lastEvent = stats ? detailById.get(Number(stats.lastId)) : undefined;

      // `working` is deliberately independent of relay freshness. The `#afk`
      // loop is wait -> accept -> execute -> say -> wait, and nothing polls
      // during execute -- so gating this on relayReady would report a genuinely
      // busy agent as "Not listening", which is the ambiguity the state exists
      // to remove. The ceiling is what keeps that honest: past it the turn is
      // presumed dead and the session falls back through the normal ladder.
      const turnStartedEvent = session.activeTurnId
        ? detailById.get(Number(stats?.turnStartedId ?? 0))
        : undefined;
      const turnStartedAt = turnStartedEvent?.createdAt ?? null;
      const turnStarted = parseIso(turnStartedAt ?? '')?.getTime() ?? 0;
      // An unknown start time cannot be aged out, so treat it as expired rather
      // than as a turn that has been running forever.
      const working =
        !session.endedAt && heartbeatFresh && Boolean(session.activeTurnId) && turnStarted >= workingBefore;

      const presence: AgentPresence = session.endedAt
        ? 'ended'
        : !heartbeatFresh
          ? 'offline'
          : working
            ? 'working'
            : relayReady
              ? 'listening'
              : 'idle';

      // An ended session cannot be answered, so its notice must stop counting
      // as outstanding -- otherwise a crashed agent sits in "Needs you" for the
      // whole retention window with no action that clears it. There is no
      // cursor to write here: attention is derived from `attentionId >
      // clearedId`, and manufacturing a `close_requested` event would invent an
      // operator action that never happened. Gating the projection is the fix.
      // The notice stays in the timeline; only the badge is released.
      const attentionId = Number(stats?.attentionId ?? 0);
      const attentionRow =
        !session.endedAt && attentionId > Number(stats?.clearedId ?? 0)
          ? detailById.get(attentionId)
          : undefined;
      const closeRow = closeBySession.get(session.id);

      return {
        id: session.id,
        engine: session.engine,
        host: fqdn,
        host_id: session.hostId,
        username: session.username,
        cwd: session.cwd,
        invocation_kind: session.invocationKind,
        upstream_session_id: session.upstreamSessionId,
        // Retained for compatibility only. See AGENT_PRESENCE_STATES: this field
        // is not a liveness signal. Read `presence`.
        status: effectiveStatus,
        presence,
        relay_ready: relayReady,
        active_turn_id: session.activeTurnId,
        active_turn_started_at: working ? turnStartedAt : null,
        started_at: session.startedAt,
        heartbeat_at: session.heartbeatAt,
        last_event_at: lastEvent?.createdAt ?? null,
        attention: attentionRow
          ? {
              since: attentionRow.createdAt,
              summary:
                (this.decodeJson<Record<string, unknown>>(attentionRow.payloadEnc, {}).summary as
                  | string
                  | undefined) ?? null,
            }
          : null,
        ended_at: session.endedAt,
        expires_at: session.expiresAt,
        close_requested_at: session.closeRequestedAt,
        close: closeRow
          ? { requested_at: session.closeRequestedAt ?? closeRow.createdAt, state: closeState(closeRow.status) }
          : null,
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

  async enqueueMessage(actor: PortalActor, input: { sessionId: string; clientMessageId: string; content: string }): Promise<Record<string, unknown>> {
    const content = normalizeMessage(input.content);
    const clientMessageId = normalizeUuid(input.clientMessageId, 'client_message_id');
    const messageId = randomUUID();
    const now = nowIso();
    const inserted = await this.db.transaction(async (tx) => {
      await this.requirePortalEnabledLocked(tx);
      const user = await this.requireActorLocked(tx, actor, now);
      const session = await this.requireVisibleSessionLocked(tx, input.sessionId, now);
      const raced = await this.findMessageByClientId(input.sessionId, clientMessageId, tx, true);
      if (raced) {
        this.assertMessageIdempotency(raced, user, 'message', null, content);
        return raced;
      }
      this.assertLiveSession(session);
      await this.assertRelayReady(session, tx);
      await tx.insert(agentMessages).values({
        messageId,
        sessionId: input.sessionId,
        ...actorColumns(user),
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

  async answerPrompt(actor: PortalActor, input: { sessionId: string; promptId: string; clientMessageId: string; answer: string; version?: number }): Promise<Record<string, unknown>> {
    const answer = normalizeMessage(input.answer);
    const clientMessageId = normalizeUuid(input.clientMessageId, 'client_message_id');
    const messageId = randomUUID();
    const now = nowIso();
    const inserted = await this.db.transaction(async (tx) => {
      await this.requirePortalEnabledLocked(tx);
      const user = await this.requireActorLocked(tx, actor, now);
      const session = await this.requireVisibleSessionLocked(tx, input.sessionId, now);
      const raced = await this.findMessageByClientId(input.sessionId, clientMessageId, tx, true);
      if (raced) {
        this.assertMessageIdempotency(raced, user, 'answer', input.promptId, answer);
        return raced;
      }
      this.assertLiveSession(session);
      await this.assertRelayReady(session, tx);
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
        ...actorColumns(user),
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

  /**
   * Asks the running agent to wind down, delivering the operator's note through
   * the normal instruction queue so the agent can finish cleanly. Requires an
   * open relay: an undeliverable note is worse than none, because the operator
   * would believe the channel is closing when nothing received the request.
   * `forceClose` is the escalation when the relay is shut or the agent is gone.
   */
  async requestClose(
    actor: PortalActor,
    input: { sessionId: string; clientMessageId: string; note?: string },
  ): Promise<Record<string, unknown>> {
    const note = normalizeCloseNote(input.note);
    const clientMessageId = normalizeUuid(input.clientMessageId, 'client_message_id');
    const messageId = randomUUID();
    const now = nowIso();
    const result = await this.db.transaction(async (tx) => {
      await this.requirePortalEnabledLocked(tx);
      const user = await this.requireActorLocked(tx, actor, now);
      const session = await this.requireVisibleSessionLocked(tx, input.sessionId, now);
      const raced = await this.findMessageByClientId(input.sessionId, clientMessageId, tx, true);
      if (raced) {
        this.assertMessageIdempotency(raced, user, 'close', null, note);
        return { row: raced, requestedAt: session.closeRequestedAt ?? raced.createdAt };
      }
      this.assertLiveSession(session);
      await this.assertRelayReady(session, tx);
      await tx.insert(agentMessages).values({
        messageId,
        sessionId: input.sessionId,
        ...actorColumns(user),
        kind: 'close',
        promptId: null,
        clientMessageId,
        contentEnc: this.encodeText(note),
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
      // First close wins, and the value is never cleared: `cxx portal wait`
      // re-asserts relay_action=poll every iteration, so a rule that cleared it
      // on the agent's return would erase the request within a second.
      const requestedAt = session.closeRequestedAt ?? now;
      await tx
        .update(agentSessions)
        .set({ closeRequestedAt: requestedAt, updatedAt: now })
        .where(eq(agentSessions.id, input.sessionId));
      await this.insertPortalCloseEvent(tx, input.sessionId, `portal:close:${messageId}`, {
        message_id: messageId,
        summary: note,
        author: user.displayName,
        delivery_status: 'queued',
      }, now);
      const rows = await tx.select().from(agentMessages).where(eq(agentMessages.messageId, messageId)).limit(1);
      if (!rows[0]) throw new ServiceUnavailableError('Close request insert was not readable', 'agent_message_write_failed');
      return { row: rows[0], requestedAt };
    });
    return {
      ...messageView(result.row),
      close_requested_at: result.requestedAt,
      close: { requested_at: result.requestedAt, state: closeState(result.row.status) },
    };
  }

  /**
   * Ends the session outright. Deliberately asserts neither liveness nor relay
   * readiness -- working against an agent that is offline or has closed its
   * relay is the entire point of the fallback.
   */
  async forceClose(
    actor: PortalActor,
    input: { sessionId: string; clientMessageId: string; note?: string },
  ): Promise<Record<string, unknown>> {
    const note = normalizeCloseNote(input.note);
    const clientMessageId = normalizeUuid(input.clientMessageId, 'client_message_id');
    const eventId = `portal:close-force:${clientMessageId}`;
    const now = nowIso();
    const expiresAt = isoOffsetSeconds(this.env.AGENT_PORTAL_RETENTION_HOURS * 3600);
    return await this.db.transaction(async (tx) => {
      await this.requirePortalEnabledLocked(tx);
      const user = await this.requireActorLocked(tx, actor, now);
      const session = await this.requireVisibleSessionLocked(tx, input.sessionId, now);
      const existing = await tx
        .select({ id: agentEvents.id })
        .from(agentEvents)
        .where(and(eq(agentEvents.sessionId, input.sessionId), eq(agentEvents.clientEventId, eventId)))
        .limit(1)
        .for('update');
      if (!existing[0]) {
        await this.insertPortalCloseEvent(tx, input.sessionId, eventId, {
          summary: note,
          author: user.displayName,
          delivery_status: 'forced',
        }, now);
      }
      // Must precede any liveness assertion: LIVE_SESSION_STATES excludes
      // completed/failed, so a second Force tap on an ended session would throw
      // instead of being the harmless no-op the UI expects.
      if (session.endedAt) {
        return {
          forced: false,
          already_ended: true,
          status: session.status,
          ended_at: session.endedAt,
          expires_at: session.expiresAt,
        };
      }
      await tx
        .update(agentSessions)
        .set({ closeRequestedAt: session.closeRequestedAt ?? now, updatedAt: now })
        .where(eq(agentSessions.id, input.sessionId));
      await this.applyTerminalState(tx, input.sessionId, 'completed', expiresAt, now);
      return {
        forced: true,
        already_ended: false,
        status: 'completed',
        ended_at: now,
        expires_at: expiresAt,
      };
    });
  }

  async claimMessage(sessionId: string, bridgeToken: string, claimId: string, hostId?: number): Promise<ClaimedMessage | null> {
    const leaseClaimId = normalizeUuid(claimId, 'claim_id');
    const authenticated = await this.authenticateBridge(sessionId, bridgeToken, hostId);
    for (;;) {
      const candidateRows = await this.db
        .select({
          id: agentMessages.id,
          portalUserId: agentMessages.portalUserId,
          adminUserId: agentMessages.adminUserId,
        })
        .from(agentMessages)
        .where(and(eq(agentMessages.sessionId, sessionId), inArray(agentMessages.status, ['queued', 'leased'])))
        .orderBy(asc(agentMessages.id))
        .limit(1);
      const candidate = candidateRows[0];
      const result = await this.db.transaction(async (tx): Promise<ClaimedMessage | null | 'retry'> => {
        await this.requirePortalEnabledLocked(tx);
        const authorLive = candidate ? await this.authorDeliverableLocked(tx, candidate) : false;
        const session = await this.requireBridgeSessionLocked(
          tx,
          sessionId,
          bridgeToken,
          authenticated.hostId,
        );
        await this.assertRelayReady(session, tx);
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
        if (!authorLive) {
          await tx
            .update(agentMessages)
            .set({ status: 'canceled', canceledAt: now, leaseOwner: null, leaseUntil: null, updatedAt: now })
            .where(eq(agentMessages.id, row.id));
          await this.releaseUndeliveredAnswerPrompt(row, session, now, tx);
          await this.announceUndelivered(row, now, tx);
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
            kind: normalizeClaimKind(row.kind),
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
          await this.announceUndelivered(row, now, tx);
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
          kind: normalizeClaimKind(row.kind),
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

  async purgeExpired(): Promise<{
    sessions: number;
    browser_sessions: number;
    abandoned_sessions: number;
    stale_turns: number;
  }> {
    const now = nowIso();
    const staleTurns = await this.clearStaleTurns(now);
    const abandonedSessions = await this.expireAbandonedSessions(now);
    const expired = await this.db
      .select({ id: agentSessions.id })
      .from(agentSessions)
      .where(and(lte(agentSessions.expiresAt, now), or(eq(agentSessions.status, 'completed'), eq(agentSessions.status, 'failed'))));
    const ids = expired.map((row) => row.id);
    if (ids.length > 0) {
      await this.db.transaction(async (tx) => {
        await releaseAgentMessagingBindingsLocked(tx, ids, now);
        await tx.delete(agentMessages).where(inArray(agentMessages.sessionId, ids));
        await tx.delete(agentPrompts).where(inArray(agentPrompts.sessionId, ids));
        await tx.delete(agentEvents).where(inArray(agentEvents.sessionId, ids));
        await tx.delete(agentSessions).where(inArray(agentSessions.id, ids));
      });
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
      stale_turns: staleTurns,
    };
  }

  async health(): Promise<Record<string, unknown>> {
    const [users, sessions, queued, dead] = await Promise.all([
      this.db.select({ value: count() }).from(agentPortalUsers).where(and(isNull(agentPortalUsers.deletedAt), eq(agentPortalUsers.enabled, 1))),
      this.db.select({ value: count() }).from(agentSessions).where(inArray(agentSessions.status, [...LIVE_SESSION_STATES])),
      this.db.select({ value: count() }).from(agentMessages).where(inArray(agentMessages.status, ['queued', 'leased'])),
      this.db.select({ value: count() }).from(agentMessages).where(eq(agentMessages.status, 'dead')),
    ]);
    return {
      enabled_users: Number(users[0]?.value ?? 0),
      active_sessions: Number(sessions[0]?.value ?? 0),
      queued_messages: Number(queued[0]?.value ?? 0),
      dead_messages: Number(dead[0]?.value ?? 0),
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
      return { row, payload: normalized.payload };
    });
    return eventView(result.row, result.payload);
  }

  /**
   * Clears `active_turn_id` on live sessions whose turn has outlived the
   * working ceiling. Presence already ignores a stale turn, but leaving the
   * column set makes every later read re-derive the same answer and leaves the
   * field lying in API output.
   */
  private async clearStaleTurns(now: string): Promise<number> {
    const cutoff = isoOffsetSeconds(-this.workingMaxSeconds());
    const candidates = await this.db
      .select({ id: agentSessions.id })
      .from(agentSessions)
      .where(and(isNull(agentSessions.endedAt), isNotNull(agentSessions.activeTurnId)))
      // Each candidate costs a lookup and possibly an update, so this is
      // bounded per tick at the same 100 as expireAbandonedSessions below.
      // Anything left over is picked up on the next sweep.
      .limit(100);
    let cleared = 0;
    for (const candidate of candidates) {
      const rows = await this.db
        .select({ createdAt: agentEvents.createdAt })
        .from(agentEvents)
        .where(and(eq(agentEvents.sessionId, candidate.id), eq(agentEvents.eventType, 'message_accepted')))
        .orderBy(desc(agentEvents.id))
        .limit(1);
      const startedAt = rows[0]?.createdAt ?? '';
      if (startedAt && startedAt > cutoff) continue;
      await this.db
        .update(agentSessions)
        .set({ activeTurnId: null, updatedAt: now })
        .where(and(eq(agentSessions.id, candidate.id), isNull(agentSessions.endedAt)));
      cleared += 1;
    }
    return cleared;
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
        return true;
      });
      if (changed) expired += 1;
    }
    return expired;
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

  /**
   * Narrows whichever identity table the actor came from to the one field a
   * non-queue write needs. The portal branch keeps the full check -- a revoked
   * browser session must not be able to end an agent -- while an admin arrives
   * already authenticated by `requireAdmin` and capability-gated at the route.
   */
  /**
   * May this queued message still be delivered?
   *
   * Delivery re-reads the author instead of trusting the queue row, so revoking
   * an account kills its undelivered instructions at the moment an agent
   * reaches for one -- not merely whenever a sweep next runs. That is the
   * property, and since 0027 it has two branches: a portal user must still be
   * enabled and undeleted, an admin must still be active.
   *
   * A row with neither column set cannot happen through this service, so it is
   * the shape a bug would produce -- and the safe reading of "no identifiable
   * author" is that nobody may act on it.
   */
  private async authorDeliverableLocked(
    db: AgentPortalDb,
    row: { portalUserId: number | null; adminUserId: number | null },
  ): Promise<boolean> {
    if (row.adminUserId != null) {
      const rows = await db
        .select({ active: adminUsers.active })
        .from(adminUsers)
        .where(eq(adminUsers.id, row.adminUserId))
        .limit(1)
        .for('update');
      return rows[0]?.active === 1;
    }
    if (row.portalUserId == null) return false;
    const rows = await db
      .select({ enabled: agentPortalUsers.enabled, deletedAt: agentPortalUsers.deletedAt })
      .from(agentPortalUsers)
      .where(eq(agentPortalUsers.id, row.portalUserId))
      .limit(1)
      .for('update');
    const user = rows[0];
    return Boolean(user && user.enabled === 1 && !user.deletedAt);
  }

  private async requireActorLocked(
    db: AgentPortalDb,
    actor: PortalActor,
    now: string,
  ): Promise<ResolvedActor> {
    if (actor.kind === 'admin') {
      // Re-read under the write's lock rather than trusting the request's
      // `requireAdmin`, which resolved the session before this transaction
      // opened. An account deactivated in between must not get one last
      // instruction through.
      const rows = await db
        .select({ id: adminUsers.id, name: adminUsers.name, username: adminUsers.username, active: adminUsers.active })
        .from(adminUsers)
        .where(eq(adminUsers.id, actor.user.id))
        .limit(1)
        .for('update');
      const admin = rows[0];
      if (!admin) throw new NotFoundError('Admin user not found', 'admin_user_not_found');
      if (admin.active !== 1) throw new ForbiddenError('Admin account is disabled', 'admin_disabled');
      return { kind: 'admin', id: admin.id, displayName: admin.name || admin.username };
    }
    const user = await this.requireIdentityLocked(db, actor.identity, now);
    return { kind: 'portal', id: user.id, displayName: user.displayName };
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

  /**
   * Whether the session is inside a turn it accepted and has not reported back
   * from. Read from the acceptance event because `agent_sessions` records which
   * turn is active but not when it began, and an unbounded `active_turn_id`
   * would hold the channel writable long after a dead turn stopped polling.
   */
  private async isWorking(session: AgentSession, db: AgentPortalDb = this.db): Promise<boolean> {
    if (!session.activeTurnId || session.endedAt) return false;
    const rows = await db
      .select({ createdAt: agentEvents.createdAt })
      .from(agentEvents)
      .where(and(eq(agentEvents.sessionId, session.id), eq(agentEvents.eventType, 'message_accepted')))
      .orderBy(desc(agentEvents.id))
      .limit(1);
    const startedAt = parseIso(rows[0]?.createdAt ?? '')?.getTime() ?? 0;
    return startedAt >= Date.now() - this.workingMaxSeconds() * 1000;
  }

  private async assertRelayReady(session: AgentSession, db: AgentPortalDb = this.db): Promise<void> {
    const heartbeat = parseIso(session.heartbeatAt)?.getTime() ?? 0;
    const relayHeartbeat = parseIso(session.relayHeartbeatAt ?? '')?.getTime() ?? 0;
    const heartbeatFresh = heartbeat >= Date.now() - this.env.AGENT_PORTAL_HEARTBEAT_FRESH_SECONDS * 1000;
    const relayFresh =
      session.relayEnabled === 1 &&
      relayHeartbeat >= Date.now() - this.env.AGENT_PORTAL_RELAY_FRESH_SECONDS * 1000;
    if (heartbeatFresh && relayFresh) return;
    // An agent mid-turn stops polling while it executes, so a strict relay check
    // would refuse an instruction the agent is about to come back and claim.
    // Holding it is safe in both directions: the `#afk` loop always returns to
    // `wait`, and if it never does the message is reported undelivered rather
    // than discarded.
    if (heartbeatFresh && (await this.isWorking(session, db))) return;
    throw new ConflictError(
      heartbeatFresh
        ? 'Agent is visible but is not currently accepting portal instructions'
        : 'Agent has stopped reporting and cannot be reached. End the session to close this channel.',
      'agent_relay_unavailable',
    );
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
    await releaseAgentMessagingBindingsLocked(db, [sessionId], now);
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

  /**
   * A retried `client_message_id` must be the same message or a conflict. The
   * author is part of that identity, and since 0027 two identity tables can
   * author -- so the comparison is against the actor's columns rather than a
   * bare number, or admin #3 would silently satisfy portal user #3's retry.
   */
  private assertMessageIdempotency(
    row: AgentMessage,
    actor: ResolvedActor,
    kind: 'message' | 'answer' | 'close',
    promptId: string | null,
    content: string,
  ): void {
    const expected = actorColumns(actor);
    if (
      row.portalUserId !== expected.portalUserId ||
      row.adminUserId !== expected.adminUserId ||
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

  /**
   * `close_requested` is its own event type rather than a `user_message`.
   * A user_message bubble asserts "this text was queued for delivery"; that is
   * true of a cooperative close but false of a force close, which records the
   * note without delivering anything. The note travels in `summary` and the mode
   * in `delivery_status`, both already whitelisted by normalizeEvent.
   */
  private async insertPortalCloseEvent(
    db: AgentPortalDb,
    sessionId: string,
    clientEventId: string,
    payload: Record<string, unknown>,
    now: string,
  ): Promise<void> {
    const normalized = normalizeEvent('close_requested', payload);
    await db.insert(agentEvents).values({
      sessionId,
      clientEventId,
      eventType: 'close_requested',
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
      .update(agentPortalBrowserSessions)
      .set({ revokedAt: now })
      .where(and(eq(agentPortalBrowserSessions.userId, userId), isNull(agentPortalBrowserSessions.revokedAt)));
    return { canceled: Number(pending[0]?.value ?? 0), revoked_sessions: Number(sessions[0]?.value ?? 0) };
  }

  /**
   * Cancels everything still in flight for a session.
   *
   * `keepLeasedClose` exempts a close note the agent has already claimed. The
   * agent's own `cxx portal leave` runs through here, and without the exemption
   * that call would cancel the very instruction it is obeying -- the follow-up
   * `cxx portal accept` would then fail with agent_message_lease_lost.
   *
   * A *queued* close note is deliberately not exempt. It can never be delivered
   * once the relay is down (claimMessage asserts relay readiness) and nothing
   * ages it out, so it would sit at the head of the strict-FIFO queue and fire
   * hours later on the next unrelated `#afk`. close_requested_at and the force
   * close carry the operator's intent forward instead.
   *
   * Only a terminal session or an administrative shutdown may cancel a claimed
   * close note; the agent cannot cancel a close it is already acting on.
   */
  private async cancelSessionPending(
    sessionId: string,
    now: string,
    db: AgentPortalDb = this.db,
    options: { keepLeasedClose?: boolean } = {},
  ): Promise<void> {
    const cancelable = and(
      eq(agentMessages.sessionId, sessionId),
      inArray(agentMessages.status, ['queued', 'leased']),
      ...(options.keepLeasedClose
        ? [not(and(eq(agentMessages.kind, 'close'), eq(agentMessages.status, 'leased'))!)]
        : []),
    );
    const pendingAnswers = await db
      .select({ messageId: agentMessages.messageId })
      .from(agentMessages)
      .where(and(
        eq(agentMessages.sessionId, sessionId),
        eq(agentMessages.kind, 'answer'),
        inArray(agentMessages.status, ['queued', 'leased']),
      ));
    // Read before the bulk cancel: afterwards these rows no longer match, and
    // each one owes the operator an explanation that it was thrown away.
    const doomed = await db
      .select()
      .from(agentMessages)
      .where(and(cancelable, inArray(agentMessages.kind, ['message', 'close'])));
    await db
      .update(agentMessages)
      .set({ status: 'canceled', canceledAt: now, leaseOwner: null, leaseUntil: null, updatedAt: now })
      .where(cancelable);
    for (const row of doomed) await this.announceUndelivered(row, now, db);
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

  /**
   * A close note that exhausts delivery leaves the operator believing the
   * channel is winding down when nothing received the request. Raise an
   * attention notice: listAgents derives the badge from event cursors, so this
   * lights the session up in the portal with no new state and no client work.
   */
  /**
   * Tells the operator that a queued message died undelivered.
   *
   * `close` and `answer` have always announced themselves; a plain `message`
   * announced nothing, so an instruction that no agent ever claimed was
   * discarded in silence with the timeline still rendering "Queued" against it
   * forever. `answer` stays with releaseUndeliveredAnswerPrompt, which reopens
   * the prompt rather than writing an event.
   */
  private async announceUndelivered(
    message: AgentMessage,
    now: string,
    db: AgentPortalDb,
  ): Promise<void> {
    if (message.kind === 'close') {
      const payload = normalizeEvent('attention', {
        summary: 'The close request could not be delivered to this agent. Use Force end to close the channel.',
      }).payload;
      await db.insert(agentEvents).values({
        sessionId: message.sessionId,
        clientEventId: `server:close-dead:${message.messageId}`,
        eventType: 'attention',
        source: 'portal',
        payloadEnc: this.encodeJson(payload),
        createdAt: now,
      });
      return;
    }
    if (message.kind !== 'message') return;
    const payload = normalizeEvent('message_canceled', {
      message_id: message.messageId,
      summary: 'The agent never picked this up. It was not delivered.',
      delivery_status: 'canceled',
    }).payload;
    await db.insert(agentEvents).values({
      sessionId: message.sessionId,
      clientEventId: `server:message-dead:${message.messageId}`,
      eventType: 'message_canceled',
      source: 'portal',
      payloadEnc: this.encodeJson(payload),
      createdAt: now,
    });
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

function normalizeMessage(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) throw new ValidationError('message text is required', { param: 'content' });
  const text = value.trim();
  if (Buffer.byteLength(text, 'utf8') > AGENT_PORTAL_MESSAGE_MAX_BYTES) {
    throw new ValidationError(`message exceeds ${AGENT_PORTAL_MESSAGE_MAX_BYTES} bytes`, { param: 'content' });
  }
  return text;
}

function normalizeCloseNote(value: unknown): string {
  if (value === undefined || value === null || !String(value).trim()) {
    return AGENT_PORTAL_DEFAULT_CLOSE_NOTE;
  }
  return normalizeRequiredText(value, 'note', AGENT_PORTAL_CLOSE_NOTE_MAX_BYTES);
}

/**
 * The close note's message row carries the whole lifecycle, so the portal needs
 * no extra column to tell a pending close from an honoured one.
 */
function closeState(status: string): AgentCloseState {
  if (status === 'accepted') return 'acknowledged';
  if (status === 'canceled' || status === 'dead') return 'undeliverable';
  return 'pending';
}

/** Keeps the two claim paths from drifting when a new message kind is added. */
function normalizeClaimKind(value: string): 'message' | 'answer' | 'close' {
  if (value === 'answer') return 'answer';
  if (value === 'close') return 'close';
  return 'message';
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

function backoffSeconds(attempts: number): number {
  return Math.min(300, Math.max(2, 2 ** Math.min(8, Math.max(1, attempts))));
}
