import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { agentMessages, hosts } from '../../../src/db/schema.js';
import type { Env } from '../../../src/env.js';
import {
  AGENT_PORTAL_ENABLED_KEY,
  AgentPortalService,
  type PortalActor,
} from '../../../src/services/agent-portal.js';
import { getTestDb, type TestDb } from '../../helpers/test-db.js';
import { loadTestEnv, testKeyring } from '../../helpers/test-keyring.js';

/**
 * A console session as a message author, against real MySQL.
 *
 * `0027` made `agent_messages.portal_user_id` nullable and added
 * `admin_user_id`, which is what lets an operator instruct an agent from
 * /admin instead of exchanging a second credential at /go. Three properties of
 * that column had to survive the widening, and none of them can be checked
 * against `db-fake`:
 *
 *  1. **Authorship really lands in the new column.** Exactly one of the pair is
 *     set, and nothing writes the old one for an admin.
 *  2. **Idempotency spans both identity tables.** `uq_agent_messages_session_client`
 *     is a real unique index, so a `client_message_id` replayed by a different
 *     actor has to be refused as a conflict rather than resolved to the first
 *     row -- and comparing bare numeric ids would let admin #N satisfy portal
 *     user #N's retry.
 *  3. **Delivery re-reads the author.** Revoking an account has to cancel its
 *     undelivered instructions at the moment an agent reaches for one. That is
 *     a `SELECT ... FOR UPDATE` inside the claim transaction; the fake has
 *     neither row locks nor transactions.
 */

const PREFIX = 'ztest-admin-actor';
const HOST_FQDN = `${PREFIX}.example`;
const handle = await getTestDb();

describe.skipIf(!handle)('a console session as message author', { timeout: 120_000 }, () => {
  let db: TestDb;
  let env: Env;
  let host: typeof hosts.$inferSelect;
  let service: AgentPortalService;
  let adminId = 0;

  const exec = async (query: string) => await db.execute(sql.raw(query));
  const rowsOf = (res: unknown): Array<Record<string, unknown>> => {
    const first = Array.isArray(res) ? (res[0] as unknown) : res;
    return Array.isArray(first) ? (first as Array<Record<string, unknown>>) : [];
  };
  const adminActor = (): PortalActor => ({ kind: 'admin', user: { id: adminId, displayName: 'Console Operator' } });

  async function liveSession(): Promise<{ sessionId: string; bridgeToken: string }> {
    const registered = await service.registerAgent(host, {
      engine: 'codex',
      username: 'admin-actor-test',
      cwd: '/tmp/admin-actor-test',
      invocationKind: 'interactive',
    });
    if (!registered.enabled) throw new Error('portal unexpectedly disabled');
    // The relay has to be open or every cooperative write is refused.
    await service.heartbeatAgent(registered.session_id, registered.bridge_token, { relayAction: 'poll' }, host.id);
    return { sessionId: registered.session_id, bridgeToken: registered.bridge_token };
  }

  beforeAll(async () => {
    db = handle!.db;
    const now = new Date().toISOString();
    await exec(`DELETE FROM hosts WHERE fqdn = '${HOST_FQDN}'`);
    await exec(
      `INSERT INTO hosts (fqdn, api_key, status, engines, created_at, updated_at)
       VALUES ('${HOST_FQDN}', '${'b'.repeat(64)}', 'active', 'codex', '${now}', '${now}')`,
    );
    host = (await db.select().from(hosts).where(eq(hosts.fqdn, HOST_FQDN)).limit(1))[0]!;
    env = {
      ...loadTestEnv(),
      PUBLIC_BASE_URL: 'https://portal.example',
      AGENT_PORTAL_BRIDGE_TTL_SECONDS: 900,
      AGENT_PORTAL_RETENTION_HOURS: 24,
      AGENT_PORTAL_SESSION_TTL_HOURS: 24,
    } as Env;
    service = new AgentPortalService(db, env, testKeyring());
  });

  beforeEach(async () => {
    await exec(`DELETE FROM agent_messages WHERE session_id IN (SELECT id FROM agent_sessions WHERE host_id = ${host.id})`);
    await exec(`DELETE FROM agent_events WHERE session_id IN (SELECT id FROM agent_sessions WHERE host_id = ${host.id})`);
    await exec(`DELETE FROM agent_prompts WHERE session_id IN (SELECT id FROM agent_sessions WHERE host_id = ${host.id})`);
    await exec(`DELETE FROM agent_sessions WHERE host_id = ${host.id}`);
    await exec(`DELETE FROM admin_users WHERE username LIKE '${PREFIX}%'`);
    const now = new Date().toISOString();
    await exec(
      `INSERT INTO admin_users (name, username, email, password_hash, access_level, active, created_at, updated_at)
       VALUES ('Console Operator', '${PREFIX}-op', '${PREFIX}@example.test', 'x', 'owner', 1, '${now}', '${now}')`,
    );
    adminId = Number(rowsOf(await exec(`SELECT id FROM admin_users WHERE username = '${PREFIX}-op'`))[0]!.id);
    await service.setEnabled(true);
  });

  afterAll(async () => {
    await exec(`DELETE FROM agent_messages WHERE session_id IN (SELECT id FROM agent_sessions WHERE host_id = ${host.id})`);
    await exec(`DELETE FROM agent_sessions WHERE host_id = ${host.id}`);
    await exec(`DELETE FROM admin_users WHERE username LIKE '${PREFIX}%'`);
    await exec(`DELETE FROM hosts WHERE fqdn = '${HOST_FQDN}'`);
    await exec(
      `INSERT INTO versions (name, version, updated_at)
       VALUES ('${AGENT_PORTAL_ENABLED_KEY}', '0', '1970-01-01T00:00:00.000Z')
       ON DUPLICATE KEY UPDATE version = '0', updated_at = VALUES(updated_at)`,
    );
    await handle?.pool.end();
  });

  it('writes the admin column and leaves the portal one null', async () => {
    const { sessionId } = await liveSession();
    const result = await service.enqueueMessage(adminActor(), {
      sessionId,
      clientMessageId: randomUUID(),
      content: 'ship it',
    });

    const row = (await db.select().from(agentMessages).where(eq(agentMessages.messageId, String(result.message_id))).limit(1))[0]!;
    expect(row.adminUserId).toBe(adminId);
    expect(row.portalUserId).toBeNull();
  });

  it('names the admin as the author in the timeline the agent reads', async () => {
    const { sessionId } = await liveSession();
    await service.enqueueMessage(adminActor(), { sessionId, clientMessageId: randomUUID(), content: 'who sent this' });

    const page = await service.listEvents(sessionId, 0, 250);
    const authored = page.events.find((event) => event.type === 'user_message');
    expect((authored?.payload as Record<string, unknown>).author).toBe('Console Operator');
  });

  it('refuses a client_message_id replayed by a different actor', async () => {
    const { sessionId } = await liveSession();
    const clientMessageId = randomUUID();
    await service.enqueueMessage(adminActor(), { sessionId, clientMessageId, content: 'same text' });

    // A second admin is a different author even with identical content, and the
    // unique index means this cannot become a second row.
    const now = new Date().toISOString();
    await exec(
      `INSERT INTO admin_users (name, username, email, password_hash, access_level, active, created_at, updated_at)
       VALUES ('Other Operator', '${PREFIX}-other', '${PREFIX}-other@example.test', 'x', 'owner', 1, '${now}', '${now}')`,
    );
    const otherId = Number(rowsOf(await exec(`SELECT id FROM admin_users WHERE username = '${PREFIX}-other'`))[0]!.id);

    await expect(
      service.enqueueMessage(
        { kind: 'admin', user: { id: otherId, displayName: 'Other Operator' } },
        { sessionId, clientMessageId, content: 'same text' },
      ),
    ).rejects.toMatchObject({ code: 'client_message_id_conflict' });
  });

  it('resolves an honest retry by the same admin to the original row', async () => {
    const { sessionId } = await liveSession();
    const clientMessageId = randomUUID();
    const first = await service.enqueueMessage(adminActor(), { sessionId, clientMessageId, content: 'retry me' });
    const second = await service.enqueueMessage(adminActor(), { sessionId, clientMessageId, content: 'retry me' });
    expect(second.message_id).toBe(first.message_id);
  });

  it('delivers a message whose author is still active', async () => {
    const { sessionId, bridgeToken } = await liveSession();
    await service.enqueueMessage(adminActor(), { sessionId, clientMessageId: randomUUID(), content: 'still here' });

    const claimed = await service.claimMessage(sessionId, bridgeToken, randomUUID(), host.id);
    expect(claimed?.content).toBe('still here');
  });

  it('cancels a queued message when its admin is deactivated before delivery', async () => {
    const { sessionId, bridgeToken } = await liveSession();
    const queued = await service.enqueueMessage(adminActor(), {
      sessionId,
      clientMessageId: randomUUID(),
      content: 'should never arrive',
    });

    // The revocation an operator actually performs: the account is switched off
    // while its instruction is still sitting in the queue.
    await exec(`UPDATE admin_users SET active = 0 WHERE id = ${adminId}`);

    const claimed = await service.claimMessage(sessionId, bridgeToken, randomUUID(), host.id);
    expect(claimed).toBeNull();
    const row = (await db.select().from(agentMessages).where(eq(agentMessages.messageId, String(queued.message_id))).limit(1))[0]!;
    expect(row.status).toBe('canceled');
  });

  it('cancels a queued message when its admin is deleted outright', async () => {
    const { sessionId, bridgeToken } = await liveSession();
    const queued = await service.enqueueMessage(adminActor(), {
      sessionId,
      clientMessageId: randomUUID(),
      content: 'author is gone',
    });
    // No foreign key holds this, so the row survives its author and the claim
    // path is the only thing standing between a deleted account and an agent.
    await exec(`DELETE FROM admin_users WHERE id = ${adminId}`);

    const claimed = await service.claimMessage(sessionId, bridgeToken, randomUUID(), host.id);
    expect(claimed).toBeNull();
    const row = (await db.select().from(agentMessages).where(eq(agentMessages.messageId, String(queued.message_id))).limit(1))[0]!;
    expect(row.status).toBe('canceled');
  });

  it('refuses to enqueue at all once the admin is deactivated', async () => {
    const { sessionId } = await liveSession();
    await exec(`UPDATE admin_users SET active = 0 WHERE id = ${adminId}`);
    await expect(
      service.enqueueMessage(adminActor(), { sessionId, clientMessageId: randomUUID(), content: 'nope' }),
    ).rejects.toMatchObject({ code: 'admin_disabled' });
  });
});
