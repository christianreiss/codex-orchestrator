import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { eq, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { agentBusAddresses, agentSessions, hosts } from '../../../src/db/schema.js';
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
      adapterCapabilities: { test: true, execution_contract_version: 2 },
    });
    const address = result.address as Record<string, unknown>;
    return { sessionId, bridgeToken, address: String(address.address), addressId: String(address.id) };
  }

  /**
   * Put a receiver on the line, the way the wrapper's heartbeat does. A join is
   * refused unless the opener can actually be woken, so any test that dials a PIN
   * has to make its opener `listening` first.
   */
  const listen = async (agent: AgentIdentity): Promise<void> => {
    await db
      .update(agentSessions)
      .set({
        receiver: {
          generation: randomUUID(),
          protocol: 'claude-channel-v1',
          native_session_id: randomUUID(),
          heartbeat_at: new Date().toISOString(),
          failure: null,
          probes: { peer: {}, portal: {} },
        },
      })
      .where(eq(agentSessions.id, agent.sessionId));
  };

  /**
   * Registration stamps a fresh receive heartbeat, so a brand-new session reads
   * as `listening` on the legacy path for a window. Age it out to model an agent
   * whose receiver never came up.
   */
  const deafen = async (agent: AgentIdentity): Promise<void> => {
    await db
      .update(agentBusAddresses)
      .set({ receiveHeartbeatAt: '1970-01-01T00:00:00.000Z' })
      .where(eq(agentBusAddresses.id, agent.addressId));
    await db.update(agentSessions).set({ receiver: null }).where(eq(agentSessions.id, agent.sessionId));
  };

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

  it('replays the original hello after its single-use PIN was consumed', async () => {
    const opener = await register('claude', 'opener');
    const caller = await register('codex', 'caller');
    await listen(opener);
    const opened = await service.openCall(opener.sessionId, opener.bridgeToken);
    const input = { pin: String(opened.pin), content: 'HELLO', clientMessageId: randomUUID() };
    const first = await service.joinCall(caller.sessionId, caller.bridgeToken, input);
    expect(await pinOf(opener.addressId)).toBeNull();
    const replay = await service.joinCall(caller.sessionId, caller.bridgeToken, input);
    expect(replay.conversation_id).toBe(first.conversation_id);
    expect((replay.message as Record<string, unknown>).id).toBe((first.message as Record<string, unknown>).id);
    expect(replay.created).toBe(false);
    await expect(service.joinCall(caller.sessionId, caller.bridgeToken, { ...input, content: 'different hello' }))
      .rejects.toMatchObject({ code: 'agent_messaging_idempotency_conflict' });
  });

  it('tells the opener whether a receiver is on the line', async () => {
    const opener = await register('claude', 'opener');
    await deafen(opener);
    const before = await service.openCall(opener.sessionId, opener.bridgeToken);
    // No receiver yet: a joiner's hello would go unclaimed, so say so up front.
    expect(before.listening).toBe(false);
    expect((before.self as Record<string, unknown>).presence).toBe('online');

    await listen(opener);
    const after = await service.openCall(opener.sessionId, opener.bridgeToken);
    expect(after.listening).toBe(true);
    expect((after.self as Record<string, unknown>).presence).toBe('listening');
  });

  it('refuses a join onto an opener that cannot receive, and keeps the PIN live', async () => {
    const opener = await register('claude', 'opener');
    const joiner = await register('codex', 'joiner');
    await deafen(opener);
    const opened = await service.openCall(opener.sessionId, opener.bridgeToken);
    const hello = { pin: String(opened.pin), content: 'CALL/1 HELLO\nhi', clientMessageId: randomUUID() };

    // Eligible but deaf: without this gate the hello queues, nobody claims it and
    // both agents yield waiting on each other.
    await expect(service.joinCall(joiner.sessionId, joiner.bridgeToken, hello)).rejects.toMatchObject({
      code: 'agent_messaging_call_peer_not_listening',
    });
    expect(await pinOf(opener.addressId)).toBe(opened.pin);

    // A receiver that reports a failure is not on the line either.
    await listen(opener);
    await db
      .update(agentSessions)
      .set({
        receiver: {
          generation: randomUUID(),
          protocol: 'claude-channel-v1',
          native_session_id: randomUUID(),
          heartbeat_at: new Date().toISOString(),
          failure: 'channel_dropped',
          probes: { peer: {}, portal: {} },
        },
      })
      .where(eq(agentSessions.id, opener.sessionId));
    await expect(service.joinCall(joiner.sessionId, joiner.bridgeToken, hello)).rejects.toMatchObject({
      code: 'agent_messaging_call_peer_not_listening',
    });
    expect(await pinOf(opener.addressId)).toBe(opened.pin);

    // The same PIN then works once the receiver is back: nothing was burned.
    await listen(opener);
    const joined = await service.joinCall(joiner.sessionId, joiner.bridgeToken, hello);
    expect(joined.conversation_id).toEqual(expect.any(String));
    expect(await pinOf(opener.addressId)).toBeNull();
  });

  it('round-trips a PIN with leading zeros', async () => {
    const opener = await register('claude', 'opener');
    const joiner = await register('codex', 'joiner');
    await listen(opener);
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
    await listen(opener);
    const opened = await service.openCall(opener.sessionId, opener.bridgeToken);

    const joined = await service.joinCall(joiner.sessionId, joiner.bridgeToken, {
      pin: String(opened.pin),
      content: 'CALL/1 HELLO\nhello',
      clientMessageId: randomUUID(),
    });

    expect((joined.message as Record<string, unknown>).status).toBe('queued');
    expect(await pinOf(opener.addressId)).toBeNull();

    // Single-use: the same PIN cannot be dialled twice. The wording is asserted
    // alongside the code because the wording is what a third agent acts on: a
    // bare "not found" reads as a typo and gets re-dialled forever, so the
    // message has to name the spent case and point at the conference.
    await expect(
      service.joinCall(joiner.sessionId, joiner.bridgeToken, {
        pin: String(opened.pin),
        content: 'CALL/1 HELLO\nagain',
        clientMessageId: randomUUID(),
      }),
    ).rejects.toMatchObject({
      code: 'agent_messaging_call_pin_not_found',
      message: expect.stringMatching(/already dialled[\s\S]*conference/),
    });
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
