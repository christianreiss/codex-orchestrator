import { describe, it, expect } from 'vitest';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { makeAuthAdminPlugin } from '../../../src/http/plugins/auth-admin.js';
import { UnauthorizedError } from '../../../src/http/errors.js';
import { AdminAuthService } from '../../../src/services/admin-auth.js';
import type { Database } from '../../../src/db/client.js';
import { adminSessions, adminUsers } from '../../../src/db/schema.js';
import type { Env } from '../../../src/env.js';
import { sha256 } from '../../../src/security/hash.js';
import { isoOffsetSeconds, nowIso } from '../../../src/util/timestamp.js';
import { createDbFake, type DbFake } from '../../helpers/db-fake.js';

/**
 * The plugin re-stamps `expires_at` on every request that carries an admin
 * cookie, so its clamp — not the login route's — decides how long a session
 * really lives. With the shipped ADMIN_SESSION_TTL_MINUTES default of 30 days,
 * a wider bound here silently undoes the 7-day cap the session was issued
 * under, which is why the roll-forward is pinned against AdminAuthService.
 */

const COOKIE = 'codex_admin_session';
const TOKEN = 'a'.repeat(64);
const TOKEN_HASH = sha256(TOKEN);
const SEVEN_DAYS_SECONDS = 7 * 24 * 60 * 60;

type Row = Record<string, unknown>;

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    ADMIN_SESSION_COOKIE: COOKIE,
    ADMIN_SESSION_TTL_MINUTES: 60 * 24 * 30,
    ...overrides,
  } as unknown as Env;
}

function sessionRow(overrides: Row = {}): Row {
  const created = nowIso();
  return {
    id: 1,
    userId: 7,
    tokenHash: TOKEN_HASH,
    ip: null,
    userAgent: null,
    createdAt: created,
    lastSeenAt: created,
    expiresAt: isoOffsetSeconds(3600),
    ...overrides,
  };
}

function userRow(overrides: Row = {}): Row {
  const created = nowIso();
  return {
    id: 7,
    name: 'Owner',
    username: 'owner',
    email: 'owner@example.test',
    passwordHash: '$argon2id$secret',
    accessLevel: 'owner',
    active: 1,
    lastLoginAt: null,
    createdAt: created,
    updatedAt: created,
    ...overrides,
  };
}

/**
 * createDbFake has no innerJoin and drops the `expires_at > now` bound, so the
 * joined session lookup is served here (the token still comes from the query's
 * own params). Everything else — notably the roll-forward UPDATE these tests
 * read back — stays on the fake.
 */
function makeDb(sessions: Row[], users: Row[]): { db: Database; fake: DbFake } {
  const fake = createDbFake();
  fake.tables.set(adminSessions, sessions);
  fake.tables.set(adminUsers, users);

  const select = () => ({
    from: () => ({
      innerJoin: () => ({
        where: (where: unknown) => {
          const params = whereParams(where);
          const now = Date.now();
          const joined = (fake.tables.get(adminSessions) ?? [])
            .filter((s) => params.includes(s.tokenHash) && Date.parse(String(s.expiresAt)) > now)
            .map((session) => ({
              session,
              user: (fake.tables.get(adminUsers) ?? []).find((u) => u.id === session.userId),
            }))
            .filter((row) => row.user);
          return { limit: (n: number) => Promise.resolve(joined.slice(0, n)) };
        },
      }),
    }),
  });

  return { db: { ...fake, select } as unknown as Database, fake };
}

/** Collects the bound values of a Drizzle where clause (Param nodes). */
function whereParams(where: unknown, out: unknown[] = [], seen = new WeakSet<object>()): unknown[] {
  if (!where || typeof where !== 'object' || seen.has(where)) return out;
  seen.add(where);
  if (where.constructor?.name === 'Param' && 'value' in where) {
    out.push((where as { value: unknown }).value);
    return out;
  }
  for (const value of Object.values(where as Record<string, unknown>)) whereParams(value, out, seen);
  return out;
}

async function buildApp(db: Database, env: Env): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(makeAuthAdminPlugin(db, env));
  await app.ready();
  return app;
}

function request(cookies: Record<string, string>): FastifyRequest {
  return { cookies } as unknown as FastifyRequest;
}

describe('auth-admin resolveAdmin', () => {
  it('resolves null without a cookie', async () => {
    const { db } = makeDb([sessionRow()], [userRow()]);
    const app = await buildApp(db, makeEnv());
    expect(await app.resolveAdmin(request({}))).toBeNull();
  });

  it('resolves null for an unknown cookie value', async () => {
    const { db, fake } = makeDb([sessionRow()], [userRow()]);
    const app = await buildApp(db, makeEnv());
    expect(await app.resolveAdmin(request({ [COOKIE]: 'b'.repeat(64) }))).toBeNull();
    expect(fake.updates).toHaveLength(0);
  });

  it('resolves null for an expired session row', async () => {
    const { db } = makeDb([sessionRow({ expiresAt: isoOffsetSeconds(-60) })], [userRow()]);
    const app = await buildApp(db, makeEnv());
    expect(await app.resolveAdmin(request({ [COOKIE]: TOKEN }))).toBeNull();
  });

  it('resolves null for a deactivated user', async () => {
    const { db } = makeDb([sessionRow()], [userRow({ active: 0 })]);
    const app = await buildApp(db, makeEnv());
    expect(await app.resolveAdmin(request({ [COOKIE]: TOKEN }))).toBeNull();
  });

  it('resolves the session and user for a live cookie', async () => {
    const { db } = makeDb([sessionRow()], [userRow()]);
    const app = await buildApp(db, makeEnv());
    const ctx = await app.resolveAdmin(request({ [COOKIE]: TOKEN }));
    expect(ctx?.user.username).toBe('owner');
    expect(ctx?.session.id).toBe(1);
  });
});

describe('auth-admin requireAdmin', () => {
  it('throws admin_required when no session resolves', async () => {
    const { db } = makeDb([sessionRow()], [userRow()]);
    const app = await buildApp(db, makeEnv());
    const req = request({});
    const requireAdmin = app.requireAdmin as unknown as (r: FastifyRequest) => Promise<void>;
    await expect(requireAdmin(req)).rejects.toThrow(UnauthorizedError);
    await expect(requireAdmin(req)).rejects.toMatchObject({ code: 'admin_required', status: 401 });
    expect(req.admin).toBeUndefined();
  });

  it('sets req.admin on success', async () => {
    const { db } = makeDb([sessionRow()], [userRow()]);
    const app = await buildApp(db, makeEnv());
    const req = request({ [COOKIE]: TOKEN });
    await (app.requireAdmin as unknown as (r: FastifyRequest) => Promise<void>)(req);
    expect(req.admin?.user.id).toBe(7);
    expect(req.admin?.session.id).toBe(1);
  });
});

describe('auth-admin rolled session expiry', () => {
  /** Seconds between `expires_at` as re-stamped by the plugin and `from`. */
  async function rollExpiry(env: Env): Promise<{ ttlFromEnd: number; ttlFromStart: number }> {
    const { db, fake } = makeDb([sessionRow()], [userRow()]);
    const app = await buildApp(db, env);
    const before = Date.now();
    await app.resolveAdmin(request({ [COOKIE]: TOKEN }));
    const after = Date.now();
    const rolled = Date.parse(String(fake.updates[0]?.set.expiresAt));
    return { ttlFromEnd: (rolled - after) / 1000, ttlFromStart: (rolled - before) / 1000 };
  }

  it('caps the roll-forward at the issuer TTL with the 30-day default', async () => {
    const env = makeEnv({ ADMIN_SESSION_TTL_MINUTES: 43200 });
    const issued = new AdminAuthService({} as Database, env).sessionTtlSeconds();
    expect(issued).toBe(SEVEN_DAYS_SECONDS);

    const { ttlFromEnd, ttlFromStart } = await rollExpiry(env);
    expect(ttlFromEnd).toBeLessThanOrEqual(SEVEN_DAYS_SECONDS);
    expect(ttlFromEnd).toBeLessThanOrEqual(issued);
    expect(ttlFromStart).toBeGreaterThan(issued - 2);
  });

  it('pins the 300s floor for a zero or negative TTL', async () => {
    for (const minutes of [0, -1]) {
      const env = makeEnv({ ADMIN_SESSION_TTL_MINUTES: minutes });
      expect(new AdminAuthService({} as Database, env).sessionTtlSeconds()).toBe(300);
      const { ttlFromEnd, ttlFromStart } = await rollExpiry(env);
      expect(ttlFromEnd).toBeLessThanOrEqual(300);
      expect(ttlFromStart).toBeGreaterThan(298);
    }
  });
});
