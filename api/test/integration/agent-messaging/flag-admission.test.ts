import { randomBytes, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { eq, inArray, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { agentBusMessages, hosts, type AgentBusAddress } from '../../../src/db/schema.js';
import { runMigrations } from '../../../src/db/migrator.js';
import { AgentMessagingService, AGENT_MESSAGING_ENABLED_KEY } from '../../../src/services/agent-messaging.js';
import type { AgentMessagingDb } from '../../../src/services/agent-messaging/types.js';
import { wsPublisher } from '../../../src/ws/publisher.js';
import { getTestDb, type TestDb } from '../../helpers/test-db.js';
import { loadTestEnv, testKeyring } from '../../helpers/test-keyring.js';
import type { Engine } from '../../../src/util/engine.js';

const handle = await getTestDb();
const prefix = 'ztest-flag-admission';
function latch() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
// Hold real transactions AFTER their actual admission read. No lock behavior is mocked.
type Admission = { requireEnabledLocked(tx: AgentMessagingDb): Promise<void> };
function holdOneAdmission(service: AgentMessagingService) {
  const admitted = latch();
  const release = latch();
  const seam = service as unknown as Admission;
  const original = seam.requireEnabledLocked.bind(service);
  let first = true;
  const spy = vi.spyOn(seam, 'requireEnabledLocked').mockImplementation(async (tx) => {
    await original(tx);
    if (first) {
      first = false;
      admitted.resolve();
      await release.promise;
    }
  });
  return { admitted, release, spy };
}
interface Identity {
  sessionId: string;
  token: string;
  address: string;
  id: string;
}

describe.skipIf(!handle)('messaging admission linearizability on real MySQL', { timeout: 20_000 }, () => {
  let db: TestDb;
  let pool: NonNullable<typeof handle>['pool'];
  let service: AgentMessagingService;
  let identities: Identity[];
  const hostIds: number[] = [];
  const exec = async (query: string) => db.execute(sql.raw(query));
  const events: string[] = [];
  let unsubscribe: () => void;

  async function cleanup() {
    if (!hostIds.length) return;
    const ids = hostIds.join(',');
    const addresses = `SELECT id FROM agent_bus_addresses WHERE host_id IN (${ids})`;
    await exec(`DELETE FROM agent_bus_publications WHERE sender_address_id IN (${addresses})`);
    await exec(`DELETE FROM agent_bus_subscriptions WHERE subscriber_address_id IN (${addresses})`);
    await exec(
      `DELETE FROM agent_bus_messages WHERE sender_address_id IN (${addresses}) OR target_address_id IN (${addresses})`,
    );
    await exec(
      `DELETE FROM agent_bus_conversations WHERE address_a_id IN (${addresses}) OR address_b_id IN (${addresses})`,
    );
    await exec(`DELETE FROM agent_bus_relays WHERE host_id IN (${ids})`);
    await exec(`DELETE FROM agent_sessions WHERE host_id IN (${ids})`);
    await exec(`DELETE FROM agent_bus_addresses WHERE host_id IN (${ids})`);
    await exec(`DELETE FROM logs WHERE host_id IN (${ids})`);
    await exec(`DELETE FROM hosts WHERE id IN (${ids})`);
    hostIds.length = 0;
  }

  beforeAll(async () => {
    db = handle!.db;
    pool = handle!.pool;
    await runMigrations(pool);
    unsubscribe = wsPublisher.subscribe((event) => events.push(event.type));
  });
  beforeEach(async () => {
    await exec(
      `INSERT INTO versions (name, version, updated_at) VALUES ('${AGENT_MESSAGING_ENABLED_KEY}', '1', '2026-10-13T00:00:00.000Z') ON DUPLICATE KEY UPDATE version='1'`,
    );
    service = new AgentMessagingService(
      db,
      { ...loadTestEnv(), AGENT_PORTAL_BRIDGE_TTL_SECONDS: 900 },
      testKeyring(),
    );
    identities = [];
    for (let i = 0; i < 4; i++) {
      const fqdn = `${prefix}-${i}.example`;
      const now = new Date().toISOString();
      await exec(
        `INSERT INTO hosts (fqdn, api_key, status, secure, engines, agent_messaging_enabled, created_at, updated_at) VALUES ('${fqdn}', '${randomBytes(32).toString('hex')}', 'active', 1, 'codex,claude,grok', 1, '${now}', '${now}')`,
      );
      const [host] = await db.select().from(hosts).where(eq(hosts.fqdn, fqdn));
      hostIds.push(host!.id);
      const sessionId = randomUUID();
      const token = randomBytes(32).toString('base64url');
      const engine: Engine = (['codex', 'claude', 'grok', 'codex'] as const)[i]!;
      const result = await service.registerSession(host!, {
        engine,
        sessionId,
        upstreamSessionId: randomUUID(),
        bridgeToken: token,
        username: `${prefix}-${i}`,
        cwd: `/tmp/${prefix}/${i}`,
        invocationKind: 'interactive',
        adapterProtocol: 'test-live-v1',
        adapterCapabilities: { execution_contract_version: 2 },
      });
      const address = result.address as { address: string; id: string };
      identities.push({ sessionId, token, address: address.address, id: address.id });
    }
    events.length = 0;
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await cleanup();
  });
  afterAll(async () => {
    unsubscribe?.();
    await cleanup();
    await exec(`UPDATE versions SET version='0' WHERE name='${AGENT_MESSAGING_ENABLED_KEY}'`);
    await pool.end();
  });

  function currentMessages() {
    return db
      .select()
      .from(agentBusMessages)
      .where(
        inArray(
          agentBusMessages.senderAddressId,
          identities.map((i) => i.id),
        ),
      );
  }

  function send(from: number, to: number, key = randomUUID()) {
    const actor = identities[from]!;
    return service.sendMessage(actor.sessionId, actor.token, {
      to: identities[to]!.address,
      content: 'one durable effect',
      clientMessageId: key,
    });
  }

  async function waitForFlagWaiter(minimum = 1) {
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      const [rows] = await pool.query(
        `SELECT COUNT(*) AS n FROM performance_schema.data_lock_waits w JOIN performance_schema.data_locks l ON w.REQUESTING_ENGINE_LOCK_ID=l.ENGINE_LOCK_ID WHERE l.OBJECT_SCHEMA=DATABASE() AND l.OBJECT_NAME='versions'`,
      );
      if (Number((rows as Array<{ n: number }>)[0]!.n) >= minimum) return;
      await delay(10);
    }
    throw new Error('No real InnoDB flag lock waiter appeared');
  }

  async function relayFor(index: number) {
    const identity = identities[index]!;
    await service.finishSession(identity.sessionId, identity.token, 'completed');
    const [host] = await db.select().from(hosts).where(eq(hosts.id, hostIds[index]!));
    const relay = await service.registerRelay(host!, {
      username: `${prefix}-${index}`,
      instanceId: randomUUID(),
      wrapperVersion: 'test',
      capabilities: { execution_contract_version: 2 },
    });
    return { id: String(relay.relay_id), token: String(relay.relay_token) };
  }

  it.each(['codex', 'claude', 'grok'] as const)(
    'empty %s relay poll bypasses a held exclusive flag lock',
    async (engine) => {
      const index = { codex: 0, claude: 1, grok: 2 }[engine];
      const relay = await relayFor(index);
      const connection = await pool.getConnection();
      await connection.beginTransaction();
      await connection.query('SELECT version FROM versions WHERE name=? FOR UPDATE', [
        AGENT_MESSAGING_ENABLED_KEY,
      ]);
      const polling = service.claimForRelay(relay.id, relay.token, randomUUID());
      let returnedBeforeUnlock = false;
      try {
        returnedBeforeUnlock = await Promise.race([
          polling.then((value) => {
            expect(value).toBeNull();
            return true;
          }),
          delay(1500).then(() => false),
        ]);
      } finally {
        await connection.rollback();
        connection.release();
      }
      await polling;
      expect(returnedBeforeUnlock).toBe(true);
    },
  );

  it('idle relay preserves master-off rejection', async () => {
    const relay = await relayFor(1);
    await service.setEnabled(false);
    events.length = 0;
    await expect(service.claimForRelay(relay.id, relay.token, randomUUID())).rejects.toMatchObject({
      code: 'agent_messaging_disabled',
    });
    expect(await currentMessages()).toHaveLength(0);
    expect(events).toHaveLength(0);
  });

  it('queued relay work cannot acquire a lease after disable wins the flag lock', async () => {
    const relay = await relayFor(1);
    await send(0, 1);
    events.length = 0;
    const connection = await pool.getConnection();
    await connection.beginTransaction();
    await connection.query('SELECT version FROM versions WHERE name=? FOR UPDATE', [
      AGENT_MESSAGING_ENABLED_KEY,
    ]);
    const disabling = service.setEnabled(false);
    let polling!: ReturnType<typeof service.claimForRelay>;
    let settled!: Promise<{ value: unknown } | { error: unknown }>;
    try {
      await waitForFlagWaiter();
      polling = service.claimForRelay(relay.id, relay.token, randomUUID());
      settled = polling.then(
        (value) => ({ value }),
        (error) => ({ error }),
      );
      await waitForFlagWaiter(2);
    } finally {
      await connection.rollback();
      connection.release();
    }
    await disabling;
    expect(await settled).toHaveProperty('error.code', 'agent_messaging_disabled');
    const rows = await currentMessages();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'canceled', attempts: 0, leaseOwner: null });
    expect(events).not.toContain('agent_messaging.message.changed');
  });

  it('concurrent relay polls and idempotent sends preserve one lease and replay its receipt', async () => {
    const relay = await relayFor(1);
    const key = randomUUID();
    const [sends, polls] = await Promise.all([
      Promise.all(Array.from({ length: 4 }, () => send(0, 1, key))),
      Promise.all(
        Array.from({ length: 4 }, () => service.claimForRelay(relay.id, relay.token, randomUUID())),
      ),
    ]);
    expect(sends.filter((r) => r.created)).toHaveLength(1);
    const deliveries = polls.filter((r) => r !== null);
    expect(deliveries.length).toBeLessThanOrEqual(1);
    const delivery = deliveries[0] ?? (await service.claimForRelay(relay.id, relay.token, randomUUID()));
    expect(delivery).not.toBeNull();
    if (!delivery) throw new Error('Committed message was not claimable');
    await expect(service.claimForRelay(relay.id, relay.token, delivery.claim_id)).resolves.toMatchObject({
      message_id: delivery.message_id,
      attempts: 1,
    });
    const rows = await currentMessages();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'leased', attempts: 1, claimId: delivery.claim_id });
    expect(events.filter((e) => e === 'agent_messaging.message.changed')).toHaveLength(1);
  });

  it('writers retain the exclusive admission mutex while another writer is admitted', async () => {
    const held = holdOneAdmission(service);
    const first = send(0, 1);
    await held.admitted.promise;
    const second = send(2, 3);
    let completedBeforeRelease = false;
    let finished = false;
    try {
      void second.then(() => {
        finished = true;
      });
      await waitForFlagWaiter();
      completedBeforeRelease = finished;
    } finally {
      held.release.resolve();
    }
    await Promise.all([first, second]);
    expect(completedBeforeRelease).toBe(false);
  });

  it('disable waits for accepted admission, then cancels its exactly-one message', async () => {
    const held = holdOneAdmission(service);
    const sent = send(0, 1);
    await held.admitted.promise;
    let disabled = false;
    const off = service.setEnabled(false).then((r) => {
      disabled = true;
      return r;
    });
    try {
      await waitForFlagWaiter();
      expect(disabled).toBe(false);
    } finally {
      held.release.resolve();
    }
    const [receipt] = await Promise.all([sent, off]);
    const message = receipt.message as { id: string };
    const rows = await db.select().from(agentBusMessages).where(eq(agentBusMessages.id, message.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe('canceled');
    expect(events.filter((e) => e === 'agent_messaging.message.changed')).toHaveLength(1);
  });

  it.each(['codex', 'claude', 'grok'] as const)(
    'committed disable rejects waiting %s admission without message or publication',
    async (engine) => {
      const index = { codex: 0, claude: 1, grok: 2 }[engine];
      const connection = await pool.getConnection();
      await connection.beginTransaction();
      await connection.query('UPDATE versions SET version=? WHERE name=?', [
        '0',
        AGENT_MESSAGING_ENABLED_KEY,
      ]);
      const operation = send(index, 3).then(
        (value) => ({ value }),
        (error) => ({ error }),
      );
      try {
        await waitForFlagWaiter();
        await connection.commit();
      } finally {
        await connection.rollback();
        connection.release();
      }
      const result = await operation;
      expect(result).toHaveProperty('error.code', 'agent_messaging_disabled');
      expect(await currentMessages()).toHaveLength(0);
      expect(events).not.toContain('agent_messaging.message.changed');
    },
  );

  it('a stale precheck cannot publish after the disabling transaction wins admission', async () => {
    const actor = identities[0]!;
    const follower = identities[1]!;
    await service.subscribe(follower.sessionId, follower.token, actor.address);
    events.length = 0;
    const connection = await pool.getConnection();
    await connection.beginTransaction();
    await connection.query('UPDATE versions SET version=? WHERE name=?', ['0', AGENT_MESSAGING_ENABLED_KEY]);
    const published = service
      .publish(actor.sessionId, actor.token, {
        topic: actor.address,
        content: 'must not escape',
        clientMessageId: randomUUID(),
      })
      .then(
        (value) => ({ value }),
        (error) => ({ error }),
      );
    try {
      await waitForFlagWaiter();
      await connection.commit();
    } finally {
      await connection.rollback();
      connection.release();
    }
    expect(await published).toHaveProperty('error.code', 'agent_messaging_disabled');
    const [rows] = await pool.query(
      'SELECT COUNT(*) AS n FROM agent_bus_publications WHERE sender_address_id=?',
      [actor.id],
    );
    expect(Number((rows as Array<{ n: number }>)[0]!.n)).toBe(0);
    expect(await currentMessages()).toHaveLength(0);
    expect(events).toHaveLength(0);
  });

  it('an enabling writer is observed by the subsequent locking admission read', async () => {
    await exec(`UPDATE versions SET version='0' WHERE name='${AGENT_MESSAGING_ENABLED_KEY}'`);
    const connection = await pool.getConnection();
    await connection.beginTransaction();
    await connection.query('UPDATE versions SET version=? WHERE name=?', ['1', AGENT_MESSAGING_ENABLED_KEY]);
    const topic = 'agent:00000000-0000-4000-8000-000000000001';
    const key = randomUUID();
    const publishing = service.publishAdmin({ topic, content: 'enabled and admitted', clientMessageId: key });
    try {
      await waitForFlagWaiter();
      await connection.commit();
    } finally {
      await connection.rollback();
      connection.release();
    }
    expect(await publishing).toHaveProperty('created', true);
    await pool.query('DELETE FROM agent_bus_publications WHERE sender_address_id=? AND client_message_id=?', [
      '00000000-0000-4000-8000-000000000001',
      key,
    ]);
  });

  it('opposite-direction sends complete without a newly exposed address lock deadlock', async () => {
    type AddressSeam = { requireAddressLocked(tx: AgentMessagingDb, id: string): Promise<AgentBusAddress> };
    const seam = service as unknown as AddressSeam;
    const original = seam.requireAddressLocked.bind(service);
    const heldTransactions = new Set<AgentMessagingDb>();
    const release = latch();
    const timer = setTimeout(release.resolve, 1000);
    vi.spyOn(seam, 'requireAddressLocked').mockImplementation(async (tx, id) => {
      const address = await original(tx, id);
      if (!heldTransactions.has(tx)) {
        heldTransactions.add(tx);
        if (heldTransactions.size === 2) release.resolve();
        await release.promise;
      }
      return address;
    });
    try {
      const results = await Promise.allSettled([send(0, 1), send(1, 0)]);
      expect(results.map((result) => result.status)).toEqual(['fulfilled', 'fulfilled']);
      expect(await currentMessages()).toHaveLength(2);
      expect(events.filter((e) => e === 'agent_messaging.message.changed')).toHaveLength(2);
    } finally {
      clearTimeout(timer);
      release.resolve();
    }
  });

  it('concurrent same-key publications create one receipt and one delivery', async () => {
    const actor = identities[0]!;
    const follower = identities[1]!;
    await service.subscribe(follower.sessionId, follower.token, actor.address);
    events.length = 0;
    const key = randomUUID();
    const receipts = await Promise.all(
      Array.from({ length: 4 }, () =>
        service.publish(actor.sessionId, actor.token, {
          topic: actor.address,
          content: 'one publication effect',
          clientMessageId: key,
        }),
      ),
    );
    expect(receipts.filter((r) => r.created)).toHaveLength(1);
    expect(new Set(receipts.map((r) => r.publication_id)).size).toBe(1);
    expect(await currentMessages()).toHaveLength(1);
    expect(events.filter((e) => e === 'agent_messaging.message.changed')).toHaveLength(1);
    const [rows] = await pool.query(
      'SELECT COUNT(*) AS n FROM agent_bus_publications WHERE sender_address_id=? AND client_message_id=?',
      [actor.id, key],
    );
    expect(Number((rows as Array<{ n: number }>)[0]!.n)).toBe(1);
  });

  it('concurrent same-key sends persist and publish exactly once', async () => {
    const key = randomUUID();
    const receipts = await Promise.all(Array.from({ length: 8 }, () => send(0, 1, key)));
    expect(receipts.filter((r) => r.created)).toHaveLength(1);
    expect(new Set(receipts.map((r) => (r.message as { id: string }).id)).size).toBe(1);
    expect(await currentMessages()).toHaveLength(1);
    expect(events.filter((e) => e === 'agent_messaging.message.changed')).toHaveLength(1);
  });
});
