import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { eq, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { agentBusAddresses, hosts } from '../../../src/db/schema.js';
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
const PREFIX = 'ztest-agent-call';
const HOST_FQDN = `${PREFIX}.example`;
const HOST_KEY = 'c'.repeat(64);
const handle = await getTestDb();

interface AgentIdentity {
  sessionId: string;
  bridgeToken: string;
  address: string;
  addressId: string;
}

describe.skipIf(!handle)('#call rendezvous against a real database', { timeout: 120_000 }, () => {
  let db: TestDb;
  let env: Env;
  let service: AgentMessagingService;
  let host: typeof hosts.$inferSelect;

  const exec = async (query: string) => await db.execute(sql.raw(query));

  const cleanup = async (): Promise<void> => {
    const hostId = host?.id ?? 0;
    await exec(`DELETE FROM agent_bus_messages WHERE sender_address_id IN (
      SELECT id FROM agent_bus_addresses WHERE host_id = ${hostId}
    ) OR target_address_id IN (
      SELECT id FROM agent_bus_addresses WHERE host_id = ${hostId}
    )`);
    await exec(`DELETE FROM agent_bus_conversations WHERE address_a_id IN (
      SELECT id FROM agent_bus_addresses WHERE host_id = ${hostId}
    ) OR address_b_id IN (
      SELECT id FROM agent_bus_addresses WHERE host_id = ${hostId}
    )`);
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

  const pinOf = async (addressId: string): Promise<string | null> => {
    const rows = await db
      .select({ callPin: agentBusAddresses.callPin })
      .from(agentBusAddresses)
      .where(eq(agentBusAddresses.id, addressId))
      .limit(1);
    return rows[0]?.callPin ?? null;
  };

  it('mints a four-digit PIN and tells the opener its own address', async () => {
    const opener = await register('claude', 'opener');
    const opened = await service.openCall(opener.sessionId, opener.bridgeToken);

    expect(String(opened.pin)).toMatch(/^[0-9]{4}$/);
    // The only route by which an agent learns its own address: listAddresses
    // excludes the caller by construction.
    expect((opened.self as Record<string, unknown>).address).toBe(opener.address);
    expect(opened.reused).toBe(false);
    expect(await pinOf(opener.addressId)).toBe(opened.pin);
  });

  it('round-trips a PIN with leading zeros', async () => {
    const opener = await register('claude', 'opener');
    const joiner = await register('codex', 'joiner');
    await service.openCall(opener.sessionId, opener.bridgeToken);
    // Force the one value an integer column or a stray parseInt would destroy.
    await db
      .update(agentBusAddresses)
      .set({ callPin: '0042' })
      .where(eq(agentBusAddresses.id, opener.addressId));

    const joined = await service.joinCall(joiner.sessionId, joiner.bridgeToken, {
      pin: '0042',
      content: 'CALL/1 HELLO pin=0042\njoiner here',
      clientMessageId: randomUUID(),
    });

    expect((joined.peer as Record<string, unknown>).address).toBe(opener.address);
    expect(joined.conversation_id).toEqual(expect.any(String));
  });

  it('re-opening while a PIN is live returns the same PIN', async () => {
    const opener = await register('claude', 'opener');
    const first = await service.openCall(opener.sessionId, opener.bridgeToken);
    const second = await service.openCall(opener.sessionId, opener.bridgeToken);

    // Minting a second would silently kill a PIN the human already wrote down.
    expect(second.pin).toBe(first.pin);
    expect(second.reused).toBe(true);
    expect(second.expires_at).toBe(first.expires_at);
  });

  it('opens the conversation, queues the hello and consumes the PIN in one step', async () => {
    const opener = await register('claude', 'opener');
    const joiner = await register('codex', 'joiner');
    const opened = await service.openCall(opener.sessionId, opener.bridgeToken);

    const joined = await service.joinCall(joiner.sessionId, joiner.bridgeToken, {
      pin: String(opened.pin),
      content: 'CALL/1 HELLO\nhello',
      clientMessageId: randomUUID(),
    });

    expect((joined.message as Record<string, unknown>).status).toBe('queued');
    expect(await pinOf(opener.addressId)).toBeNull();

    // Single-use: the same PIN cannot be dialled twice.
    await expect(
      service.joinCall(joiner.sessionId, joiner.bridgeToken, {
        pin: String(opened.pin),
        content: 'CALL/1 HELLO\nagain',
        clientMessageId: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: 'agent_messaging_call_pin_not_found' });
  });

  it('leaves the PIN live when a join fails', async () => {
    const opener = await register('claude', 'opener');
    const other = await register('codex', 'other');
    const opened = await service.openCall(opener.sessionId, opener.bridgeToken);

    // Dialling your own PIN must not burn it.
    await expect(
      service.joinCall(opener.sessionId, opener.bridgeToken, {
        pin: String(opened.pin),
        content: 'CALL/1 HELLO\nself',
        clientMessageId: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: 'validation_failed' });
    expect(await pinOf(opener.addressId)).toBe(opened.pin);

    // Nor may an ineligible opener burn it: the human is still holding this PIN.
    await service.setAddressEnabled(opener.addressId, false);
    await expect(
      service.joinCall(other.sessionId, other.bridgeToken, {
        pin: String(opened.pin),
        content: 'CALL/1 HELLO\nhi',
        clientMessageId: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: 'agent_messaging_call_pin_not_found' });
  });

  it('clears the PIN when the opener disables, finishes, or the fleet switch goes off', async () => {
    const disabled = await register('claude', 'disabled');
    const finished = await register('claude', 'finished');
    const switched = await register('codex', 'switched');
    for (const agent of [disabled, finished, switched]) {
      await service.openCall(agent.sessionId, agent.bridgeToken);
    }

    // A PIN lives on the address, which outlives the session, so every path that
    // takes an agent off the line has to clear it or a later join reaches a dead
    // address.
    await service.setAddressEnabled(disabled.addressId, false);
    expect(await pinOf(disabled.addressId)).toBeNull();

    await service.finishSession(finished.sessionId, finished.bridgeToken, 'completed');
    expect(await pinOf(finished.addressId)).toBeNull();

    await service.setEnabled(false);
    expect(await pinOf(switched.addressId)).toBeNull();
  });

  it('sweeps an expired PIN rather than letting it squat its slot', async () => {
    const opener = await register('claude', 'opener');
    const first = await service.openCall(opener.sessionId, opener.bridgeToken);
    await db
      .update(agentBusAddresses)
      .set({ callPinExpiresAt: '1970-01-01T00:00:00.000Z' })
      .where(eq(agentBusAddresses.id, opener.addressId));

    const second = await service.openCall(opener.sessionId, opener.bridgeToken);
    expect(second.reused).toBe(false);
    expect(second.pin).not.toBe(first.expires_at);

    // And an expired PIN is no longer dialable.
    const joiner = await register('codex', 'joiner');
    await db
      .update(agentBusAddresses)
      .set({ callPinExpiresAt: '1970-01-01T00:00:00.000Z' })
      .where(eq(agentBusAddresses.id, opener.addressId));
    await expect(
      service.joinCall(joiner.sessionId, joiner.bridgeToken, {
        pin: String(second.pin),
        content: 'CALL/1 HELLO\nhi',
        clientMessageId: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: 'agent_messaging_call_pin_not_found' });
  });

  it('gives concurrent openers distinct PINs', async () => {
    const agents = await Promise.all([
      register('claude', 'race-a'),
      register('codex', 'race-b'),
      register('claude', 'race-c'),
    ]);
    const opened = await Promise.all(
      agents.map((agent) => service.openCall(agent.sessionId, agent.bridgeToken)),
    );
    const pins = opened.map((result) => String(result.pin));
    expect(new Set(pins).size).toBe(pins.length);
  });

  it('rejects a malformed PIN before it can reach an address', async () => {
    const joiner = await register('codex', 'joiner');
    for (const pin of ['', '42', '12345', 'abcd']) {
      await expect(
        service.joinCall(joiner.sessionId, joiner.bridgeToken, {
          pin,
          content: 'CALL/1 HELLO\nhi',
          clientMessageId: randomUUID(),
        }),
      ).rejects.toMatchObject({ code: 'validation_failed' });
    }
  });
});
