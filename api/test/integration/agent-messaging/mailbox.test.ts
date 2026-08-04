import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { eq, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { agentBusMessages, hosts } from '../../../src/db/schema.js';
import { splitSqlStatements } from '../../../src/db/migration-sql.js';
import type { Env } from '../../../src/env.js';
import {
  AGENT_MESSAGING_ENABLED_KEY,
  AgentMessagingService,
} from '../../../src/services/agent-messaging.js';
import type { Engine } from '../../../src/util/engine.js';
import { getTestDb, type TestDb } from '../../helpers/test-db.js';
import { loadTestEnv, testKeyring } from '../../helpers/test-keyring.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = [
  join(HERE, '../../../src/db/migrations/0008_add_agent_portal.sql'),
  join(HERE, '../../../src/db/migrations/0014_add_agent_messaging.sql'),
  join(HERE, '../../../src/db/migrations/0020_add_agent_call_pins.sql'),
];
const PREFIX = 'ztest-agent-mailbox';
const HOST_FQDN = `${PREFIX}.example`;
const HOST_KEY = 'e'.repeat(64);
const handle = await getTestDb();

interface AgentIdentity {
  sessionId: string;
  bridgeToken: string;
  address: string;
  addressId: string;
}

/**
 * The ring.
 *
 * An attached session has no interrupt: it exists only during a turn, the relay
 * refuses to write to it while its wrapper is attached, and it only pulls when it
 * calls `agent_listen`. Without this peek a message addressed to it expires
 * unread and neither side ever learns a call was placed.
 */
describe.skipIf(!handle)('mailbox peek against a real database', { timeout: 120_000 }, () => {
  let db: TestDb;
  let env: Env;
  let service: AgentMessagingService;
  let host: typeof hosts.$inferSelect;

  const exec = async (query: string) => await db.execute(sql.raw(query));

  const cleanup = async (): Promise<void> => {
    const hostId = host?.id ?? 0;
    const scoped = `SELECT id FROM agent_bus_addresses WHERE host_id = ${hostId}`;
    await exec(
      `DELETE FROM agent_bus_messages WHERE sender_address_id IN (${scoped}) OR target_address_id IN (${scoped})`,
    );
    await exec(
      `DELETE FROM agent_bus_conversations WHERE address_a_id IN (${scoped}) OR address_b_id IN (${scoped})`,
    );
    await exec(`DELETE FROM agent_sessions WHERE host_id = ${hostId}`);
    await exec(`DELETE FROM agent_bus_addresses WHERE host_id = ${hostId}`);
    await exec(`DELETE FROM admin_events WHERE host_id = ${hostId}`);
    await exec(`DELETE FROM logs WHERE host_id = ${hostId}`);
  };

  beforeAll(async () => {
    db = handle!.db;
    for (const migration of MIGRATIONS) {
      for (const statement of splitSqlStatements(readFileSync(migration, 'utf8'))) {
        await exec(statement);
      }
    }
    await exec(`DELETE FROM hosts WHERE fqdn = '${HOST_FQDN}'`);
    const now = new Date().toISOString();
    await exec(
      `INSERT INTO hosts (
         fqdn, api_key, status, secure, engines, agent_messaging_enabled, created_at, updated_at
       ) VALUES (
         '${HOST_FQDN}', '${HOST_KEY}', 'active', 1, 'codex,claude', 1, '${now}', '${now}'
       )`,
    );
    host = (await db.select().from(hosts).where(eq(hosts.fqdn, HOST_FQDN)).limit(1))[0]!;
    env = { ...loadTestEnv(), AGENT_PORTAL_BRIDGE_TTL_SECONDS: 900 } as Env;
    service = new AgentMessagingService(db, env, testKeyring());
  });

  beforeEach(async () => {
    await cleanup();
    await exec(
      `INSERT INTO versions (name, version, updated_at)
       VALUES ('${AGENT_MESSAGING_ENABLED_KEY}', '1', '2026-08-04T00:00:00.000Z')
       ON DUPLICATE KEY UPDATE version = '1', updated_at = VALUES(updated_at)`,
    );
  });

  afterEach(cleanup);

  afterAll(async () => {
    await cleanup();
    await exec(`DELETE FROM hosts WHERE fqdn = '${HOST_FQDN}'`);
    await exec(
      `INSERT INTO versions (name, version, updated_at)
       VALUES ('${AGENT_MESSAGING_ENABLED_KEY}', '0', '1970-01-01T00:00:00.000Z')
       ON DUPLICATE KEY UPDATE version = '0', updated_at = VALUES(updated_at)`,
    );
    await handle?.pool.end();
  });

  async function register(engine: Engine, label: string): Promise<AgentIdentity> {
    const sessionId = randomUUID();
    const bridgeToken = randomBytes(32).toString('base64url');
    const result = await service.registerSession(host, {
      engine,
      username: `${PREFIX}-${label}`,
      cwd: `/tmp/${PREFIX}/${label}`,
      invocationKind: 'interactive',
      sessionId,
      bridgeToken,
      adapterProtocol: 'test-live-v1',
      adapterCapabilities: { test: true },
    });
    const address = result.address as Record<string, unknown>;
    return { sessionId, bridgeToken, address: String(address.address), addressId: String(address.id) };
  }

  it('reports a waiting caller without ever having bound receive-capable', async () => {
    const caller = await register('claude', 'caller');
    const target = await register('claude', 'target');
    await service.sendMessage(caller.sessionId, caller.bridgeToken, {
      to: target.address,
      content: 'are you there?',
      clientMessageId: randomUUID(),
    });

    // The target has never called agent_listen, so it is not receive-capable.
    // claimForSession would refuse it — this must not, since that is exactly the
    // state the ring exists to rescue.
    const box = await service.peekMailbox(target.sessionId, target.bridgeToken);
    const pending = box.pending as Record<string, unknown>[];
    expect(pending).toHaveLength(1);
    expect((pending[0]!.from as Record<string, unknown>).address).toBe(caller.address);
    expect((pending[0]!.from as Record<string, unknown>).fqdn).toBe(HOST_FQDN);
    expect(pending[0]!.expires_at).toBeTruthy();
  });

  it('takes no lease and changes nothing — peeking is not claiming', async () => {
    const caller = await register('claude', 'caller');
    const target = await register('claude', 'target');
    const sent = await service.sendMessage(caller.sessionId, caller.bridgeToken, {
      to: target.address,
      content: 'ring ring',
      clientMessageId: randomUUID(),
    });
    const messageId = String((sent.message as Record<string, unknown>).id);
    const before = (
      await db.select().from(agentBusMessages).where(eq(agentBusMessages.id, messageId)).limit(1)
    )[0]!;

    await service.peekMailbox(target.sessionId, target.bridgeToken);
    await service.peekMailbox(target.sessionId, target.bridgeToken);

    const after = (
      await db.select().from(agentBusMessages).where(eq(agentBusMessages.id, messageId)).limit(1)
    )[0]!;
    expect(after.status).toBe('queued');
    expect(after.attempts).toBe(before.attempts);
    expect(after.leaseOwner).toBeNull();
    expect(after.updatedAt).toBe(before.updatedAt);
  });

  it('never hands over the body — hearing the phone ring is not answering it', async () => {
    const caller = await register('claude', 'caller');
    const target = await register('claude', 'target');
    await service.sendMessage(caller.sessionId, caller.bridgeToken, {
      to: target.address,
      content: 'a secret worth not leaking',
      clientMessageId: randomUUID(),
    });

    const box = await service.peekMailbox(target.sessionId, target.bridgeToken);
    expect(JSON.stringify(box)).not.toContain('a secret worth not leaking');
  });

  it('surfaces a call that expired unanswered, which is otherwise invisible', async () => {
    const caller = await register('claude', 'caller');
    const target = await register('claude', 'target');
    const sent = await service.sendMessage(caller.sessionId, caller.bridgeToken, {
      to: target.address,
      content: 'anyone home?',
      clientMessageId: randomUUID(),
    });
    const messageId = String((sent.message as Record<string, unknown>).id);

    await exec(`UPDATE agent_bus_messages SET expires_at = '2000-01-01T00:00:00.000Z' WHERE id = '${messageId}'`);
    await service.maintenance();

    const box = await service.peekMailbox(target.sessionId, target.bridgeToken);
    expect(box.pending).toHaveLength(0);
    const missed = box.missed as Record<string, unknown>[];
    expect(missed).toHaveLength(1);
    // Without this the outcome is silence on both ends: the caller sees "no
    // answer" and the target never learns anyone rang.
    expect((missed[0]!.from as Record<string, unknown>).address).toBe(caller.address);
  });

  it('is empty for a session with nothing waiting', async () => {
    const target = await register('claude', 'target');
    const box = await service.peekMailbox(target.sessionId, target.bridgeToken);
    expect(box.pending).toHaveLength(0);
    expect(box.missed).toHaveLength(0);
  });
});
