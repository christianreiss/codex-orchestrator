import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HostDaemonService } from '../../../src/services/host-daemon/service.js';
import { AgentMessagingService } from '../../../src/services/agent-messaging.js';
import { daemonSettingsSchema } from '../../../src/services/host-daemon/policy.js';
import { InsecureWindowAdminService } from '../../../src/services/insecure-window-admin.js';
import { makeAdminEventsWriter } from '../../../src/services/admin-events-writer.js';
import { registerHostDaemonRoutes } from '../../../src/routes/host-daemon.js';
import {
  hosts,
  versions,
  hostDaemons,
  hostDaemonSessions,
  hostDaemonOperations,
  agentBusAddresses,
  agentPrompts,
  adminEvents,
  logs,
} from '../../../src/db/schema.js';
import type { RouteContext } from '../../../src/routes/index.js';
import { createDbFake } from '../../helpers/db-fake.js';
import { loadTestEnv, testKeyring } from '../../helpers/test-keyring.js';

describe('insecure persistent daemon', () => {
  let fake: ReturnType<typeof createDbFake>, ctx: RouteContext, svc: HostDaemonService, generation: string;
  const row = (table: unknown) => fake.tables.get(table)![0]!;
  const input = () => ({
    host_id: 1,
    engine: 'codex' as const,
    cwd: '/tmp',
    title: 'Work',
    prompt: 'Hello',
    client_message_id: randomUUID(),
  });
  beforeEach(async () => {
    fake = createDbFake(
      new Map([
        [
          hosts,
          [
            {
              id: 1,
              fqdn: 'insecure.test',
              secure: 0,
              status: 'active',
              engines: 'codex,claude,grok',
              insecureEnabledUntil: new Date(Date.now() + 60_000),
              insecureWindowMinutes: 10,
              insecureSessionRenewalBlocked: 0,
            },
          ],
        ],
        [versions, [{ name: 'agent_messaging_enabled', version: '1' }]],
      ] as [unknown, Record<string, unknown>[]][]),
    );
    ctx = { db: fake as unknown as RouteContext['db'], env: loadTestEnv(), keyring: testKeyring() };
    svc = new HostDaemonService(ctx);
    await svc.configure(1, daemonSettingsSchema.parse({ enabled: true }));
    generation = (
      await svc.connect(1, {
        instance_id: randomUUID(),
        username: 'root',
        version: 'test',
        engines: ['codex', 'claude', 'grok'],
        error: null,
      })
    ).generation;
  });
  afterEach(() => vi.restoreAllMocks());
  const running = async () => {
    await svc.start(input(), 'agent:owner');
    const op = (await svc.offer(1, generation))!;
    await svc.accept(1, op.operation_id, op.claim_id);
    return op;
  };
  it('keeps a closed-window daemon connected but blocks new work', async () => {
    row(hosts).insecureEnabledUntil = null;
    const runtime = row(hostDaemons).runtime as Parameters<HostDaemonService['connect']>[1];
    generation = (await svc.connect(1, runtime)).generation;
    await svc.heartbeat(1, generation, ['codex'], null);
    expect(await svc.view(1)).toMatchObject({
      health: { state: 'yellow' },
      access: { allowed: false, reason: 'insecure_window_closed' },
    });
    expect(row(hosts).insecureEnabledUntil).toBeNull();
    await expect(svc.start(input(), 'owner')).rejects.toThrow('window is closed');
    await expect(svc.offer(1, generation)).rejects.toThrow('window is closed');
    expect(fake.tables.get(hostDaemonOperations) ?? []).toHaveLength(0);
  });
  it.each(['codex', 'claude', 'grok'] as const)(
    'renews %s work only with evidence of an accepted active process',
    async (engine) => {
      await svc.start({ ...input(), engine }, 'owner');
      const op = (await svc.offer(1, generation))!;
      await svc.accept(1, op.operation_id, op.claim_id);
      const initial = row(hosts).insecureEnabledUntil;
      await svc.heartbeat(1, generation, [engine], null, []);
      expect(row(hosts).insecureEnabledUntil).toEqual(initial);
      await svc.heartbeat(1, generation, [engine], null, [op.session_id]);
      expect(new Date(row(hosts).insecureEnabledUntil as Date).getTime()).toBeGreaterThan(
        Date.now() + 590_000,
      );
    },
  );
  it.each(['idle', 'waiting'])('renews a retained %s conversation only until its timeout', async (status) => {
    const op = await running();
    await svc.bind(1, op.operation_id, op.claim_id, 'native', 'address');
    await svc.complete(1, op.operation_id, op.claim_id, { status: 'completed', reply: 'Done' });
    fake.tables.set(agentBusAddresses, [{ id: 'address', lastUpstreamSessionId: 'transcript' }]);
    row(hostDaemonSessions).status = status;
    if (status === 'waiting')
      fake.tables.set(agentPrompts, [
        { id: 'question', sessionId: 'native', status: 'open', createdAt: new Date().toISOString() },
      ]);
    await svc.heartbeat(1, generation, ['codex'], null);
    expect(new Date(row(hosts).insecureEnabledUntil as Date).getTime()).toBeGreaterThan(Date.now() + 590_000);
    expect(row(hostDaemonSessions).status).toBe(status);
    row(hostDaemonSessions).lastActivityAt = '2000-01-01T00:00:00Z';
    row(hosts).insecureEnabledUntil = new Date(Date.now() + 60_000);
    const before = row(hosts).insecureEnabledUntil;
    await svc.heartbeat(1, generation, ['codex'], null);
    expect(row(hosts).insecureEnabledUntil).toEqual(before);
    await svc.sweep(1);
    expect(row(hostDaemonSessions).status).toBe('closed');
  });
  it('does not renew queued work, forged IDs, stale generations, stale heartbeats or expired windows', async () => {
    const queued = await svc.start(input(), 'owner');
    const initial = row(hosts).insecureEnabledUntil;
    await svc.heartbeat(1, generation, ['codex'], null, [queued.session_id, randomUUID()]);
    expect(row(hosts).insecureEnabledUntil).toEqual(initial);
    const op = (await svc.offer(1, generation))!;
    await svc.accept(1, op.operation_id, op.claim_id);
    await expect(svc.heartbeat(1, 'old', ['codex'], null, [op.session_id])).rejects.toThrow('generation');
    (row(hostDaemons).runtime as { heartbeat_at: string }).heartbeat_at = '2000-01-01T00:00:00Z';
    await svc.heartbeat(1, generation, ['codex'], null, [op.session_id]);
    expect(row(hosts).insecureEnabledUntil).toEqual(initial);
    row(hosts).insecureEnabledUntil = new Date(Date.now() - 1000);
    const expired = row(hosts).insecureEnabledUntil;
    await svc.heartbeat(1, generation, ['codex'], null, [op.session_id]);
    expect(row(hosts).insecureEnabledUntil).toEqual(expired);
  });
  it('fences manual Disable until an explicit grant and retains stop/result receipts', async () => {
    const op = await running();
    const admin = new InsecureWindowAdminService({
      db: ctx.db,
      env: ctx.env,
      events: makeAdminEventsWriter(ctx.db),
    });
    await admin.disable(1);
    await svc.heartbeat(1, generation, ['codex'], null, [op.session_id]);
    expect(row(hosts)).toMatchObject({ insecureEnabledUntil: null, insecureSessionRenewalBlocked: 1 });
    expect(await svc.accept(1, op.operation_id, op.claim_id)).toEqual({ accepted: true });
    await svc.stop(op.session_id);
    await svc.complete(1, op.operation_id, op.claim_id, { status: 'stopped', reply: 'Stopped' });
    await admin.enable(1, 10);
    expect(row(hosts).insecureSessionRenewalBlocked).toBe(0);
    await expect(svc.start(input(), 'owner')).resolves.toHaveProperty('operation_id');
  });
  it('rechecks access at acceptance even when expiry races the outer check', async () => {
    await svc.start(input(), 'owner');
    const op = (await svc.offer(1, generation))!;
    const original = svc.eligible.bind(svc);
    vi.spyOn(svc, 'eligible').mockImplementation(async (...args) => {
      const result = await original(...args);
      row(hosts).insecureEnabledUntil = null;
      return result;
    });
    await expect(svc.accept(1, op.operation_id, op.claim_id)).rejects.toThrow('work access');
    expect(row(hostDaemonOperations).status).toBe('offered');
  });
  it('allows only authenticated secure-host agents to open an audited target window', async () => {
    row(hosts).insecureEnabledUntil = null;
    const caller = { id: 2, status: 'active', secure: 1 };
    fake.tables.get(hosts)!.push(caller);
    const session = { id: randomUUID(), agentBusAddressId: randomUUID() };
    const authenticate = vi
      .spyOn(AgentMessagingService.prototype, 'authenticateBridge')
      .mockResolvedValue({ host: caller, session } as never);
    const app = Fastify();
    app.decorate('requireAdmin', async () => {});
    await registerHostDaemonRoutes(app, ctx);
    try {
      const request = {
        method: 'POST' as const,
        url: `/host/agent-sessions/${session.id}/agent-messaging/insecure-enable`,
        headers: { 'x-agent-bridge-token': 'fixture' },
        payload: { host_id: 1, duration_minutes: 10 },
      };
      expect((await app.inject(request)).statusCode).toBe(200);
      expect(row(hosts).insecureEnabledUntil).toBeInstanceOf(Date);
      expect(fake.tables.get(logs)?.at(-1)?.details).toContain(session.agentBusAddressId);
      expect(fake.tables.get(adminEvents)?.at(-1)?.payload).toMatchObject({
        source: 'secure_host',
        actor: { host_id: 2, session_id: session.id },
      });
      caller.secure = 0;
      expect((await app.inject(request)).statusCode).toBe(403);
      caller.secure = 1;
      expect(
        (await app.inject({ ...request, payload: { host_id: 1, duration_minutes: 481 } })).statusCode,
      ).toBe(500); // standalone Fastify has no Zod envelope plugin
      authenticate.mockRejectedValueOnce(new Error('Invalid bridge credential'));
      expect((await app.inject(request)).statusCode).not.toBe(200);
    } finally {
      await app.close();
    }
  });
});
