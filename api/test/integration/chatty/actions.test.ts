import { randomBytes, randomUUID } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { adminSessions, adminUsers, chattySessions, hosts } from '../../../src/db/schema.js';
import { AdminAuthService } from '../../../src/services/admin-auth.js';
import { registerAdminChattyRoutes } from '../../../src/routes/admin/chatty/index.js';
import {
  actionElementResolver,
  databaseActionLookups,
  resolveAction,
} from '../../../src/services/chatty/actions.js';
import { ChattyStore, now } from '../../../src/services/chatty/store.js';
import { ChattyCoordinator } from '../../../src/services/chatty/coordinator.js';
import { buildAppWithDb } from '../../helpers/build-app.js';
import { getTestDb } from '../../helpers/test-db.js';
import { loadTestEnv, testKeyring } from '../../helpers/test-keyring.js';

const handle = await getTestDb();

// Real rows, real admin sessions and the real verify route. Nothing here may change a host.
describe.skipIf(!handle)('Chatty action proposals (isolated MySQL)', () => {
  const db = handle ? handle.db : (undefined as never);
  const keyring = testKeyring();
  const env = loadTestEnv();
  const prefix = `chatty-actions-${randomUUID().slice(0, 8)}`;
  const visible = `${prefix}.example.com`;
  const internal = `${prefix}-runner.internal`;
  let app: FastifyInstance;
  let userId = 0;
  let hostId = 0;
  const sessions: Array<{ id: number; cookie: string }> = [];

  beforeAll(async () => {
    const at = now();
    await db.insert(adminUsers).values({
      username: prefix,
      name: 'Chatty actions',
      email: `${prefix}@example.test`,
      passwordHash: 'unused-test-session',
      accessLevel: 'owner',
      active: 1,
      createdAt: at,
      updatedAt: at,
    });
    userId = (await db.select().from(adminUsers).where(eq(adminUsers.username, prefix)))[0]!.id;
    const user = (await db.select().from(adminUsers).where(eq(adminUsers.id, userId)))[0]!;
    const auth = new AdminAuthService(db, env);
    for (const label of ['a', 'b']) {
      const session = await auth.createSession(user, '127.0.0.1', `chatty-actions-${label}`, `test.chatty.${label}`);
      const row = (await db.select().from(adminSessions).where(eq(adminSessions.userId, userId))).find(
        (s) => !sessions.some((x) => x.id === s.id),
      )!;
      sessions.push({ id: row.id, cookie: `${auth.sessionCookieName()}=${session.token}` });
    }
    const insert = (fqdn: string, internalRole: string | null) =>
      db.insert(hosts).values({
        fqdn,
        internalRole,
        apiKey: randomBytes(32).toString('hex'),
        engines: 'codex',
        status: 'active',
        secure: 1,
        createdAt: at,
        updatedAt: at,
      });
    await insert(visible, null);
    await insert(internal, 'chatty');
    hostId = (await db.select({ id: hosts.id }).from(hosts).where(eq(hosts.fqdn, visible)))[0]!.id;
    // The route module starts the Chatty worker; here it must not claim runs other suites queue in this database.
    vi.spyOn(ChattyCoordinator.prototype, 'tick').mockResolvedValue(undefined);
    app = await buildAppWithDb(db, { env, keyring });
    await registerAdminChattyRoutes(app, { db, env, keyring } as never);
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    await db.delete(hosts).where(inArray(hosts.fqdn, [visible, internal]));
    await db.delete(chattySessions).where(eq(chattySessions.userId, userId));
    await db.delete(adminSessions).where(eq(adminSessions.userId, userId));
    await db.delete(adminUsers).where(eq(adminUsers.id, userId));
  });

  const mint = async (sessionIndex: number, request: { action: string; params: Record<string, unknown> }) => {
    const generation = (await new ChattyStore(db, keyring).session(userId)).generation;
    const resolver = actionElementResolver(
      keyring,
      { userId, sessionId: sessions[sessionIndex]!.id, generation },
      () => true,
      databaseActionLookups({ db, keyring }),
    );
    const out = await resolver(request);
    if (!out.ok) throw new Error(out.detail);
    return out.element;
  };
  const verify = async (sessionIndex: number, proposal: string) => {
    const response = await app.inject({
      method: 'POST',
      url: '/admin/chatty/proposals/verify',
      headers: { cookie: sessions[sessionIndex]!.cookie, 'content-type': 'application/json' },
      payload: { proposal },
    });
    expect(response.statusCode, response.body).toBe(200);
    return (response.json() as { data: Record<string, unknown> }).data;
  };

  it('resolves real rows and never internal or unknown hosts', async () => {
    const lookups = databaseActionLookups({ db, keyring });
    expect(await resolveAction({ action: 'host.engine.enable', params: { host: visible.toUpperCase(), engine: 'claude' } }, () => true, lookups)).toMatchObject({
      ok: true,
      params: { host: hostId, engine: 'claude' },
      plan: { engines_before: ['codex'], engines_after: ['codex', 'claude'] },
    });
    for (const host of [internal, `${prefix}.missing.example`, "x' OR '1'='1"])
      expect(await resolveAction({ action: 'host.engine.enable', params: { host, engine: 'claude' } }, () => true, lookups)).toMatchObject({
        ok: false,
        reason: 'not_found',
      });
    // A secure host has no insecure window to close.
    expect(await resolveAction({ action: 'host.insecure.close', params: { host: hostId } }, () => true, lookups)).toMatchObject({
      ok: false,
      reason: 'no_change',
    });
  });

  it('verifies only for the minting admin session and generation, and never mutates', async () => {
    const element = await mint(0, { action: 'host.engine.enable', params: { host: visible, engine: 'claude' } });
    expect(await verify(0, element.proposal)).toMatchObject({
      available: true,
      action: 'host.engine.enable',
      risk: 'confirm',
      plan: { host_id: hostId, engines_after: ['codex', 'claude'] },
    });
    expect(await verify(1, element.proposal)).toMatchObject({ available: false, reason: 'expired' });
    expect(await verify(0, `${element.proposal.slice(0, -2)}AA`)).toMatchObject({ available: false, reason: 'expired' });
    expect((await db.select({ engines: hosts.engines }).from(hosts).where(eq(hosts.id, hostId)))[0]!.engines).toBe('codex');

    // The target changed: the old button no longer describes a real change.
    await db.update(hosts).set({ engines: 'codex,claude' }).where(eq(hosts.id, hostId));
    expect(await verify(0, element.proposal)).toMatchObject({ available: false, reason: 'no_change' });
    await db.update(hosts).set({ engines: 'codex' }).where(eq(hosts.id, hostId));

    // Clear advances the conversation generation and retires every outstanding proposal.
    const cleared = await app.inject({ method: 'DELETE', url: '/admin/chatty/session', headers: { cookie: sessions[0]!.cookie } });
    expect(cleared.statusCode, cleared.body).toBe(200);
    expect(await verify(0, element.proposal)).toMatchObject({ available: false, reason: 'expired' });
  });

  it('refuses an unauthenticated verification', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/admin/chatty/proposals/verify',
      headers: { 'content-type': 'application/json' },
      payload: { proposal: 'v1.x.y.z' },
    });
    expect(response.statusCode).toBe(401);
  });
});
