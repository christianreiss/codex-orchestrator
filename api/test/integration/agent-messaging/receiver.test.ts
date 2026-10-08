import { randomUUID, randomBytes } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { agentSessions, hosts } from '../../../src/db/schema.js';
import { AgentReceiverService } from '../../../src/services/agent-receiver.js';
import { AgentPortalService } from '../../../src/services/agent-portal.js';
import { AgentMessagingService } from '../../../src/services/agent-messaging.js';
import { invalidateFleetEngineState } from '../../../src/services/engine-switch.js';
import { receiverState } from '../../../src/services/agent-receiver-state.js';
import { getTestDb } from '../../helpers/test-db.js';
import { loadTestEnv, testKeyring } from '../../helpers/test-keyring.js';

const handle = await getTestDb();
afterAll(async () => { await handle?.pool.end(); });

const engines = [
  { engine: 'codex', protocol: 'codex-queue-v1' },
  { engine: 'claude', protocol: 'claude-channel-v1' },
  { engine: 'grok', protocol: 'grok-acp-v1' },
] as const;

describe.skipIf(!handle).each(engines)('$engine receiver connection health and fencing', ({ engine, protocol }) => {
  let host: typeof hosts.$inferSelect;
  let receiver: AgentReceiverService;
  let messaging: AgentMessagingService;
  const id = randomUUID(),
    token = randomBytes(32).toString('base64url');
  const generation = randomUUID();
  beforeAll(async () => {
    const db = handle!.db,
      now = new Date().toISOString();
    await db.insert(hosts).values({
      fqdn: `receiver-${id}.test`,
      apiKey: 'd'.repeat(64),
      engines: 'codex,claude,grok',
      status: 'active',
      secure: 1,
      createdAt: now,
      updatedAt: now,
    });
    host = (
      await db
        .select()
        .from(hosts)
        .where(eq(hosts.fqdn, `receiver-${id}.test`))
    )[0]!;
    await db.execute(
      sql`INSERT INTO versions (name, version, updated_at) VALUES ('agent_messaging_enabled', '1', ${now}), ('agent_portal_enabled', '0', ${now}) ON DUPLICATE KEY UPDATE version=VALUES(version)`,
    );
    const env = loadTestEnv();
    messaging = new AgentMessagingService(db, env, testKeyring());
    receiver = new AgentReceiverService(db, env, testKeyring());
    await messaging.registerSession(host, {
      sessionId: id,
      bridgeToken: token,
      engine,
      username: 'receiver-test',
      cwd: '/tmp/receiver-test',
      invocationKind: 'interactive',
    });
  });
  afterAll(async () => {
    const db = handle!.db;
    if (host) {
      await db.execute(sql`DELETE FROM agent_sessions WHERE host_id=${host.id}`);
      await db.execute(sql`DELETE FROM agent_bus_addresses WHERE host_id=${host.id}`);
      await db.delete(hosts).where(eq(hosts.id, host.id));
    }
    await db.execute(
      sql`UPDATE versions SET version='0' WHERE name IN ('agent_messaging_enabled','agent_portal_enabled')`,
    );
  });
  it('needs no probe, preserves health on normal heartbeat, and fences replacement', async () => {
    const input = { generation, protocol, native_session_id: randomUUID() };
    expect((await receiver.register(id, token, input)).receiver?.state).toBe('ready');
    await expect(receiver.register(id, token, { ...input, generation: randomUUID() })).rejects.toMatchObject({
      code: 'receiver_owned',
    });
    await expect(
      receiver.update(id, token, generation, 'ack', { source: 'peer', nonce: randomUUID() }),
    ).rejects.toMatchObject({ code: 'receiver_probe_mismatch' });
    expect(await receiver.claim(id, token, generation, 'peer', randomUUID())).toEqual({ delivery: null });
    await receiver.update(id, token, generation, 'heartbeat', {});
    const before = (await handle!.db.select().from(agentSessions).where(eq(agentSessions.id, id)))[0]!;
    await messaging.heartbeatSession(id, token, {});
    const after = (await handle!.db.select().from(agentSessions).where(eq(agentSessions.id, id)))[0]!;
    expect(after.receiveHeartbeatAt).toBe(before.receiveHeartbeatAt);
    await receiver.retry(id);
    await expect(receiver.update(id, token, generation, 'heartbeat', {})).rejects.toMatchObject({
      code: 'receiver_generation_changed',
    });
    expect((await receiver.register(id, token, { ...input, generation: randomUUID() })).receiver?.state).toBe(
      'ready',
    );
  });
  it('registers without a wrapper launcher and binds actual native identity', async () => {
    const nativeId = randomUUID();
    const connectionGeneration = randomUUID();
    const [previous] = await handle!.db.select().from(agentSessions).where(eq(agentSessions.id, id));
    await receiver.update(id, token, receiverState(previous!.receiver)!.generation, 'stop', {});
    const input = { generation: connectionGeneration, protocol, native_session_id: nativeId };
    const registered = await receiver.register(id, token, input);
    expect(await receiver.register(id, token, input)).toEqual(registered);
    const [session] = await handle!.db.select().from(agentSessions).where(eq(agentSessions.id, id));
    expect(session!.upstreamSessionId).toBe(nativeId);
    expect(session!.engine).toBe(engine);
    const mismatch = engine === 'codex' ? 'claude-channel-v1' : 'codex-queue-v1';
    await expect(receiver.register(id, token, { ...input, protocol: mismatch })).rejects.toMatchObject({ code: 'receiver_engine_mismatch' });
  });

  it('accepts a matching legacy receipt without changing any health or probe state', async () => {
    const [session] = await handle!.db.select().from(agentSessions).where(eq(agentSessions.id, id));
    const s = receiverState(session!.receiver)!;
    const nonce = randomUUID();
    s.probes.peer = {
      id: randomUUID(),
      nonce,
      delivered_at: new Date(Date.now() - 180_000).toISOString(),
      acknowledged_at: null,
    };
    await handle!.db.update(agentSessions).set({ receiver: s }).where(eq(agentSessions.id, id));
    expect(await receiver.claim(id, token, s.generation, 'peer', randomUUID())).toEqual({ delivery: null });
    await receiver.update(id, token, s.generation, 'ack', { source: 'peer', nonce });
    const [after] = await handle!.db.select().from(agentSessions).where(eq(agentSessions.id, id));
    expect(after!.receiver).toEqual(s);
    expect(after!.receiveHeartbeatAt).toBe(session!.receiveHeartbeatAt);
  });
  it('cannot revive an expired receiver with wrapper or receiver heartbeats', async () => {
    const [session] = await handle!.db.select().from(agentSessions).where(eq(agentSessions.id, id));
    const s = receiverState(session!.receiver)!;
    s.heartbeat_at = new Date(Date.now() - 60_000).toISOString();
    await handle!.db.update(agentSessions).set({ receiver: s }).where(eq(agentSessions.id, id));
    await messaging.heartbeatSession(id, token, {});
    expect((await receiver.status(id, token)).receiver?.state).toBe('unavailable');
    await expect(receiver.update(id, token, s.generation, 'heartbeat', {})).rejects.toMatchObject({
      code: 'receiver_expired',
    });
    await expect(
      receiver.update(id, token, s.generation, 'ack', { source: 'peer', nonce: s.probes.peer!.nonce }),
    ).rejects.toMatchObject({ code: 'receiver_expired' });
    await expect(receiver.status(id, 'wrong')).rejects.toThrow();
  });
  it('enables both sources without probes and fences ordinary queue claims', async () => {
    await handle!.db.execute(sql`UPDATE versions SET version='1' WHERE name='agent_portal_enabled'`);
    const next = randomUUID();
    const result = await receiver.register(id, token, {
      generation: next,
      protocol,
      native_session_id: randomUUID(),
    });
    expect(result.sources).toEqual(['peer', 'portal']);
    expect(result.receiver?.state).toBe('ready');
    for (const source of ['peer', 'portal'] as const) {
      expect(result.receiver?.sources.find((p) => p.source === source)?.state).toBe('ready');
    }
    expect(await receiver.claim(id, token, next, 'peer', randomUUID())).toEqual({ delivery: null });
    expect(await receiver.claim(id, token, next, 'portal', randomUUID())).toEqual({ message: null });
    await expect(messaging.claimForSession(id, token, randomUUID(), randomUUID())).rejects.toMatchObject({
      code: 'receiver_generation_changed',
    });
    const portal = new AgentPortalService(handle!.db, loadTestEnv(), testKeyring());
    await expect(portal.claimMessage(id, token, randomUUID(), undefined, randomUUID())).rejects.toMatchObject(
      { code: 'receiver_generation_changed' },
    );
    await portal.heartbeatAgent(id, token, { relayAction: 'close' });
    await receiver.update(id, token, next, 'heartbeat', {});
    const closed = (await receiver.status(id, token)).receiver!;
    expect(closed.sources.map((p) => p.source)).toEqual(['peer']);
    expect(closed.sources[0]?.state).toBe('ready');
    await handle!.db.execute(sql`UPDATE versions SET version='0' WHERE name='agent_portal_enabled'`);
    await expect(receiver.claim(id, token, next, 'portal', randomUUID())).rejects.toThrow();
    expect(await receiver.claim(id, token, next, 'peer', randomUUID())).toEqual({ delivery: null });
  });
  it('rechecks host, engine and scoped bridge policy independently of launch method', async () => {
    const db = handle!.db;
    const [session] = await db.select().from(agentSessions).where(eq(agentSessions.id, id));
    await expect(receiver.status(id, randomBytes(32).toString('base64url'))).rejects.toMatchObject({ code: 'agent_bridge_unauthorized' });
    await db.update(agentSessions).set({ bridgeExpiresAt: new Date(Date.now() - 60_000).toISOString() }).where(eq(agentSessions.id, id));
    await expect(receiver.status(id, token)).rejects.toMatchObject({ code: 'agent_bridge_expired' });
    await db.update(agentSessions).set({ bridgeExpiresAt: session!.bridgeExpiresAt }).where(eq(agentSessions.id, id));
    await db.update(hosts).set({ engines: engines.filter((item) => item.engine !== engine).map((item) => item.engine).join(',') }).where(eq(hosts.id, host.id));
    await expect(receiver.status(id, token)).rejects.toMatchObject({ code: 'engine_disabled' });
    await db.update(hosts).set({ engines: host.engines }).where(eq(hosts.id, host.id));
    const flag = `${engine}_engine_disabled`;
    await db.execute(sql`INSERT INTO versions (name, version, updated_at) VALUES (${flag}, '1', ${new Date().toISOString()}) ON DUPLICATE KEY UPDATE version='1'`);
    invalidateFleetEngineState(db);
    await expect(receiver.status(id, token)).rejects.toMatchObject({ code: 'engine_disabled' });
    await db.execute(sql`UPDATE versions SET version='0' WHERE name=${flag}`);
    invalidateFleetEngineState(db);
    await db.update(hosts).set({ secure: 0, insecureEnabledUntil: null }).where(eq(hosts.id, host.id));
    await expect(receiver.status(id, token)).rejects.toMatchObject({ code: 'agent_messaging_insecure_window_closed' });
    await db.update(hosts).set({ secure: 1 }).where(eq(hosts.id, host.id));
    await db.execute(sql`UPDATE versions SET version='0' WHERE name='agent_messaging_enabled'`);
    await expect(receiver.claim(id, token, randomUUID(), 'peer', randomUUID())).rejects.toMatchObject({ code: 'agent_messaging_disabled' });
    await db.execute(sql`UPDATE versions SET version='1' WHERE name='agent_messaging_enabled'`);
  });

});
