/**
 * Reads and writes the fleet's authorization mode, and keeps the record of
 * what `strict` would have refused while the fleet is in `compatible`.
 *
 * The mode lives in the `versions` key/value table alongside the other module
 * switches rather than in its own table, because it is one string and adding a
 * table for it would mean a schema change on every installation to store a
 * value that has two legal values.
 *
 * The dry-run record is the part that makes switching a decision rather than a
 * gamble. An operator asking "what breaks if I turn this on" gets an answer
 * from their own traffic — the roles, capabilities and routes actually in use
 * that the matrix would refuse — instead of a warning telling them to go read
 * their roster.
 */

import { and, desc, eq, gte } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { adminEvents, versions } from '../db/schema.js';
import { nowIso } from '../util/timestamp.js';
import {
  AUTHORIZATION_MODE_FLAG,
  DEFAULT_AUTHORIZATION_MODE,
  parseAuthorizationMode,
  type AuthorizationMode,
} from '../security/authorization-mode.js';
import type { Capability } from '../security/capabilities.js';

/** `admin_events.type` for a request `strict` would have refused. */
export const WOULD_DENY_EVENT = 'authorization.would_deny';
/** `admin_events.type` for a mode change. */
export const MODE_CHANGED_EVENT = 'authorization.mode_changed';

/**
 * How long the same (role, capability, route) triple is treated as already
 * recorded.
 *
 * Without this, a console polling a refused endpoint writes an audit row per
 * poll, and `compatible` mode becomes a write amplifier on a busy fleet. The
 * operator needs the *set* of things that would break, not a row per
 * occurrence, so one row per distinct triple per hour carries the same
 * information at a bounded cost.
 */
const DEDUP_WINDOW_MS = 60 * 60 * 1000;

/**
 * How long a resolved mode is trusted before it is re-read.
 *
 * The mode is consulted on every governed request, so it cannot be a query per
 * call. Writes through {@link AuthorizationModeService.setMode} invalidate
 * immediately, which covers the single-instance case exactly; the TTL is the
 * backstop that makes a multi-instance deployment converge without a restart.
 * Documented in `docs/ADMIN.md` so an operator who flips the switch and sees a
 * peer instance lag knows it is a bound and not a bug.
 */
const MODE_CACHE_TTL_MS = 30 * 1000;

export interface WouldDenyRecord {
  role: string;
  capability: string;
  route: string;
  first_seen: string;
  last_seen: string;
}

export interface AuthorizationModeState {
  mode: AuthorizationMode;
  updated_at: string | null;
  /** What `strict` would have refused, newest first. Empty under `strict`. */
  would_deny: WouldDenyRecord[];
}

export class AuthorizationModeService {
  private cached: { mode: AuthorizationMode; readAt: number } | null = null;
  /** `role|capability|route` → last time it was written. */
  private readonly recentlyRecorded = new Map<string, number>();

  constructor(
    private readonly db: Database,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /**
   * The stored mode, cached.
   *
   * A failed read falls back to the last mode successfully read, and only to
   * `strict` if there has never been one — and the failure is deliberately not
   * cached. Pinning a `compatible` fleet into `strict` for the cache window
   * because one query blipped would lock its operators out for exactly the
   * reason this mode exists to prevent. In practice a database that cannot
   * answer this cannot resolve the session either, so the request was already
   * going to be refused as unauthenticated.
   */
  async getMode(): Promise<AuthorizationMode> {
    const cached = this.cached;
    if (cached && this.now() - cached.readAt < MODE_CACHE_TTL_MS) return cached.mode;
    try {
      const mode = await this.readMode();
      this.cached = { mode, readAt: this.now() };
      return mode;
    } catch {
      return cached?.mode ?? DEFAULT_AUTHORIZATION_MODE;
    }
  }

  private async readMode(): Promise<AuthorizationMode> {
    const rows = await this.db
      .select()
      .from(versions)
      .where(eq(versions.name, AUTHORIZATION_MODE_FLAG))
      .limit(1);
    // db-fake ignores WHERE, so re-check the name rather than trusting row 0.
    const row = rows.find((candidate) => candidate.name === AUTHORIZATION_MODE_FLAG);
    return parseAuthorizationMode(row?.version);
  }

  /** Drops the cache, so the next read hits the table. */
  invalidate(): void {
    this.cached = null;
  }

  async state(): Promise<AuthorizationModeState> {
    const rows = await this.db
      .select()
      .from(versions)
      .where(eq(versions.name, AUTHORIZATION_MODE_FLAG))
      .limit(1);
    const row = rows.find((candidate) => candidate.name === AUTHORIZATION_MODE_FLAG);
    return {
      mode: parseAuthorizationMode(row?.version),
      updated_at: row?.updatedAt ?? null,
      would_deny: await this.wouldDeny(),
    };
  }

  async setMode(mode: AuthorizationMode, actor: { id: number; username: string }): Promise<void> {
    const now = nowIso();
    const existing = await this.db
      .select()
      .from(versions)
      .where(eq(versions.name, AUTHORIZATION_MODE_FLAG))
      .limit(1);
    const row = existing.find((candidate) => candidate.name === AUTHORIZATION_MODE_FLAG);

    if (row) {
      await this.db
        .update(versions)
        .set({ version: mode, updatedAt: now })
        .where(eq(versions.name, AUTHORIZATION_MODE_FLAG));
    } else {
      await this.db
        .insert(versions)
        .values({ name: AUTHORIZATION_MODE_FLAG, version: mode, updatedAt: now });
    }

    this.cached = { mode, readAt: this.now() };
    // A posture change is exactly the kind of thing an audit log exists for,
    // and it names the account rather than only the new value: "who relaxed
    // this" is the question asked afterwards.
    await this.db.insert(adminEvents).values({
      type: MODE_CHANGED_EVENT,
      hostId: null,
      payload: { mode, actor_id: actor.id, actor: actor.username },
      createdAt: now,
    });
  }

  /**
   * Note that `strict` would have refused this request. Deduplicated per
   * {@link DEDUP_WINDOW_MS}; never throws, because a failure to record must not
   * turn into a failure to serve a request the fleet has decided to allow.
   */
  async recordWouldDeny(input: {
    role: string;
    capability: Capability;
    route: string;
  }): Promise<void> {
    const key = `${input.role}|${input.capability}|${input.route}`;
    const now = this.now();
    const last = this.recentlyRecorded.get(key);
    if (last !== undefined && now - last < DEDUP_WINDOW_MS) return;
    this.recentlyRecorded.set(key, now);
    this.pruneDedupCache(now);

    try {
      await this.db.insert(adminEvents).values({
        type: WOULD_DENY_EVENT,
        hostId: null,
        payload: { role: input.role, capability: input.capability, route: input.route },
        createdAt: nowIso(),
      });
    } catch {
      // Best effort. Losing a dry-run sample is not worth a 500 on a request
      // that compatible mode has already decided to allow.
      this.recentlyRecorded.delete(key);
    }
  }

  private pruneDedupCache(now: number): void {
    if (this.recentlyRecorded.size < 512) return;
    for (const [key, at] of this.recentlyRecorded) {
      if (now - at >= DEDUP_WINDOW_MS) this.recentlyRecorded.delete(key);
    }
  }

  /**
   * The distinct (role, capability, route) triples `strict` would have refused
   * in the last 30 days, newest first.
   */
  async wouldDeny(): Promise<WouldDenyRecord[]> {
    const since = new Date(this.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const rows = await this.db
      .select()
      .from(adminEvents)
      .where(and(eq(adminEvents.type, WOULD_DENY_EVENT), gte(adminEvents.createdAt, since)))
      .orderBy(desc(adminEvents.id))
      .limit(1000);

    const collapsed = new Map<string, WouldDenyRecord>();
    for (const row of rows) {
      // db-fake ignores WHERE; re-check rather than trusting the driver.
      if (row.type !== WOULD_DENY_EVENT) continue;
      const payload = (row.payload ?? {}) as Record<string, unknown>;
      const role = typeof payload.role === 'string' ? payload.role : null;
      const capability = typeof payload.capability === 'string' ? payload.capability : null;
      const route = typeof payload.route === 'string' ? payload.route : null;
      if (!role || !capability || !route) continue;

      const key = `${role}|${capability}|${route}`;
      const seen = collapsed.get(key);
      if (seen) {
        if (row.createdAt < seen.first_seen) seen.first_seen = row.createdAt;
        if (row.createdAt > seen.last_seen) seen.last_seen = row.createdAt;
        continue;
      }
      collapsed.set(key, {
        role,
        capability,
        route,
        first_seen: row.createdAt,
        last_seen: row.createdAt,
      });
    }
    return [...collapsed.values()];
  }
}

export function createAuthorizationModeService(db: Database): AuthorizationModeService {
  return new AuthorizationModeService(db);
}
