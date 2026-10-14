import { randomBytes, randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { agentSessions, hosts } from '../../../src/db/schema.js';
import { AgentMessagingService } from '../../../src/services/agent-messaging.js';
import { getTestDb } from '../../helpers/test-db.js';
import { loadTestEnv, testKeyring } from '../../helpers/test-keyring.js';
import { markPersistentHost, persistRelayUsers } from '../../helpers/persistent-host.js';

const handle = await getTestDb();

// The portal's /activity report locks hosts -> agent_sessions. A session claim
// and agent_self locked the session first and deadlocked against it in
// production right after a deploy; every path must use the same order.
describe.skipIf(!handle)('session heartbeat vs activity lock order', () => {
  let host: typeof hosts.$inferSelect;
  let messaging: AgentMessagingService;
  beforeAll(async () => {
    const db = handle!.db, now = new Date().toISOString();
    const fqdn = `lock-order-${randomUUID()}.test`;
    await db.insert(hosts).values({ fqdn, apiKey: 'f'.repeat(64), engines: 'codex,claude,grok', status: 'active', secure: 1, createdAt: now, updatedAt: now });
    host = (await db.select().from(hosts).where(eq(hosts.fqdn, fqdn)))[0]!;
    await markPersistentHost(db, host.id);
    await db.execute(sql`INSERT INTO versions (name,version,updated_at) VALUES ('agent_messaging_enabled','1',${now}), ('agent_portal_enabled','1',${now}) ON DUPLICATE KEY UPDATE version=VALUES(version)`);
    messaging = persistRelayUsers(db, new AgentMessagingService(db, loadTestEnv(), testKeyring()));
  });
  afterAll(async () => {
    const db = handle!.db;
    await db.execute(sql`DELETE FROM agent_sessions WHERE host_id=${host.id}`);
    await db.execute(sql`DELETE FROM agent_bus_addresses WHERE host_id=${host.id}`);
    await db.delete(hosts).where(eq(hosts.id, host.id));
    await db.execute(sql`UPDATE versions SET version='0' WHERE name IN ('agent_messaging_enabled','agent_portal_enabled')`);
    await handle!.pool.end();
  });

  async function session() {
    const id = randomUUID(), token = randomBytes(32).toString('base64url');
    await messaging.registerSession(host, { sessionId: id, bridgeToken: token, engine: 'codex', username: randomUUID(), cwd: '/tmp/lock-order', invocationKind: 'interactive', upstreamSessionId: randomUUID() });
    await handle!.db.update(agentSessions).set({ receiveHeartbeatAt: new Date().toISOString() }).where(eq(agentSessions.id, id));
    return { id, token };
  }

  // Hold the host row; a transaction following hosts -> agent_sessions waits
  // before it owns the session row, so a NOWAIT probe on the session succeeds.
  async function assertHostFirst(sessionId: string, run: () => Promise<unknown>) {
    const holder = await handle!.pool.getConnection();
    const probe = await handle!.pool.getConnection();
    try {
      await holder.query('START TRANSACTION');
      await holder.query('SELECT id FROM hosts WHERE id = ? FOR UPDATE', [host.id]);
      const pending = run().catch((error: unknown) => error);
      await new Promise((resolve) => setTimeout(resolve, 500));
      await probe.query('START TRANSACTION');
      await expect(probe.query('SELECT id FROM agent_sessions WHERE id = ? FOR UPDATE NOWAIT', [sessionId])).resolves.toBeDefined();
      await probe.query('ROLLBACK');
      await holder.query('ROLLBACK');
      await pending;
    } finally {
      await probe.query('ROLLBACK').catch(() => {});
      await holder.query('ROLLBACK').catch(() => {});
      probe.release();
      holder.release();
    }
  }

  it('session claim locks the host before the session', async () => {
    const s = await session();
    await assertHostFirst(s.id, () => messaging.claimForSession(s.id, s.token, randomUUID()));
  });

  it('agent_self locks the host before the session', async () => {
    const s = await session();
    await assertHostFirst(s.id, () => messaging.self(s.id, s.token));
  });

  it('session heartbeat locks the host before the session', async () => {
    const s = await session();
    await assertHostFirst(s.id, () => messaging.heartbeatSession(s.id, s.token, {}));
  });
});
