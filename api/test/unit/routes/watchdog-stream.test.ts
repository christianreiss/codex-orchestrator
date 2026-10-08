import Fastify, { type FastifyInstance, type FastifyReply } from 'fastify';
import { get, type ClientRequest, type IncomingMessage } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerWatchdogRoutes } from '../../../src/routes/watchdogs.js';
import { WatchdogsService } from '../../../src/services/watchdogs.js';
import { ForbiddenError } from '../../../src/http/errors.js';
import type { RouteContext } from '../../../src/routes/index.js';
import { loadTestEnv, testKeyring } from '../../helpers/test-keyring.js';
const id = '11111111-1111-4111-8111-111111111111';
const apps: FastifyInstance[] = [],
  clients: ClientRequest[] = [];
afterEach(async () => {
  for (const c of clients.splice(0)) c.destroy();
  await Promise.all(apps.splice(0).map((a) => a.close()));
  vi.restoreAllMocks();
});
async function fixture() {
  const read = vi.spyOn(WatchdogsService.prototype, 'snapshot').mockImplementation(async (_id, token) => {
    if (token !== 'bridge') throw new ForbiddenError('Invalid bridge', 'watchdog_bridge_invalid');
    return {
      server_time: new Date().toISOString(),
      watchdog: null,
      progress_timeout_seconds: null,
      terminate_requested: false,
      binding_generation: 1,
    };
  });
  const app = Fastify({ logger: false });
  apps.push(app);
  let raw: FastifyReply['raw'];
  app.decorate('requireAdmin', async () => {});
  app.addHook('onRequest', async (_req, reply) => {
    raw = reply.raw;
  });
  await registerWatchdogRoutes(app, { db: {}, keyring: testKeyring(), env: loadTestEnv() } as RouteContext);
  const origin = await app.listen({ host: '127.0.0.1', port: 0 });
  return { app, origin, read, raw: () => raw };
}
async function open(origin: string, token = 'bridge') {
  return new Promise<{ response: IncomingMessage; body: () => string; client: ClientRequest }>(
    (resolve, reject) => {
      const client = get(
        `${origin}/host/agent-sessions/${id}/watchdog/stream`,
        { headers: { 'x-agent-bridge-token': token } },
        (response) => {
          let body = '';
          response.setEncoding('utf8');
          response.on('data', (c) => (body += c));
          resolve({ response, body: () => body, client });
        },
      );
      clients.push(client);
      client.on('error', reject);
    },
  );
}
describe('Watchdog real HTTP keep-alives', () => {
  it('authenticates before opening the stream', async () => {
    const f = await fixture();
    const s = await open(f.origin, 'wrong');
    expect(s.response.statusCode).toBe(403);
    expect(s.response.headers['content-type']).not.toContain('text/event-stream');
  });
  it('sends an immediate frame and another after 15 seconds without model activity', async () => {
    const f = await fixture(),
      s = await open(f.origin);
    expect(s.response.headers['content-type']).toContain('text/event-stream');
    await vi.waitFor(() => expect(s.body()).toContain('event: watchdog'));
    expect(s.response.complete).toBe(false);
    await vi.waitFor(() => expect(s.body().match(/event: watchdog/g)).toHaveLength(2), {
      timeout: 16000,
      interval: 100,
    });
    s.client.destroy();
    await delay(25);
    const reads = f.read.mock.calls.length;
    await delay(30);
    expect(f.read).toHaveBeenCalledTimes(reads);
  }, 20000);
  it('drains during shutdown, even with a snapshot read pending', async () => {
    const f = await fixture();
    let resolveRead!: (v: any) => void;
    f.read.mockResolvedValueOnce({
      server_time: new Date().toISOString(),
      watchdog: null,
      progress_timeout_seconds: null,
      terminate_requested: false,
      binding_generation: 1,
    });
    f.read.mockImplementationOnce(() => new Promise((resolve) => (resolveRead = resolve)));
    const s = await open(f.origin);
    await vi.waitFor(() => expect(resolveRead).toBeTypeOf('function'));
    const write = vi.spyOn(f.raw(), 'write');
    expect(await Promise.race([f.app.close().then(() => true), delay(750).then(() => false)])).toBe(true);
    resolveRead({ server_time: new Date().toISOString(), watchdog: null });
    await delay(20);
    expect(write).not.toHaveBeenCalled();
    expect(s.response.complete).toBe(true);
  });
  it('ends a stream when authorization is revoked on the next read', async () => {
    const f = await fixture();
    f.read.mockImplementationOnce(async () => ({
      server_time: new Date().toISOString(),
      watchdog: null,
      progress_timeout_seconds: null,
      terminate_requested: false,
      binding_generation: 1,
    }));
    f.read.mockRejectedValueOnce(new ForbiddenError('revoked'));
    const s = await open(f.origin);
    await vi.waitFor(() => expect(s.response.complete).toBe(true));
    expect(s.body()).not.toContain('event: watchdog');
  });
});
