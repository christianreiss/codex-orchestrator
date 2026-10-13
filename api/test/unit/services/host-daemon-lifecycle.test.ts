import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyRequest } from 'fastify';
import { registerHostDaemonRoutes } from '../../../src/routes/host-daemon.js';
import { createAgentMessagingService } from '../../../src/services/agent-messaging.js';
import { beforeEach, describe, expect, it } from 'vitest';
import { HostDaemonService } from '../../../src/services/host-daemon/service.js';
import { daemonSettingsSchema } from '../../../src/services/host-daemon/policy.js';
import {
  hosts,
  versions,
  hostDaemons,
  hostDaemonSessions,
  hostDaemonOperations,
  agentBusAddresses,
  agentBusMessages,
  agentPrompts,
  agentSessions,
} from '../../../src/db/schema.js';
import type { RouteContext } from '../../../src/routes/index.js';
import { createDbFake } from '../../helpers/db-fake.js';
import { loadTestEnv, testKeyring } from '../../helpers/test-keyring.js';

// MySQL integration tests separately verify upserts, locking and concurrency.
describe('host daemon service decisions', () => {
  let fake: ReturnType<typeof createDbFake>, service: HostDaemonService, generation: string;
  const row = (table: unknown) => fake.tables.get(table)![0]!;
  const request = () => ({
    host_id: 1,
    engine: 'codex' as const,
    cwd: '/tmp',
    title: 'Helper',
    prompt: 'Hello',
    client_message_id: randomUUID(),
  });
  beforeEach(async () => {
    fake = createDbFake(
      new Map<unknown, Record<string, unknown>[]>([
        [
          hosts,
          [
            {
              id: 1,
              fqdn: 'daemon.test',
            apiKey: 'test-daemon-key',
              engines: 'codex,claude,grok',
              secure: 1,
              agentMessagingEnabled: 1,
              status: 'active',
              authDigest: 'test',
              claudeAuthDigest: 'test',
              grokAuthDigest: 'test',
            },
          ],
        ],
        [versions, [{ name: 'agent_messaging_enabled', version: '1' }]],
      ]),
    );
    service = new HostDaemonService({
      db: fake as unknown as RouteContext['db'],
      env: loadTestEnv(),
      keyring: testKeyring(),
    });
    await service.configure(1, daemonSettingsSchema.parse({ enabled: true }));
    generation = (
      await service.connect(1, {
        instance_id: 'daemon',
        username: 'root',
        version: 'test',
        engines: ['codex', 'claude', 'grok'],
        error: null,
      })
    ).generation;
  });
  it.each([true, false])('changes only daemon enablement (%s), preserving settings under the lock', async (enabled) => {
    const settings = daemonSettingsSchema.parse({ enabled: true, username: 'worker', default_cwd: '/srv/work', max_parallel: 3, idle_minutes: 25, question_minutes: 120 });
    row(hostDaemons).settings = settings;
    row(hostDaemons).enabledAt = '2026-10-01T00:00:00Z';
    await service.configureEnabled(1, enabled);
    // The fake records inserts but does not implement MySQL upserts.
    const write = fake.inserts.filter((entry) => entry.table === hostDaemons).at(-1)!;
    expect(write.values).toMatchObject({
      hostId: 1, settings: { ...settings, enabled },
      enabledAt: enabled ? '2026-10-01T00:00:00Z' : null,
    });
  });
  it('uses canonical daemon defaults for a newly registered host', async () => {
    fake.tables.set(hostDaemons, []);
    await service.configureEnabled(1, true);
    expect((await service.settings(1)).settings).toEqual({ ...daemonSettingsSchema.parse({ enabled: true }), resident_enabled: false });
    expect((await service.view(1)).health.reasons).toContain('installation_pending');
  });
  it('preserves residence under a legacy settings PUT, including execution disable', async () => {
    row(hostDaemons).settings = { ...daemonSettingsSchema.parse({ enabled: true }), resident_enabled: true };
    const legacy = daemonSettingsSchema.parse({ enabled: false });
    expect(Object.hasOwn(legacy, 'resident_enabled')).toBe(false);
    await service.configure(1, legacy);
    const write = fake.inserts.filter((entry) => entry.table === hostDaemons).at(-1)!;
    expect(write.values).toMatchObject({settings:{enabled:false,resident_enabled:true}});
  });
  it('allows explicit residence disable without changing remote execution', async () => {
    row(hostDaemons).settings = { ...daemonSettingsSchema.parse({ enabled: true }), resident_enabled: true };
    await service.configure(1, daemonSettingsSchema.parse({ enabled:true, resident_enabled:false }));
    const write = fake.inserts.filter((entry) => entry.table === hostDaemons).at(-1)!;
    expect(write.values).toMatchObject({settings:{enabled:true,resident_enabled:false}});
  });
  it('residence alone never admits remote execution or renews an execution deadline', async () => {
    row(hostDaemons).settings = daemonSettingsSchema.parse({enabled:false,resident_enabled:true});
    const view = await service.view(1);
    expect(view.residence).toEqual({requested:true,runtime_enabled:false});
    expect(view.health.state).toBe('disabled');
    await expect(service.start(request(),'owner')).rejects.toThrow('Host daemon is not available');
    row(hostDaemons).settings = daemonSettingsSchema.parse({enabled:true,resident_enabled:true,expires_at:'2026-01-01T00:00:00Z'});
    const expired = await service.settings(1);
    expect(expired.settings.enabled).toBe(false);
    expect(expired.settings.resident_enabled).toBe(true);
    expect(expired.settings.expires_at).toBe('2026-01-01T00:00:00Z');
  });
  it.each(['codex', 'claude', 'grok'] as const)('preserves cwd precedence and resolves omitted %s cwd on the host', async (engine) => {
    const settings = row(hostDaemons).settings as Record<string, unknown>;
    for (const cwd of [undefined, '']) {
      const start = await service.start({ ...request(), engine, cwd }, 'owner');
      expect((await service.session(start.session_id)).cwd).toBe('');
    }
    settings.default_cwd = '/srv/work';
    const configured = await service.start({ ...request(), engine, cwd: undefined }, 'owner');
    expect((await service.session(configured.session_id)).cwd).toBe('/srv/work');
    const explicit = await service.start({ ...request(), engine, cwd: '/opt/project' }, 'owner');
    expect((await service.session(explicit.session_id)).cwd).toBe('/opt/project');
  });
  it('migration fences admission while preserving queued work and the enable setting', async () => {
    const pending = await service.start(request(), 'owner');
    const requestId = randomUUID();
    expect(await service.migration(1, requestId, 'fence')).toMatchObject({ fenced: true, ready: true });
    expect((await service.settings(1)).settings.enabled).toBe(true);
    expect((await service.session(pending.session_id)).status).toBe('queued');
    await expect(service.offer(1, generation)).rejects.toThrow('Host daemon is not available');
    await expect(service.start(request(), 'owner')).rejects.toThrow('Host daemon is not available');
    await expect(service.migration(1, randomUUID(), 'release')).rejects.toThrow('Another migration holds admission');
    expect(await service.migration(1, requestId, 'fence')).toMatchObject({ fenced: true });
    expect(await service.migration(1, requestId, 'release')).toMatchObject({ fenced: false });
    expect((await service.offer(1, generation))?.session_id).toBe(pending.session_id);
  });
  it('refuses a stale offered launch after migration has fenced admission', async () => {
    await service.start(request(), 'owner');
    const operation = (await service.offer(1, generation))!;
    await service.migration(1, randomUUID(), 'fence');
    await expect(service.accept(1, operation.operation_id, operation.claim_id)).rejects.toThrow('No work slot');
    expect((await service.session(operation.session_id)).status).toBe('queued');
  });
  it('accepted work blocks migration readiness and its result retains the session', async () => {
    const pending = await service.start(request(), 'owner');
    const operation = (await service.offer(1, generation))!;
    await service.accept(1, operation.operation_id, operation.claim_id);
    const requestId = randomUUID();
    expect(await service.migration(1, requestId, 'fence')).toMatchObject({ ready: false, running: 1, accepted: 1 });
    await service.complete(1, operation.operation_id, operation.claim_id, { status: 'completed', reply: 'completed before handoff' });
    expect((await service.session(pending.session_id)).status).toBe('idle');
    expect(await service.migration(1, requestId, 'status')).toMatchObject({ ready: true });
  });
  it('legacy settings updates cannot remove the internal migration fence', async () => {
    const requestId = randomUUID();
    await service.migration(1, requestId, 'fence');
    await service.configure(1, daemonSettingsSchema.parse({ enabled: true }));
    const write = fake.inserts.filter((entry) => entry.table === hostDaemons).at(-1)!;
    expect(write.values).toMatchObject({ settings: { migration: { request_id: requestId, fenced: true } } });
  });
  it('retains the registered native home for continuation without replacing explicit cwd', async () => {
    fake.tables.set(agentSessions, [{ id: 'native', hostId: 1, cwd: '/home/worker' }]);
    for (const cwd of ['', '/opt/project']) {
      const start = await service.start({ ...request(), cwd }, 'owner');
      const op = (await service.offer(1, generation))!;
      await service.accept(1, op.operation_id, op.claim_id);
      await service.bind(1, op.operation_id, op.claim_id, 'native', 'address');
      expect((await service.session(start.session_id)).cwd).toBe(cwd || '/home/worker');
      fake.tables.set(agentBusAddresses, [{ id: 'address', lastUpstreamSessionId: 'transcript', bindingGeneration: 2 }]);
      await service.complete(1, op.operation_id, op.claim_id, { status: 'completed', reply: 'Hello' });
      await service.turn(start.session_id, 'Next', randomUUID());
      expect((await service.offer(1, generation))!.cwd).toBe(cwd || '/home/worker');
      // Finish this synthetic continuation before testing the next launch.
      const next = (await service.offer(1, generation))!;
      await service.accept(1, next.operation_id, next.claim_id);
      await service.complete(1, next.operation_id, next.claim_id, { status: 'completed', reply: 'Hello again' });
    }
  });
  it('admits daemon relays only for the configured service user on an enabled host', async () => {
    const messaging = createAgentMessagingService(
      fake as unknown as RouteContext['db'],
      loadTestEnv(),
      testKeyring(),
    );
    const input = {
      username: 'stranger:daemon',
      instanceId: randomUUID(),
      wrapperVersion: '0.9.42',
      capabilities: { host_daemon: true },
    };
    const host = await service.host(1);
    await expect(messaging.registerRelay(host, input)).rejects.toThrow('not enabled');
    input.username = 'root:daemon';
    const relay = await messaging.registerRelay(host, input);
    expect(relay).toMatchObject({ enabled: true, generation: 1 });
    const renewed = await messaging.registerRelay(host, { ...input, instanceId: randomUUID() });
    expect(renewed.relay_id).toBe(relay.relay_id);
    expect(renewed.generation).toBe(2);
    expect(renewed.relay_token).not.toBe(relay.relay_token);
    row(hostDaemons).settings = daemonSettingsSchema.parse({ enabled: false });
    await expect(messaging.registerRelay(host, input)).rejects.toThrow('not enabled');
  });
  async function running() {
    const start = await service.start(request(), 'agent:owner');
    const offer = (await service.offer(1, generation))!;
    await service.accept(1, offer.operation_id, offer.claim_id);
    return { ...start, ...offer };
  }
  it('serves operator configuration, start, transcript, follow-up and stop routes', async () => {
    const app = Fastify();
    // Capability/session middleware is tested by authorization-compatibility;
    // here use an authenticated operator to exercise the route contracts.
    app.decorate('requireAdmin', async (req: FastifyRequest) => {
      req.admin = { user: { id: 7 } } as FastifyRequest['admin'];
    });
    await registerHostDaemonRoutes(app, {
      db: fake as unknown as RouteContext['db'],
      env: loadTestEnv(),
      keyring: testKeyring(),
    });
    try {
      const list = await app.inject('/admin/host-daemons');
      expect(list.statusCode).toBe(200);
      expect(list.json().hosts[0].host_id).toBe(1);
      expect((await app.inject('/admin/hosts/1/daemon')).json().enabled).toBe(true);
      // This fake does not implement upsert; configure a fresh row.
      fake.tables.set(hostDaemons, []);
      const configured = await app.inject({
        method: 'PUT',
        url: '/admin/hosts/1/daemon',
        payload: { enabled: true },
      });
      expect(configured.statusCode).toBe(200);
      const started = await app.inject({ method: 'POST', url: '/admin/daemon-sessions', payload: request() });
      expect(started.statusCode).toBe(202);
      const id = started.json().session_id;
      const detail = await app.inject(`/admin/daemon-sessions/${id}`);
      expect(detail.json()).toMatchObject({ owner: 'admin:7', status: 'queued' });
      Object.assign(row(hostDaemonSessions), { status: 'idle', addressId: 'address' });
      fake.tables.set(agentBusAddresses, [{ id: 'address', lastUpstreamSessionId: 'transcript' }]);
      const turn = await app.inject({
        method: 'POST',
        url: `/admin/daemon-sessions/${id}/messages`,
        payload: { prompt: 'Continue', client_message_id: randomUUID() },
      });
      expect(turn.statusCode).toBe(200);
      expect(turn.json().session_id).toBe(id);
      const stopped = await app.inject({ method: 'POST', url: `/admin/daemon-sessions/${id}/stop` });
      expect(stopped.json().status).toBe('closed');
      expect(stopped.json().operations.every((op: { status: string }) => op.status === 'canceled')).toBe(
        true,
      );
      row(versions).version = '0';
      const disabledSpawn = await app.inject({
        method: 'POST',
        url: `/host/agent-sessions/${randomUUID()}/agent-messaging/spawn`,
        payload: request(),
      });
      expect(disabledSpawn.statusCode).toBe(503);
      expect(disabledSpawn.json().message).toContain('disabled');
    } finally {
      await app.close();
    }
  });
  it.each(['codex', 'claude', 'grok'] as const)(
    'starts %s with immutable results and retry keys',
    async (engine) => {
      const input = { ...request(), engine };
      const start = await service.start(input, 'agent:owner');
      expect(await service.start(input, 'agent:owner')).toEqual(start);
      await expect(service.start({ ...input, prompt: 'Changed' }, 'agent:owner')).rejects.toThrow(
        'Idempotency',
      );
      await expect(service.session(start.session_id, 'agent:stranger')).rejects.toThrow('creating agent');
      const offer = (await service.offer(1, generation))!;
      expect(offer).toMatchObject({ prompt: 'Hello', engine, upstream_session_id: '' });
      expect(await service.offer(1, generation)).toEqual(offer);
      await expect(service.accept(1, offer.operation_id, 'wrong')).rejects.toThrow('claim');
      await service.accept(1, offer.operation_id, offer.claim_id);
      expect(await service.accept(1, offer.operation_id, offer.claim_id)).toEqual({ accepted: true });
      const result = { status: 'completed' as const, reply: 'Done' };
      await service.complete(1, offer.operation_id, offer.claim_id, result);
      await service.complete(1, offer.operation_id, offer.claim_id, result);
      const session = await service.session(start.session_id);
      expect(session.status).toBe('idle');
      expect(session.operations[0]).toMatchObject({ result });
      expect(session.operations[0]).not.toHaveProperty('promptEnc');
      await expect(
        service.complete(1, offer.operation_id, offer.claim_id, { ...result, reply: 'Changed' }),
      ).rejects.toThrow('already stored');
    },
  );
  it('requires durable acceptance and preserves ambiguous outcomes', async () => {
    await service.start(request(), 'owner');
    const op = (await service.offer(1, generation))!;
    await expect(
      service.complete(1, op.operation_id, op.claim_id, { status: 'completed', reply: '' }),
    ).rejects.toThrow('not accepted');
    await service.complete(1, op.operation_id, op.claim_id, {
      status: 'unknown',
      reply: 'Lost acceptance reply',
    });
    expect((await service.session(op.session_id)).status).toBe('unknown');
  });
  it('resumes only a bound native transcript and deduplicates follow-up turns', async () => {
    const op = await running();
    await expect(service.turn(op.session_id, 'Next', 'next')).rejects.toThrow('busy');
    await expect(service.bind(1, op.operation_id, 'wrong', 'native', 'address')).rejects.toThrow('binding');
    await service.bind(1, op.operation_id, op.claim_id, 'native', 'address');
    await service.complete(1, op.operation_id, op.claim_id, { status: 'completed', reply: 'Hello' });
    await expect(service.turn(op.session_id, 'Next', 'next')).rejects.toThrow('Native transcript missing');
    fake.tables.set(agentBusAddresses, [
      { id: 'address', lastUpstreamSessionId: 'transcript', bindingGeneration: 2 },
    ]);
    const next = await service.turn(op.session_id, 'Next', 'next');
    expect(await service.turn(op.session_id, 'Next', 'next')).toEqual(next);
    await expect(service.turn(op.session_id, 'Changed', 'next')).rejects.toThrow('Idempotency');
    expect((await service.session(op.session_id)).address).toBe('agent:address');
  });
  it('keeps process stop pending and rejects stale timeout observations', async () => {
    const op = await running();
    await service.stop(op.session_id, undefined, { status: 'idle', lastActivityAt: 'old' });
    expect((await service.session(op.session_id)).status).toBe('running');
    expect((await service.stop(op.session_id)).status).toBe('stopping');
    expect((await service.heartbeat(1, generation, ['codex'], null)).stop).toEqual([op.session_id]);
    await service.complete(1, op.operation_id, op.claim_id, { status: 'stopped', reply: '' });
    expect((await service.stop(op.session_id)).status).toBe('closed');
  });
  it('blocks unavailable hosts and reports their health', async () => {
    await expect(service.host(99)).rejects.toThrow('not found');
    await expect(service.session('missing')).rejects.toThrow('not found');
    await expect(service.start({ ...request(), cwd: 'relative' }, 'owner')).rejects.toThrow('absolute');
    row(hosts).status = 'disabled';
    expect((await service.view(1)).health.reasons).toContain('host_access_blocked');
    await expect(service.eligible(1)).rejects.toThrow('available');
    row(hosts).status = 'active';
    row(versions).version = '0';
    expect((await service.view(1)).health.reasons).toContain('messaging_or_api_disabled');
    await expect(service.eligible(1)).rejects.toThrow('disabled');
  });
  it('ignores the retired per-host messaging flag for connection, health and starts', async () => {
    row(hosts).agentMessagingEnabled = 0;
    expect((await service.view(1)).health.state).toBe('green');
    await expect(service.eligible(1)).resolves.toBeDefined();
    const runtime = (await service.settings(1)).runtime!;
    await expect(service.connect(1, runtime)).resolves.toHaveProperty('generation');
    await expect(service.start(request(), 'agent:owner')).resolves.toHaveProperty('session_id');
  });
  it('still blocks insecure hosts outside their allowed window', async () => {
    row(hosts).secure = 0;
    row(hosts).insecureEnabledUntil = null;
    expect((await service.view(1)).health.reasons).toContain('insecure_window_closed');
    expect((await service.view(1)).health.state).toBe('yellow');
    await expect(service.eligible(1)).rejects.toThrow('window is closed');
    await expect(service.eligible(1, undefined, true)).resolves.toBeDefined();
    row(hosts).insecureEnabledUntil = new Date(Date.now() + 60_000);
    await expect(service.eligible(1)).resolves.toBeDefined();
  });
  it('checks service identity and rejects stale transport generations', async () => {
    const runtime = (await service.settings(1)).runtime!;
    await expect(service.connect(1, { ...runtime, username: 'stranger' })).rejects.toThrow('service user');
    await expect(service.connect(1, { ...runtime, instance_id: 'other' })).rejects.toThrow('Another daemon');
    await expect(service.heartbeat(1, 'stale', [], null)).rejects.toThrow('generation');
    await expect(service.offer(1, 'stale')).rejects.toThrow('generation');
    await service.disconnect(1, 'stale');
    expect((await service.settings(1)).runtime?.connected).toBe(true);
    await service.disconnect(1, generation);
    expect((await service.settings(1)).runtime?.connected).toBe(false);
  });
  it('expires queued work and retires content while preserving retry tombstones', async () => {
    const op = await service.start(request(), 'owner');
    row(hostDaemonOperations).createdAt = new Date(Date.now() - 601_000).toISOString();
    await service.sweep(1);
    expect((await service.session(op.session_id)).operations[0]!.status).toBe('expired');
    row(hostDaemonSessions).lastActivityAt = '2000-01-01T00:00:00Z';
    await service.sweep(1);
    expect(row(hostDaemonOperations)).toMatchObject({
      status: 'retired',
      promptEnc: '',
      resultEnc: null,
      claimId: null,
    });
    expect(row(hostDaemonOperations).clientKey).toBeTruthy();
  });
  it('preserves questions until their deadline', async () => {
    const op = await running();
    await service.bind(1, op.operation_id, op.claim_id, 'native', 'address');
    fake.tables.set(agentPrompts, [
      { id: 'question', sessionId: 'native', status: 'open', createdAt: new Date().toISOString() },
    ]);
    await service.complete(1, op.operation_id, op.claim_id, { status: 'completed', reply: 'Question?' });
    expect((await service.session(op.session_id)).status).toBe('waiting');
    await service.sweep(1);
    expect((await service.session(op.session_id)).status).toBe('waiting');
    row(agentPrompts).createdAt = new Date(Date.now() - 86_401_000).toISOString();
    await service.sweep(1);
    expect((await service.session(op.session_id)).status).toBe('closed');
  });
  it('binds peer resumes and ignores receipts for older turns', async () => {
    const op = await running();
    expect(await service.bindPeer(1, 'native', 'missing')).toBe(false);
    await service.bind(1, op.operation_id, op.claim_id, 'native', 'address');
    expect(await service.bindPeer(1, 'resumed', 'address')).toBe(true);
    row(hostDaemonSessions).activeMessageId = 'current';
    fake.tables.set(agentBusMessages, [
      { id: 'old', targetAddressId: 'address', status: 'completed' },
      { id: 'current', targetAddressId: 'address', status: 'accepted' },
    ]);
    await service.peerFinished(1, op.session_id, 'old');
    expect((await service.session(op.session_id)).status).toBe('running');
    await expect(service.peerFinished(1, op.session_id, 'current')).rejects.toThrow('still active');
    fake.tables.get(agentBusMessages)![1]!.status = 'completed';
    await service.peerFinished(1, op.session_id, 'current');
    expect((await service.session(op.session_id)).status).toBe('idle');
    expect((await service.settings(1)).settings.enabled).toBe(true);
    expect(row(hostDaemons).runtime).toBeTruthy();
  });
});
