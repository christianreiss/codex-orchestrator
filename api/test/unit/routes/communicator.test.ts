import { randomUUID } from 'node:crypto';
import { wsPublisher } from '../../../src/ws/publisher.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { registerCommunicatorRoutes, communicatorPathAllowed } from '../../../src/routes/communicator.js';
import { buildRouteApp } from '../../helpers/build-route-app.js';
import { createMockDb } from '../../helpers/in-memory-db.js';

const auth = vi.hoisted(() => ({ allowed: true }));
vi.mock('../../../src/services/mcp-session.js', () => ({
  McpSessionService: class {
    async verify(token: string) {
      return token === 'own-session' ? { id: 1 } : { id: 2 };
    }
  },
}));
vi.mock('../../../src/services/host-auth.js', () => ({
  createHostAuthService: () => ({
    authenticate: async (req: {
      headers: Record<string, string>;
      authHost?: { id: number; secure: number };
    }) => {
      if (!auth.allowed || req.headers['x-api-key'] !== 'host-one') throw new Error('denied');
      req.authHost = { id: 1, secure: 1 };
      return req.authHost;
    },
  }),
}));
let app: FastifyInstance;
afterEach(async () => {
  auth.allowed = true;
  await app?.close();
});
async function setup(enabled = true) {
  app = await buildRouteApp();
  app.decorateRequest('clientIp', '192.0.2.1');
  const { db } = createMockDb();
  await registerCommunicatorRoutes(app, {
    db,
    env: { CXX_COMMUNICATOR_ENABLED: enabled } as never,
    keyring: {} as never,
  });
  app.post('/host/echo', (req) => ({ headers: req.headers, body: req.body, ip: req.socket.remoteAddress }));
  app.post('/mcp', () => ({ accepted: true }));
  await app.ready();
  return app;
}
async function open() {
  const ws = await app.injectWS('/host/communicator/connect', { headers: { 'x-api-key': 'host-one' } });
  const ready = new Promise<string>((resolve) =>
    ws.once('message', (data: unknown) => resolve(String(data))),
  );
  ws.send(JSON.stringify({ type: 'hello', protocol: 1, username: 'tester', version: '0.9.71' }));
  expect(JSON.parse(await ready)).toEqual({ type: 'ready', protocol: 1 });
  return ws;
}
describe('communicator transport', () => {
  it('rejects admin/provider URLs, traversal and recursive connections', () => {
    for (const path of [
      '/admin/users',
      '/v1/responses',
      '//evil/host/a',
      '/host/../admin/users',
      '/host/%2e%2e/admin',
      '/host/daemon/connect',
      '/host/communicator/connect',
    ])
      expect(communicatorPathAllowed(path)).toBe(false);
    for (const path of [
      '/auth',
      '/sync/bootstrap',
      '/mcp',
      '/host/agent-sessions/abc/receiver/claim',
      '/wrapper/v2/config?engine=grok',
    ])
      expect(communicatorPathAllowed(path)).toBe(true);
  });
  it('retains route contracts and IP while stripping authority-changing headers', async () => {
    await setup();
    const ws = await open();
    const reply = new Promise<string>((resolve) =>
      ws.once('message', (data: unknown) => resolve(String(data))),
    );
    const id = randomUUID();
    ws.send(
      JSON.stringify({
        id,
        type: 'request',
        method: 'POST',
        path: '/host/echo',
        headers: {
          'content-type': 'application/json',
          'x-api-key': 'another-host',
          'x-forwarded-for': '127.0.0.1',
          cookie: 'admin=1',
          'x-engine': 'grok',
        },
        body: Buffer.from(JSON.stringify({ hello: true })).toString('base64'),
      }),
    );
    const response = JSON.parse(await reply);
    expect(response).toMatchObject({ id, status: 200 });
    const body = JSON.parse(Buffer.from(response.body, 'base64').toString());
    const result = body.data ?? body;
    expect(result.body).toEqual({ hello: true });
    expect(result.ip).toBe('192.0.2.1');
    expect(result.headers['x-api-key']).toBe('host-one');
    expect(result.headers['x-engine']).toBe('grok');
    expect(result.headers.cookie).toBeUndefined();
    expect(result.headers['x-forwarded-for']).toBeUndefined();
    ws.close();
  });
  it('binds MCP session credentials to the authenticated host', async () => {
    await setup();
    const ws = await open();
    for (const [token, status] of [
      ['foreign-session', 401],
      ['own-session', 200],
      ['host-one', 200],
    ] as const) {
      const reply = new Promise<string>((resolve) =>
        ws.once('message', (data: unknown) => resolve(String(data))),
      );
      ws.send(
        JSON.stringify({
          id: randomUUID(),
          type: 'request',
          method: 'POST',
          path: '/mcp',
          headers: { authorization: `Bearer ${token}` },
          body: '',
        }),
      );
      expect(JSON.parse(await reply).status).toBe(status);
    }
    ws.close();
  });
  it('pushes content invalidations without admin payloads or sync feedback', async () => {
    await setup();
    const ws = await open();
    const messages: string[] = [];
    ws.on('message', (data: unknown) => messages.push(String(data)));
    wsPublisher.publish('host.updated', { config_version: '123', host_id: 1 });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(messages).toEqual([]);
    wsPublisher.publish('skill.updated', { slug: 'private-test', secret: 'never-forward' });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(messages).toHaveLength(1);
    expect(JSON.parse(messages[0]!)).toMatchObject({ type: 'invalidate' });
    expect(messages[0]).not.toContain('private-test');
    expect(messages[0]).not.toContain('never-forward');
    ws.close();
  });
  it('rechecks revoked credentials on an established connection', async () => {
    await setup();
    const ws = await open();
    auth.allowed = false;
    const closed = new Promise<number>((resolve) => ws.once('close', resolve));
    ws.send(JSON.stringify({ type: 'heartbeat', sessions: 1, synced_at: null }));
    expect(await closed).toBe(1008);
  });
  it('leaves the legacy API available when the communicator switch is off', async () => {
    await setup(false);
    await expect(
      app.injectWS('/host/communicator/connect', { headers: { 'x-api-key': 'host-one' } }),
    ).rejects.toThrow();
    expect((await app.inject({ method: 'POST', url: '/host/echo', payload: {} })).statusCode).toBe(200);
  });
});
