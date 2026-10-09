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
    row(hosts).agentMessagingEnabled = 0;
    expect((await service.view(1)).health.reasons).toContain('host_access_blocked');
    await expect(service.eligible(1)).rejects.toThrow('available');
    row(hosts).agentMessagingEnabled = 1;
    row(versions).version = '0';
    expect((await service.view(1)).health.reasons).toContain('messaging_or_api_disabled');
    await expect(service.eligible(1)).rejects.toThrow('disabled');
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
