import { createHash, randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import Fastify from 'fastify';
import { registerHostDaemonRoutes } from '../../../src/routes/host-daemon.js';
import { invalidateFleetEngineState } from '../../../src/services/engine-switch.js';
import { beforeAll, afterAll, beforeEach, describe, it, expect, vi } from 'vitest';
import {
  hosts,
  hostDaemons,
  hostDaemonSessions,
  hostDaemonOperations,
  agentSessions,
  agentPrompts,
  agentBusMessages,
  versions,
} from '../../../src/db/schema.js';
import { HostDaemonService } from '../../../src/services/host-daemon/service.js';
import { daemonSettingsSchema } from '../../../src/services/host-daemon/policy.js';
import { getTestDb } from '../../helpers/test-db.js';
import { loadTestEnv, testKeyring } from '../../helpers/test-keyring.js';
const handle = await getTestDb();
describe.skipIf(!handle)('durable host daemon lifecycle', () => {
  let id: number, service: HostDaemonService, generation: string;
  beforeAll(async () => {
    const fqdn = `daemon-${randomUUID()}.test`,
      now = new Date().toISOString();
    await handle!.db.insert(hosts).values({
      fqdn,
      apiKey: 'd'.repeat(64),
      apiKeyHash: createHash('sha256').update('daemon-test-key').digest('hex'),
      reverseDnsMode: 0,
      engines: 'codex,claude,grok',
      secure: 1,
      agentMessagingEnabled: 1,
      authDigest: 'test',
      claudeAuthDigest: 'test',
      grokAuthDigest: 'test',
      status: 'active',
      createdAt: now,
      updatedAt: now,
    });
    id = (await handle!.db.select().from(hosts).where(eq(hosts.fqdn, fqdn)))[0]!.id;
    await handle!.db.execute(
      sql`INSERT INTO versions (name,version,updated_at) VALUES ('agent_messaging_enabled','1',${now}) ON DUPLICATE KEY UPDATE version='1'`,
    );
    service = new HostDaemonService({ db: handle!.db, env: loadTestEnv(), keyring: testKeyring() });
  });
  beforeEach(async () => {
    await handle!.db.delete(hostDaemonSessions).where(eq(hostDaemonSessions.hostId, id));
    await handle!.db.delete(hostDaemons).where(eq(hostDaemons.hostId, id));
    await service.configure(id, daemonSettingsSchema.parse({ enabled: true }));
    generation = (
      await service.connect(id, {
        instance_id: randomUUID(),
        username: 'root',
        version: 'test',
        engines: ['codex', 'claude', 'grok'],
        error: null,
      })
    ).generation;
  });
  afterAll(async () => {
    await handle!.db.delete(hosts).where(eq(hosts.id, id));
    await handle!.pool.end();
  });
  const input = () => ({
    host_id: id,
    engine: 'codex' as const,
    cwd: '/tmp',
    title: 'Remote helper',
    prompt: 'Return hello',
    client_message_id: randomUUID(),
  });
  it('keeps one operation for concurrent retries, rejecting changed input', async () => {
    const request = input();
    const [a, b] = await Promise.all([
      service.start(request, 'agent:owner'),
      service.start(request, 'agent:owner'),
    ]);
    expect(a).toEqual(b);
    await expect(service.start({ ...request, prompt: 'Different' }, 'agent:owner')).rejects.toThrow(
      'Idempotency',
    );
  });
  it('offers repeatedly but never reruns accepted work after reconnect', async () => {
    await service.start(input(), 'agent:owner');
    const first = await service.offer(id, generation);
    expect(first).toBeTruthy();
    expect(await service.offer(id, generation)).toEqual(first);
    await service.accept(id, first!.operation_id, first!.claim_id);
    expect(await service.offer(id, generation)).toBeNull();
    await service.complete(id, first!.operation_id, first!.claim_id, { status: 'unknown', reply: 'crashed' });
    expect((await service.session(first!.session_id)).status).toBe('unknown');
  });
  it('enforces eight running sessions and queues the ninth', async () => {
    for (let i = 0; i < 9; i++) await service.start(input(), 'agent:owner');
    for (let i = 0; i < 8; i++) {
      const op = await service.offer(id, generation);
      expect(op).toBeTruthy();
      await service.accept(id, op!.operation_id, op!.claim_id);
    }
    expect(await service.offer(id, generation)).toBeNull();
    expect((await service.view(id)).health.state).toBe('yellow');
  });
  it('keeps stop pending until the host confirms process exit and replays results safely', async () => {
    const start = await service.start(input(), 'agent:owner');
    const op = (await service.offer(id, generation))!;
    await service.accept(id, op.operation_id, op.claim_id);
    await expect(service.stop(start.session_id, 'agent:stranger')).rejects.toThrow();
    expect((await service.stop(start.session_id, 'agent:owner')).status).toBe('stopping');
    const result = { status: 'stopped' as const, reply: 'Stopped' };
    await service.complete(id, op.operation_id, op.claim_id, result);
    await service.complete(id, op.operation_id, op.claim_id, result);
    expect((await service.session(start.session_id)).status).toBe('closed');
    await expect(
      service.complete(id, op.operation_id, op.claim_id, { ...result, reply: 'different' }),
    ).rejects.toThrow('already stored');
  });
  it('expires idle sessions without counting heartbeats as activity', async () => {
    const start = await service.start(input(), 'agent:owner');
    const op = (await service.offer(id, generation))!;
    await service.accept(id, op.operation_id, op.claim_id);
    await service.complete(id, op.operation_id, op.claim_id, { status: 'completed', reply: 'ok' });
    await handle!.db
      .update(hostDaemonSessions)
      .set({ lastActivityAt: new Date(Date.now() - 3600_001).toISOString() })
      .where(eq(hostDaemonSessions.id, start.session_id));
    await service.heartbeat(id, generation, ['codex'], null);
    expect((await service.session(start.session_id)).status).toBe('closed');
  });
  it('disable cancels pending starts but lets accepted work finish', async () => {
    const first = await service.start(input(), 'agent:owner');
    const op = (await service.offer(id, generation))!;
    await service.accept(id, op.operation_id, op.claim_id);
    const second = await service.start(input(), 'agent:owner');
    await service.configure(id, daemonSettingsSchema.parse({ enabled: false }));
    expect((await service.session(first.session_id)).status).toBe('running');
    expect((await service.session(second.session_id)).status).toBe('closed');
    await service.complete(id, op.operation_id, op.claim_id, { status: 'completed', reply: 'ok' });
    expect((await service.session(first.session_id)).status).toBe('closed');
  });
  it('expires a queued operation after ten minutes', async () => {
    const start = await service.start(input(), 'agent:owner');
    await handle!.db
      .update(hostDaemonOperations)
      .set({ createdAt: new Date(Date.now() - 600_001).toISOString() })
      .where(eq(hostDaemonOperations.id, start.operation_id));
    await service.disconnect(id, generation);
    await service.sweep(id);
    expect((await service.session(start.session_id)).operations[0]!.status).toBe('expired');
  });
  it('fences old sockets without allowing their disconnect to evict the new generation', async () => {
    const original = (await service.settings(id)).runtime!;
    const next = await service.connect(id, original);
    await service.disconnect(id, generation);
    expect((await service.settings(id)).runtime?.connected).toBe(true);
    await expect(service.heartbeat(id, generation, ['codex'], null)).rejects.toThrow('generation');
    expect((await service.settings(id)).runtime?.generation).toBe(next.generation);
    await expect(service.connect(id, { ...original, instance_id: randomUUID() })).rejects.toThrow(
      'Another daemon',
    );
  });
  it('drains durable results after disable and reconnect', async () => {
    const start = await service.start(input(), 'agent:owner');
    const op = (await service.offer(id, generation))!;
    await service.accept(id, op.operation_id, op.claim_id);
    await service.configure(id, daemonSettingsSchema.parse({ enabled: false }));
    await service.disconnect(id, generation);
    const runtime = (await service.settings(id)).runtime!;
    await service.connect(id, runtime);
    await service.complete(id, op.operation_id, op.claim_id, { status: 'completed', reply: 'done' });
    expect((await service.session(start.session_id)).status).toBe('closed');
  });
  it('rejects host messaging disable and expired insecure windows', async () => {
    await handle!.db.update(hosts).set({ agentMessagingEnabled: 0 }).where(eq(hosts.id, id));
    await expect(service.start(input(), 'agent:owner')).rejects.toThrow('available');
    await handle!.db
      .update(hosts)
      .set({ agentMessagingEnabled: 1, secure: 0, insecureEnabledUntil: null })
      .where(eq(hosts.id, id));
    await expect(service.start(input(), 'agent:owner')).rejects.toThrow('available');
    await handle!.db.update(hosts).set({ secure: 1 }).where(eq(hosts.id, id));
  });
  it('preserves open questions for 24 hours and requests an actual stop at the deadline', async () => {
    const start = await service.start(input(), 'agent:owner'),
      op = (await service.offer(id, generation))!;
    await service.accept(id, op.operation_id, op.claim_id);
    const native = randomUUID(),
      promptId = randomUUID(),
      stamp = new Date().toISOString();
    await handle!.db.insert(agentSessions).values({
      id: native,
      hostId: id,
      engine: 'codex',
      username: 'root',
      cwd: '/tmp',
      invocationKind: 'execute',
      hostAuthFingerprint: 'a'.repeat(64),
      bridgeTokenHash: 'b'.repeat(64),
      bridgeExpiresAt: stamp,
      startedAt: stamp,
      heartbeatAt: stamp,
      createdAt: stamp,
      updatedAt: stamp,
    });
    try {
      await handle!.db
        .update(hostDaemonSessions)
        .set({ sessionId: native })
        .where(eq(hostDaemonSessions.id, start.session_id));
      await handle!.db.insert(agentPrompts).values({
        id: promptId,
        sessionId: native,
        questionEnc: 'test-question',
        status: 'open',
        createdAt: new Date(Date.now() - 2 * 3600_000).toISOString(),
      });
      await service.sweep(id);
      expect((await service.session(start.session_id)).status).toBe('running');
      await handle!.db
        .update(agentPrompts)
        .set({ createdAt: new Date(Date.now() - 86400_001).toISOString() })
        .where(eq(agentPrompts.id, promptId));
      await service.sweep(id);
      expect((await service.session(start.session_id)).status).toBe('stopping');
    } finally {
      await handle!.db.delete(agentPrompts).where(eq(agentPrompts.id, promptId));
      await handle!.db.delete(agentSessions).where(eq(agentSessions.id, native));
    }
  });
  it('rejects all three suspended fleet engines before launching', async () => {
    for (const engine of ['codex', 'claude', 'grok'] as const) {
      const name = engine + '_engine_disabled';
      await handle!.db
        .insert(versions)
        .values({ name, version: '1', updatedAt: new Date().toISOString() })
        .onDuplicateKeyUpdate({ set: { version: '1' } });
      invalidateFleetEngineState(handle!.db);
      try {
        await expect(service.start({ ...input(), engine }, 'agent:owner')).rejects.toThrow();
      } finally {
        await handle!.db.delete(versions).where(eq(versions.name, name));
        invalidateFleetEngineState(handle!.db);
      }
    }
  });
  it('authenticates a live websocket, delivers durable work and closes on the kill switch', async () => {
    await service.disconnect(id, generation);
    const app = Fastify();
    app.decorate('requireAdmin', async () => {});
    await registerHostDaemonRoutes(app, { db: handle!.db, env: loadTestEnv(), keyring: testKeyring() });
    await app.ready();
    const frames: Array<{
      id?: string;
      type?: string;
      error?: string;
      result?: unknown;
      operation?: { operation_id: string; claim_id: string };
    }> = [];
    let socket: Awaited<ReturnType<typeof app.injectWS>> | undefined;
    try {
      await expect(app.injectWS('/host/daemon/connect')).rejects.toThrow();
      socket = await app.injectWS(
        '/host/daemon/connect',
        { headers: { 'x-api-key': 'daemon-test-key' } },
        { onInit: (ws) => ws.on('message', (raw: Buffer) => frames.push(JSON.parse(raw.toString()))) },
      );
      const rpc = async (type: string, payload: unknown) => {
        const frameId = randomUUID();
        socket!.send(JSON.stringify({ id: frameId, type, payload }));
        await vi.waitFor(() => expect(frames.some((f) => f.id === frameId)).toBe(true), { timeout: 5000 });
        const frame = frames.find((f) => f.id === frameId)!;
        expect(frame.error).toBeUndefined();
        return frame.result;
      };
      await rpc('hello', {
        instance_id: randomUUID(),
        username: 'root',
        version: 'test',
        engines: ['codex'],
        error: null,
      });
      const start = await service.start(input(), 'agent:owner');
      await vi.waitFor(() => expect(frames.some((f) => f.type === 'operation')).toBe(true), {
        timeout: 5000,
      });
      const op = frames.find((f) => f.type === 'operation')!.operation!;
      await rpc('accept', { operation_id: op.operation_id, claim_id: op.claim_id });
      await rpc('complete', {
        operation_id: op.operation_id,
        claim_id: op.claim_id,
        result: { status: 'completed', reply: 'hello' },
      });
      expect((await service.session(start.session_id)).status).toBe('idle');
      await handle!.db
        .insert(versions)
        .values({ name: 'api_disabled', version: '1', updatedAt: new Date().toISOString() })
        .onDuplicateKeyUpdate({ set: { version: '1' } });
      socket.send(JSON.stringify({ id: randomUUID(), type: 'heartbeat', payload: { engines: ['codex'] } }));
      await vi.waitFor(() => expect(socket!.readyState).toBe(3));
    } finally {
      socket?.terminate();
      await app.close();
      await handle!.db.delete(versions).where(eq(versions.name, 'api_disabled'));
    }
  });
  it('does not let an old peer receipt release a newer running turn', async () => {
    const start = await service.start(input(), 'agent:owner'),
      address = randomUUID(),
      message = randomUUID(),
      stamp = new Date().toISOString();
    await handle!.db
      .update(hostDaemonSessions)
      .set({ status: 'running', addressId: address, activeMessageId: message })
      .where(eq(hostDaemonSessions.id, start.session_id));
    await handle!.db
      .insert(agentBusMessages)
      .values({
        id: message,
        conversationId: randomUUID(),
        sequence: 1,
        senderAddressId: randomUUID(),
        targetAddressId: address,
        sourceEngine: 'codex',
        targetEngine: 'codex',
        contentEnc: 'fixture',
        contentBytes: 7,
        clientMessageId: randomUUID(),
        status: 'completed',
        nextAttemptAt: stamp,
        expiresAt: stamp,
        createdAt: stamp,
        updatedAt: stamp,
      });
    try {
      await service.peerFinished(id, start.session_id, message);
      expect((await service.session(start.session_id)).status).toBe('idle');
      const newer = randomUUID();
      await handle!.db
        .update(hostDaemonSessions)
        .set({ status: 'running', activeMessageId: newer })
        .where(eq(hostDaemonSessions.id, start.session_id));
      await service.peerFinished(id, start.session_id, message);
      const current = await service.session(start.session_id);
      expect(current.status).toBe('running');
      expect(current.activeMessageId).toBe(newer);
    } finally {
      await handle!.db.delete(agentBusMessages).where(eq(agentBusMessages.id, message));
    }
  });
});
