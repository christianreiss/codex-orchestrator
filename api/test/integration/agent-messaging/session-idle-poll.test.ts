import { randomBytes, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import mysql from 'mysql2/promise';
import { drizzle } from 'drizzle-orm/mysql2';
import { and, eq, inArray, or } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as schema from '../../../src/db/schema.js';
import { AgentMessagingService, AGENT_MESSAGING_ENABLED_KEY } from '../../../src/services/agent-messaging.js';
import { AgentReceiverService } from '../../../src/services/agent-receiver.js';
import { invalidateFleetEngineState } from '../../../src/services/engine-switch.js';
import { receiverState } from '../../../src/services/agent-receiver-state.js';
import { ENGINES, type Engine } from '../../../src/util/engine.js';
import { readDbConfig } from '../../helpers/test-db.js';
import { loadTestEnv, testKeyring } from '../../helpers/test-keyring.js';

const config = readDbConfig();
const protocols = { codex: 'codex-queue-v1', claude: 'claude-channel-v1', grok: 'grok-acp-v1' } as const;

describe.skipIf(!config)('session idle polls preserve admission on real MySQL', { timeout: 30_000 }, () => {
  const pool = mysql.createPool({ ...config, connectionLimit: 2 });
  const db = drizzle(pool, { schema, mode: 'default' });
  const env = loadTestEnv();
  const service = new AgentMessagingService(db, env, testKeyring());
  const receiver = new AgentReceiverService(db, env, testKeyring());
  let host: typeof schema.hosts.$inferSelect;
  const prior = new Map<string, string | undefined>();
  const flagNames = [AGENT_MESSAGING_ENABLED_KEY, ...ENGINES.map(e => `${e}_engine_disabled`)];

  async function flag(name: string, value: string) {
    await db.insert(schema.versions).values({ name, version: value, updatedAt: new Date().toISOString() }).onDuplicateKeyUpdate({ set: { version: value } });
    invalidateFleetEngineState(db);
  }
  beforeAll(async () => {
    for (const name of flagNames) prior.set(name, (await db.select().from(schema.versions).where(eq(schema.versions.name, name)))[0]?.version ?? undefined);
    const fqdn = `session-idle-${randomUUID()}.test`, now = new Date().toISOString();
    await db.insert(schema.hosts).values({ fqdn, apiKey: randomBytes(32).toString('hex'), status: 'active', secure: 1, engines: ENGINES.join(','), createdAt: now, updatedAt: now });
    host = (await db.select().from(schema.hosts).where(eq(schema.hosts.fqdn, fqdn)))[0]!;
  });
  beforeEach(async () => {
    await flag(AGENT_MESSAGING_ENABLED_KEY, '1');
    for (const engine of ENGINES) await flag(`${engine}_engine_disabled`, '0');
    await db.update(schema.hosts).set({ status: 'active' }).where(eq(schema.hosts.id, host.id));
  });
  afterAll(async () => {
    vi.restoreAllMocks();
    if (host) {
      const addresses = await db.select().from(schema.agentBusAddresses).where(eq(schema.agentBusAddresses.hostId, host.id));
      const ids = addresses.map(a => a.id);
      if (ids.length) {
        await db.delete(schema.agentBusMessages).where(or(inArray(schema.agentBusMessages.targetAddressId, ids), inArray(schema.agentBusMessages.senderAddressId, ids)));
        await db.delete(schema.agentBusConversations).where(or(inArray(schema.agentBusConversations.addressAId, ids), inArray(schema.agentBusConversations.addressBId, ids)));
      }
      await db.delete(schema.agentSessions).where(eq(schema.agentSessions.hostId, host.id));
      await db.delete(schema.agentBusAddresses).where(eq(schema.agentBusAddresses.hostId, host.id));
      await db.delete(schema.logs).where(eq(schema.logs.hostId, host.id));
      await db.delete(schema.hosts).where(eq(schema.hosts.id, host.id));
    }
    for (const [name, value] of prior) {
      if (value === undefined) await db.delete(schema.versions).where(eq(schema.versions.name, name));
      else await flag(name, value);
    }
    await pool.end();
  });

  async function peer(engine: Engine = 'codex') {
    const id = randomUUID(), token = randomBytes(32).toString('base64url'), generation = randomUUID(), native = randomUUID();
    const result = await service.registerSession(host, { engine, username: randomUUID(), cwd: '/tmp/session-idle', invocationKind: 'interactive', sessionId: id, bridgeToken: token, upstreamSessionId: native, adapterCapabilities: { execution_contract_version: 2 } });
    const address = result.address as { id: string; address: string };
    await receiver.register(id, token, { generation, protocol: protocols[engine], native_session_id: native });
    return { id, token, generation, address: address.address, addressId: address.id };
  }
  async function holdGate(hostToo = false) {
    const connection = await mysql.createConnection({ ...config });
    await connection.beginTransaction();
    await connection.query('SELECT version FROM versions WHERE name = ? FOR UPDATE', [AGENT_MESSAGING_ENABLED_KEY]);
    if (hostToo) await connection.query('SELECT id FROM hosts WHERE id = ? FOR UPDATE', [host.id]);
    return async () => { await connection.rollback(); await connection.end(); };
  }
  async function within<T>(operation: Promise<T>, ms = 1200) {
    return Promise.race([operation.then(value => ({ value }), error => ({ error })), delay(ms).then(() => 'pending' as const)]);
  }
  async function send(source: Awaited<ReturnType<typeof peer>>, target: Awaited<ReturnType<typeof peer>>) {
    return await service.sendMessage(source.id, source.token, { to: target.address, content: 'fixture', clientMessageId: randomUUID() }) as { message: { id: string } };
  }

  for (const engine of ENGINES) {
    it(`${engine}: empty receiver polls and presence checks bypass held flag/host locks`, async () => {
      const target = await peer(engine), release = await holdGate(true);
      try {
        const polls = Array.from({ length: 6 }, () => within(receiver.claim(target.id, target.token, target.generation, 'peer', randomUUID())));
        for (const result of await Promise.all(polls)) expect(result).toEqual({ value: { delivery: null } });
        expect(await within(db.select({ id: schema.hosts.id }).from(schema.hosts).limit(1))).not.toBe('pending');
      } finally { await release(); }
    });
    it(`${engine}: stale receiver generation still fails on an empty queue`, async () => {
      const target = await peer(engine);
      await expect(service.claimForSession(target.id, target.token, randomUUID(), randomUUID())).rejects.toMatchObject({ code: 'receiver_generation_changed' });
    });
  }

  it('retains invalid claim-ID, token, stale heartbeat and disabled binding errors', async () => {
    const target = await peer();
    await expect(service.claimForSession(target.id, target.token, 'invalid', target.generation)).rejects.toMatchObject({ status: 422 });
    await expect(service.claimForSession(target.id, 'wrong', randomUUID(), target.generation)).rejects.toMatchObject({ code: 'agent_bridge_unauthorized' });
    await db.update(schema.agentSessions).set({ receiveHeartbeatAt: '2000-01-01T00:00:00Z' }).where(eq(schema.agentSessions.id, target.id));
    await expect(service.claimForSession(target.id, target.token, randomUUID(), target.generation)).rejects.toMatchObject({ code: 'agent_messaging_adapter_unavailable' });
    await db.update(schema.agentSessions).set({ receiveHeartbeatAt: new Date().toISOString() }).where(eq(schema.agentSessions.id, target.id));
    await db.update(schema.agentBusAddresses).set({ enabled: 0 }).where(eq(schema.agentBusAddresses.id, target.addressId));
    await expect(service.claimForSession(target.id, target.token, randomUUID(), target.generation)).rejects.toMatchObject({ code: 'agent_messaging_binding_stale' });
  });

  it('keeps disabled fleet/host gates for empty polls', async () => {
    const target = await peer();
    await flag(AGENT_MESSAGING_ENABLED_KEY, '0');
    await expect(service.claimForSession(target.id, target.token, randomUUID(), target.generation)).rejects.toMatchObject({ code: 'agent_messaging_disabled' });
    await flag(AGENT_MESSAGING_ENABLED_KEY, '1');
    await flag('codex_engine_disabled', '1');
    await expect(service.claimForSession(target.id, target.token, randomUUID(), target.generation)).rejects.toMatchObject({ code: 'engine_disabled' });
    await flag('codex_engine_disabled', '0');
    await db.update(schema.hosts).set({ status: 'disabled' }).where(eq(schema.hosts.id, host.id));
    await expect(service.claimForSession(target.id, target.token, randomUUID(), target.generation)).rejects.toMatchObject({ code: 'agent_messaging_host_ineligible' });
  });

  for (const expired of [false, true]) {
    it(`pending ${expired ? 'expired' : 'queued'} rows retain the locked path`, async () => {
      const source = await peer(), target = await peer(), sent = await send(source, target);
      if (expired) await db.update(schema.agentBusMessages).set({ expiresAt: '2000-01-01T00:00:00Z' }).where(eq(schema.agentBusMessages.id, sent.message.id));
      const release = await holdGate();
      const operation = service.claimForSession(target.id, target.token, randomUUID(), target.generation);
      try { expect(await within(operation, 150)).toBe('pending'); } finally { await release(); }
      const result = await operation;
      if (expired) {
        expect(result).toBeNull();
        expect((await db.select().from(schema.agentBusMessages).where(eq(schema.agentBusMessages.id, sent.message.id)))[0]?.status).toBe('expired');
      } else expect(result?.message_id).toBe(sent.message.id);
    });
  }

  it('presence-return with waiting mail still waits and creates its notice', async () => {
    const source = await peer(), target = await peer(), sent = await send(source, target);
    await db.update(schema.agentBusMessages).set({ awaitingPresence: 1 }).where(eq(schema.agentBusMessages.id, sent.message.id));
    const release = await holdGate();
    const operation = service.notifyPresenceReturn(target.id);
    try { expect(await within(operation, 150)).toBe('pending'); } finally { await release(); }
    await operation;
    expect(await db.select().from(schema.agentBusMessages).where(and(eq(schema.agentBusMessages.targetAddressId, source.addressId), eq(schema.agentBusMessages.kind, 'presence_notice')))).toHaveLength(1);
    expect((await db.select().from(schema.agentBusMessages).where(eq(schema.agentBusMessages.id, sent.message.id)))[0]?.awaitingPresence).toBe(0);
  });

  for (const mutation of ['receiver', 'disable'] as const) {
    it(`does not combine old admission with an empty queue after ${mutation}`, async () => {
      const source = await peer(), target = await peer(), sent = await send(source, target);
      const authenticate = service.authenticateBridge.bind(service);
      const spy = vi.spyOn(service, 'authenticateBridge').mockImplementationOnce(async (...args) => {
        const previous = await authenticate(...args);
        await db.transaction(async tx => {
          await tx.update(schema.agentBusMessages).set({ status: 'completed' }).where(eq(schema.agentBusMessages.id, sent.message.id));
          if (mutation === 'receiver') {
            const state = receiverState(previous.session.receiver)!;
            await tx.update(schema.agentSessions).set({ receiver: { ...state, generation: randomUUID() } }).where(eq(schema.agentSessions.id, target.id));
          } else await tx.update(schema.versions).set({ version: '0' }).where(eq(schema.versions.name, AGENT_MESSAGING_ENABLED_KEY));
        });
        return previous;
      });
      try {
        await expect(service.claimForSession(target.id, target.token, randomUUID(), target.generation)).rejects.toMatchObject({ code: mutation === 'receiver' ? 'receiver_generation_changed' : 'agent_messaging_disabled' });
      } finally { spy.mockRestore(); }
    });
  }
});
