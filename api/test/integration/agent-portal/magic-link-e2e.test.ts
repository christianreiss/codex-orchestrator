import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { adminSessions, adminUsers } from '../../../src/db/schema.js';
import { splitSqlStatements } from '../../../src/db/migration-sql.js';
import type { Env } from '../../../src/env.js';
import { registerAgentPortalAdminHostRoutes } from '../../../src/routes/agent-portal/admin-host.js';
import { registerAgentPortalPublicRoutes } from '../../../src/routes/agent-portal/public.js';
import { AGENT_PORTAL_ENABLED_KEY } from '../../../src/services/agent-portal.js';
import { sha256 } from '../../../src/security/hash.js';
import { buildAppWithDb } from '../../helpers/build-app.js';
import { getTestDb, type TestDb } from '../../helpers/test-db.js';
import { testKeyring } from '../../helpers/test-keyring.js';

/**
 * The permanent link is now the entire way in: no message is pushed anywhere, so
 * if the link does not survive storage and exchange over real HTTP, the portal is
 * simply unreachable. `durability.test.ts` proves the service-level round trip;
 * this file proves the deployed shape of it — the actual routes, the actual role
 * gates, the actual cookie, the actual CSRF checks — against real MySQL.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = [
  join(HERE, '../../../src/db/migrations/0008_add_agent_portal.sql'),
  join(HERE, '../../../src/db/migrations/0009_drop_agent_portal_matrix.sql'),
];
const PREFIX = 'ztest-portal-e2e';
const ORIGIN = 'https://portal.example';
const handle = await getTestDb();

describe.skipIf(!handle)('agent portal magic link end to end', { timeout: 120_000 }, () => {
  let db: TestDb;
  let app: FastifyInstance;
  let ownerCookie: string;
  let viewerCookie: string;

  const exec = async (query: string) => await db.execute(sql.raw(query));

  /** Seeds an admin row plus a resolvable session, and returns its raw cookie. */
  const seedAdmin = async (accessLevel: string): Promise<string> => {
    const raw = randomBytes(32).toString('base64url');
    const now = new Date().toISOString();
    const later = new Date(Date.now() + 3_600_000).toISOString();
    const tag = `${PREFIX}-${accessLevel}-${randomUUID().slice(0, 8)}`;
    await db.insert(adminUsers).values({
      name: tag,
      username: tag,
      email: `${tag}@example.test`,
      passwordHash: 'x'.repeat(60),
      accessLevel,
      active: 1,
      createdAt: now,
      updatedAt: now,
    });
    const users = await db.select().from(adminUsers).where(eq(adminUsers.username, tag)).limit(1);
    await db.insert(adminSessions).values({
      userId: users[0]!.id,
      tokenHash: sha256(raw),
      createdAt: now,
      lastSeenAt: now,
      expiresAt: later,
    });
    return `codex_admin_session=${raw}`;
  };

  beforeAll(async () => {
    db = handle!.db;
    for (const migration of MIGRATIONS) {
      for (const statement of splitSqlStatements(readFileSync(migration, 'utf8'))) {
        await exec(statement);
      }
    }
    await exec(`DELETE FROM admin_sessions WHERE user_id IN (
      SELECT id FROM admin_users WHERE username LIKE '${PREFIX}%'
    )`);
    await exec(`DELETE FROM admin_users WHERE username LIKE '${PREFIX}%'`);

    const env = {
      PUBLIC_BASE_URL: ORIGIN,
      ADMIN_SESSION_COOKIE: 'codex_admin_session',
      AGENT_PORTAL_COOKIE: 'agent_portal_session',
      AGENT_PORTAL_SESSION_TTL_HOURS: 24,
      AGENT_PORTAL_RETENTION_HOURS: 24,
      AGENT_PORTAL_BRIDGE_TTL_SECONDS: 900,
    } as Partial<Env>;
    app = await buildAppWithDb(db, { env });
    const ctx = { db, env: app.env, keyring: testKeyring() };
    await registerAgentPortalAdminHostRoutes(app, ctx as never);
    await registerAgentPortalPublicRoutes(app, ctx as never);
    await app.ready();

    ownerCookie = await seedAdmin('owner');
    viewerCookie = await seedAdmin('viewer');
  });

  beforeEach(async () => {
    await exec(`DELETE FROM agent_portal_browser_sessions WHERE user_id IN (
      SELECT id FROM agent_portal_users WHERE display_name LIKE '${PREFIX}%'
    )`);
    await exec(`DELETE FROM agent_portal_users WHERE display_name LIKE '${PREFIX}%'`);
    await exec(
      `INSERT INTO versions (name, version, updated_at)
       VALUES ('${AGENT_PORTAL_ENABLED_KEY}', '1', '${new Date().toISOString()}')
       ON DUPLICATE KEY UPDATE version = '1', updated_at = VALUES(updated_at)`,
    );
  });

  afterAll(async () => {
    await exec(`DELETE FROM agent_portal_browser_sessions WHERE user_id IN (
      SELECT id FROM agent_portal_users WHERE display_name LIKE '${PREFIX}%'
    )`);
    await exec(`DELETE FROM agent_portal_users WHERE display_name LIKE '${PREFIX}%'`);
    await exec(`DELETE FROM admin_sessions WHERE user_id IN (
      SELECT id FROM admin_users WHERE username LIKE '${PREFIX}%'
    )`);
    await exec(`DELETE FROM admin_users WHERE username LIKE '${PREFIX}%'`);
    await app?.close();
    await handle?.pool.end();
  });

  /**
   * The portal now admits a console session as well as a magic link, which is
   * the whole point of the integration -- an operator already signed in should
   * not exchange a second credential to reach the same fleet. The risk it
   * introduces is that /go carries no capability inventory entry, so an admin
   * arriving here would bypass the gates the console enforces unless the
   * fallback asserts them itself. These tests are that assertion: a `viewer`
   * refused at /admin must be refused here for the same actions.
   */
  describe('a console session as an alternative to the magic link', () => {
    const go = (method: 'GET' | 'POST', url: string, cookie: string, payload?: Record<string, unknown>) =>
      app.inject({
        method,
        url,
        headers: { cookie, origin: ORIGIN, 'sec-fetch-site': 'same-origin' },
        payload,
      });

    it('lets an owner in with no portal cookie at all', async () => {
      const me = await go('GET', '/go/api/me', ownerCookie);
      expect(me.statusCode).toBe(200);
      expect(JSON.parse(me.payload).user).toMatchObject({ kind: 'admin' });

      const agents = await go('GET', '/go/api/agents', ownerCookie);
      expect(agents.statusCode).toBe(200);
    });

    it('still refuses a request carrying neither identity', async () => {
      const anonymous = await app.inject({
        method: 'GET',
        url: '/go/api/agents',
        headers: { origin: ORIGIN, 'sec-fetch-site': 'same-origin' },
      });
      expect(anonymous.statusCode).toBe(401);
    });

    it('admits a viewer to the agent listing, which is metadata every role reads', async () => {
      const agents = await go('GET', '/go/api/agents', viewerCookie);
      expect(agents.statusCode).toBe(200);
    });

    it('refuses a viewer the timeline, which carries message bodies', async () => {
      const events = await go('GET', `/go/api/agents/${randomUUID()}/events`, viewerCookie);
      expect(events.statusCode).toBe(403);
    });

    it('refuses a viewer every write, so /go is not a way around /admin', async () => {
      const id = randomUUID();
      const writes = await Promise.all([
        go('POST', `/go/api/agents/${id}/messages`, viewerCookie, {
          client_message_id: randomUUID(),
          content: 'let me in',
        }),
        go('POST', `/go/api/agents/${id}/close`, viewerCookie, { client_message_id: randomUUID() }),
        go('POST', `/go/api/agents/${id}/close/force`, viewerCookie, { client_message_id: randomUUID() }),
        go('POST', `/go/api/agents/${id}/prompts/${randomUUID()}/answer`, viewerCookie, {
          client_message_id: randomUUID(),
          answer: 'no',
        }),
      ]);
      // 403 on the capability, never 404 on the session id -- being refused for
      // the right reason is what distinguishes a gate from an accident.
      expect(writes.map((response) => response.statusCode)).toEqual([403, 403, 403, 403]);
    });
  });

  const createPortalUser = async (label: string) => {
    const response = await app.inject({
      method: 'POST',
      url: '/admin/agent-portal/users',
      headers: { cookie: ownerCookie },
      payload: { display_name: `${PREFIX}-${label}` },
    });
    expect(response.statusCode).toBe(200);
    return JSON.parse(response.payload) as {
      user: { id: number; public_id: string; display_name: string };
      magic_url: string;
    };
  };

  it('walks create → read the link back → exchange → authenticated portal', async () => {
    const created = await createPortalUser('walk');

    // A later reveal must reproduce the same bookmarkable URL byte for byte.
    const revealed = await app.inject({
      method: 'GET',
      url: `/admin/agent-portal/users/${created.user.id}/link`,
      headers: { cookie: ownerCookie },
    });
    expect(revealed.statusCode).toBe(200);
    const link = (JSON.parse(revealed.payload) as { magic_url: string }).magic_url;
    expect(link).toBe(created.magic_url);

    const url = new URL(link);
    expect(url.origin).toBe(ORIGIN);
    expect(url.pathname).toBe(`/go/u/${created.user.public_id}`);
    expect(url.search).toBe('');
    expect(url.hash.startsWith('#t=')).toBe(true);

    // The shell the bookmark actually opens.
    const shell = await app.inject({
      method: 'GET',
      url: url.pathname,
      headers: { 'sec-fetch-site': 'none' },
    });
    expect([200, 503]).toContain(shell.statusCode);

    const exchange = await app.inject({
      method: 'POST',
      url: '/go/api/auth/exchange',
      headers: { origin: ORIGIN, 'sec-fetch-site': 'same-origin' },
      payload: {
        public_id: created.user.public_id,
        token: decodeURIComponent(url.hash.slice(3)),
      },
    });
    expect(exchange.statusCode).toBe(200);
    const portalCookie = exchange.cookies.find((c) => c.name === 'agent_portal_session');
    expect(portalCookie).toMatchObject({ httpOnly: true, secure: true, sameSite: 'Strict', path: '/go' });

    const session = `agent_portal_session=${portalCookie!.value}`;
    const me = await app.inject({
      method: 'GET',
      url: '/go/api/me',
      headers: { cookie: session, 'sec-fetch-site': 'same-origin' },
    });
    expect(me.statusCode).toBe(200);
    expect(JSON.parse(me.payload).user).toMatchObject({
      id: created.user.id,
      display_name: created.user.display_name,
    });

    const agents = await app.inject({
      method: 'GET',
      url: '/go/api/agents',
      headers: { cookie: session, 'sec-fetch-site': 'same-origin' },
    });
    expect(agents.statusCode).toBe(200);
    expect(Array.isArray(JSON.parse(agents.payload).agents)).toBe(true);
  });

  it('re-exchanges the same bookmark on a second device', async () => {
    const created = await createPortalUser('second-device');
    const token = decodeURIComponent(new URL(created.magic_url).hash.slice(3));
    const exchangeOnce = async () =>
      await app.inject({
        method: 'POST',
        url: '/go/api/auth/exchange',
        headers: { origin: ORIGIN, 'sec-fetch-site': 'same-origin' },
        payload: { public_id: created.user.public_id, token },
      });

    const phone = await exchangeOnce();
    const laptop = await exchangeOnce();

    // Permanent means reusable: the bookmark is not a one-shot login.
    expect(phone.statusCode).toBe(200);
    expect(laptop.statusCode).toBe(200);
    expect(phone.cookies.find((c) => c.name === 'agent_portal_session')?.value).not.toBe(
      laptop.cookies.find((c) => c.name === 'agent_portal_session')?.value,
    );
  });

  it('rejects a rotated bookmark and accepts the replacement', async () => {
    const created = await createPortalUser('rotate');
    const staleToken = decodeURIComponent(new URL(created.magic_url).hash.slice(3));

    const rotated = await app.inject({
      method: 'POST',
      url: `/admin/agent-portal/users/${created.user.id}/rotate`,
      headers: { cookie: ownerCookie },
    });
    expect(rotated.statusCode).toBe(200);
    const fresh = JSON.parse(rotated.payload) as { magic_url: string };
    expect(fresh.magic_url).not.toBe(created.magic_url);

    const stale = await app.inject({
      method: 'POST',
      url: '/go/api/auth/exchange',
      headers: { origin: ORIGIN, 'sec-fetch-site': 'same-origin' },
      payload: { public_id: created.user.public_id, token: staleToken },
    });
    expect(stale.statusCode).toBe(401);

    const replacement = await app.inject({
      method: 'POST',
      url: '/go/api/auth/exchange',
      headers: { origin: ORIGIN, 'sec-fetch-site': 'same-origin' },
      payload: {
        public_id: created.user.public_id,
        token: decodeURIComponent(new URL(fresh.magic_url).hash.slice(3)),
      },
    });
    expect(replacement.statusCode).toBe(200);
  });

  it('keeps the link off the listing and away from non-owner roles', async () => {
    const created = await createPortalUser('gating');

    // Readable by any admin session, so it must not carry bearer material.
    const listing = await app.inject({
      method: 'GET',
      url: '/admin/agent-portal/users',
      headers: { cookie: viewerCookie },
    });
    expect(listing.statusCode).toBe(200);
    expect(listing.payload).not.toContain('magic_url');
    expect(listing.payload).not.toContain(created.magic_url);
    expect(listing.payload).not.toContain('matrix');

    const viewerReveal = await app.inject({
      method: 'GET',
      url: `/admin/agent-portal/users/${created.user.id}/link`,
      headers: { cookie: viewerCookie },
    });
    expect(viewerReveal.statusCode).toBe(403);
    expect(JSON.parse(viewerReveal.payload).code).toBe('admin_role_required');

    const anonymous = await app.inject({
      method: 'GET',
      url: `/admin/agent-portal/users/${created.user.id}/link`,
    });
    expect(anonymous.statusCode).toBe(401);
  });

  it('leaves no Matrix outbox in the schema for a link to be queued into', async () => {
    const rows = (await exec(
      `SELECT COUNT(*) AS n FROM information_schema.tables
       WHERE table_schema = DATABASE() AND table_name = 'agent_matrix_outbox'`,
    )) as unknown as Array<Array<{ n: number }>>;
    expect(Number(rows[0]![0]!.n)).toBe(0);

    const columns = (await exec(
      `SELECT COUNT(*) AS n FROM information_schema.columns
       WHERE table_schema = DATABASE() AND table_name = 'agent_portal_users'
         AND column_name = 'matrix_room'`,
    )) as unknown as Array<Array<{ n: number }>>;
    expect(Number(columns[0]![0]!.n)).toBe(0);

    // Creating a user is what used to enqueue an onboarding link delivery.
    const created = await createPortalUser('no-outbox');
    const state = await app.inject({
      method: 'GET',
      url: '/admin/agent-portal/state',
      headers: { cookie: ownerCookie },
    });
    expect(state.statusCode).toBe(200);
    const body = JSON.parse(state.payload) as Record<string, unknown>;
    expect(body).toMatchObject({ enabled: true, configured: true });
    expect(Object.keys(body).filter((key) => key.includes('matrix'))).toEqual([]);
    expect(created.magic_url).toContain('/go/u/');
  });
});
