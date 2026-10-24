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
import { InsecureWindowAdminService } from '../../../src/services/insecure-window-admin.js';
import { makeAdminEventsWriter } from '../../../src/services/admin-events-writer.js';
import { daemonSettingsSchema } from '../../../src/services/host-daemon/policy.js';
import { getTestDb } from '../../helpers/test-db.js';
import { loadTestEnv, testKeyring } from '../../helpers/test-keyring.js';
import { wsPublisher } from '../../../src/ws/publisher.js';
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
    await handle!.db.update(hosts).set({ secure: 1, insecureSessionRenewalBlocked: 0 }).where(eq(hosts.id, id));
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
  it('checkpoints unchanged secure daemon beats without a transaction or retention scan', async () => {
    const connection = vi.spyOn(handle!.pool, 'getConnection');
    const sweep = vi.spyOn(service, 'sweep');
    try {
      const result = await service.heartbeat(id, generation, ['codex', 'claude', 'grok'], null);
      expect(result).toMatchObject({ settings: { enabled: true }, stop: [] });
      expect(connection).not.toHaveBeenCalled();
      expect(sweep).not.toHaveBeenCalled();
      const runtime = (await service.settings(id)).runtime;
      expect(runtime?.generation).toBe(generation);
      expect(Date.now() - Date.parse(runtime!.heartbeat_at)).toBeLessThan(2000);
      await expect(service.heartbeat(id, randomUUID(), ['codex'], null)).rejects.toThrow('generation changed');
      expect((await service.settings(id)).runtime?.generation).toBe(generation);
    } finally { connection.mockRestore(); sweep.mockRestore(); }
  });
  it('peeks an empty offer without a transaction and wakes only after queued work commits', async () => {
    const connection = vi.spyOn(handle!.pool, 'getConnection');
    try {
      expect(await service.hasPendingOffer(id)).toBe(false);
      expect(connection).not.toHaveBeenCalled();
    } finally { connection.mockRestore(); }
    const observed: Promise<boolean>[] = [];
    const unsubscribe = wsPublisher.subscribe(({ type, payload }) => {
      if (type === 'host.daemon.operation.queued' && (payload as { host_id: number }).host_id === id)
        observed.push(service.hasPendingOffer(id));
    });
    try {
      const started = await service.start(input(), 'agent:owner');
      expect(await Promise.all(observed)).toEqual([true]);
      expect(await service.offer(id, generation)).toMatchObject({ operation_id: started.operation_id });
    } finally { unsubscribe(); }
  });

  it('revalidates a replacement generation arriving before the heartbeat write', async () => {
    const query = handle!.pool.query.bind(handle!.pool);
    const hook = vi.spyOn(handle!.pool, 'query');
    const replacement = randomUUID();
    let changed = false;
    hook.mockImplementation(async (options, values) => {
      const text = typeof options === 'string' ? options : options.sql;
      if (text.startsWith('UPDATE `hosts`') && text.includes('JSON_SET')) {
        hook.mockRestore();
        changed = true;
        const runtime = (await service.settings(id)).runtime!;
        await handle!.db.update(hostDaemons).set({ runtime: { ...runtime, generation: replacement } })
          .where(eq(hostDaemons.hostId, id));
      }
      return query(options, values);
    });
    try {
      await expect(service.heartbeat(id, generation, ['codex', 'claude', 'grok'], null))
        .rejects.toThrow('generation changed');
      expect(changed).toBe(true);
      expect((await service.settings(id)).runtime?.generation).toBe(replacement);
    } finally { hook.mockRestore(); }
  });

  it.each([false, true])('takes the host lock before the daemon checkpoint and rechecks replacement=%s', async (replace) => {
    const parent = await handle!.pool.getConnection();
    const query = handle!.pool.query.bind(handle!.pool);
    let issued!: () => void;
    const writing = new Promise<void>(resolve => { issued = resolve; });
    const hook = vi.spyOn(handle!.pool, 'query').mockImplementation((options, values) => {
      const text = typeof options === 'string' ? options : options.sql;
      if (/^update /i.test(text) && text.includes('JSON_SET')) issued();
      return query(options, values);
    });
    let beat: Promise<unknown> | undefined;
    try {
      await parent.beginTransaction();
      await parent.query('SELECT id FROM hosts WHERE id = ? FOR UPDATE', [id]);
      beat = service.heartbeat(id, generation, ['codex', 'claude', 'grok'], null);
      void beat.catch(() => {});
      await writing;
      await new Promise(resolve => setTimeout(resolve, 100));
      // A child-first UPDATE with EXISTS(host) deadlocks this lock request.
      await parent.query('SELECT host_id FROM host_daemons WHERE host_id = ? FOR UPDATE', [id]);
      if (replace) {
        await parent.query("UPDATE host_daemons SET runtime = JSON_SET(runtime, '$.generation', ?) WHERE host_id = ?", [randomUUID(), id]);
        await parent.commit();
        await expect(beat).rejects.toThrow('generation changed');
      } else {
        await parent.rollback();
        await expect(beat).resolves.toMatchObject({ stop: [] });
      }
    } finally { hook.mockRestore(); await parent.rollback(); parent.release(); await beat?.catch(() => {}); }
  });
  it('upserts enablement while preserving existing daemon settings', async () => {
    const custom = daemonSettingsSchema.parse({ enabled: true, username: 'worker', default_cwd: '/srv/work', max_parallel: 3, idle_minutes: 25, question_minutes: 120 });
    await service.configure(id, custom);
    const enabledAt = (await service.settings(id)).enabledAt;
    await service.configureEnabled(id, true);
    expect((await service.settings(id)).enabledAt).toBe(enabledAt);
    await service.configureEnabled(id, false);
    expect((await service.settings(id)).settings).toEqual({ ...custom, resident_enabled: false, enabled: false });
    expect((await service.settings(id)).enabledAt).toBeNull();
    await service.configureEnabled(id, true);
    expect((await service.settings(id)).settings).toEqual({ ...custom, resident_enabled: false });
    expect((await service.settings(id)).enabledAt).not.toBeNull();
  });
  it('serializes heartbeat renewal with daemon configuration without lock inversion', async () => {
    await handle!.db.update(hosts).set({ secure: 0, insecureEnabledUntil: new Date(Date.now() + 60_000), insecureWindowMinutes: 10 }).where(eq(hosts.id, id));
    const start = await service.start(input(), 'agent:owner');
    const op = (await service.offer(id, generation))!;
    await service.accept(id, op.operation_id, op.claim_id);
    for (let i = 0; i < 4; i++) {
      await Promise.all([
        service.heartbeat(id, generation, ['codex', 'claude', 'grok'], null, [start.session_id]),
        service.configureEnabled(id, true),
      ]);
    }
    expect((await service.session(start.session_id)).status).toBe('running');
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
    // Heartbeats are transport liveness, not retention jobs. The route's
    // shared 60 s sweep owns idle deadlines and does not count beats as work.
    expect((await service.session(start.session_id)).status).toBe('idle');
    await service.sweep(id);
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
  it('honors fleet messaging policy and expired insecure windows', async () => {
    await handle!.db.update(hosts).set({ agentMessagingEnabled: 0 }).where(eq(hosts.id, id));
    await expect(service.start(input(), 'agent:owner')).resolves.toHaveProperty('session_id');
    await handle!.db.update(versions).set({ version: '0' }).where(eq(versions.name, 'agent_messaging_enabled'));
    await expect(service.start(input(), 'agent:owner')).rejects.toThrow('disabled');
    await handle!.db.update(versions).set({ version: '1' }).where(eq(versions.name, 'agent_messaging_enabled'));
    await handle!.db
      .update(hosts)
      .set({ agentMessagingEnabled: 1, secure: 0, insecureEnabledUntil: null })
      .where(eq(hosts.id, id));
    await expect(service.start(input(), 'agent:owner')).rejects.toThrow('window is closed');
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
  it('serializes Disable against running-session renewal and reopens only by explicit grant', async () => {
    const db = handle!.db;
    await db.update(hosts).set({secure:0,insecureWindowMinutes:10,insecureEnabledUntil:new Date(Date.now()+60_000)}).where(eq(hosts.id,id));
    const start = await service.start(input(),'owner'), op = (await service.offer(id,generation))!;
    await service.accept(id,op.operation_id,op.claim_id);
    const admin = new InsecureWindowAdminService({db,env:loadTestEnv(),events:makeAdminEventsWriter(db)});
    await Promise.all([service.heartbeat(id,generation,['codex'],null,[start.session_id]),admin.disable(id)]);
    const [closed]=await db.select().from(hosts).where(eq(hosts.id,id));
    expect(closed).toMatchObject({insecureEnabledUntil:null,insecureSessionRenewalBlocked:1});
    await service.heartbeat(id,generation,['codex'],null,[start.session_id]);
    expect((await service.view(id)).access.allowed).toBe(false);
    await admin.enable(id,10);
    await service.heartbeat(id,generation,['codex'],null,[start.session_id]);
    expect((await service.view(id)).access.allowed).toBe(true);
    const [opened]=await db.select().from(hosts).where(eq(hosts.id,id));
    expect(new Date(opened!.insecureEnabledUntil!).getTime()).toBeGreaterThan(Date.now()+580_000);
  });
  it('rejects an offer accepted after the access deadline and keeps its claim unexecuted', async () => {
    const db=handle!.db;
    await db.update(hosts).set({secure:0,insecureEnabledUntil:new Date(Date.now()+60_000)}).where(eq(hosts.id,id));
    await service.start(input(),'owner');const op=(await service.offer(id,generation))!;
    await db.update(hosts).set({insecureEnabledUntil:new Date(Date.now()-1000)}).where(eq(hosts.id,id));
    await expect(service.accept(id,op.operation_id,op.claim_id)).rejects.toThrow('work access');
    const [retained]=await db.select().from(hostDaemonOperations).where(eq(hostDaemonOperations.id,op.operation_id));
    expect(retained!.status).toBe('offered');
  });

});
