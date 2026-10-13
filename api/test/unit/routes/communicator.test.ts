import { randomUUID } from 'node:crypto';
import { wsPublisher } from '../../../src/ws/publisher.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { registerCommunicatorRoutes, communicatorPathAllowed, communicatorResponseMayRepeat } from '../../../src/routes/communicator.js';
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
      const key = req.headers['x-api-key'];
      if (!auth.allowed || (key !== 'host-one' && key !== 'host-two')) throw new Error('denied');
      req.authHost = { id: key === 'host-two' ? 2 : 1, secure: 1 };
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
  for (const path of ['/auth/sessions', '/auth/sessions/heartbeat', '/auth/sessions/release']) {
    app.post(path, (req) => ({ body: req.body, hostKey: req.headers['x-api-key'] }));
  }
  app.post('/auth', () => ({ verification_state: 'verified', engine: 'claude', account_id: 7 }));
  app.get('/host/big', () => ({ blob: 'x'.repeat(12 * 1024 * 1024) }));
  app.post('/host/big', () => ({ blob: 'x'.repeat(12 * 1024 * 1024) }));
  app.get('/host/wide', (_req, reply) => reply.header('x-wide', 'h'.repeat(15.5 * 1024 * 1024)).send({ ok: true }));
  await app.ready();
  return app;
}
async function open() {
  const ws = await app.injectWS('/host/communicator/connect', { headers: { 'x-api-key': 'host-one' } });
  const ready = new Promise<string>((resolve) =>
    ws.once('message', (data: unknown) => resolve(String(data))),
  );
  ws.send(JSON.stringify({ type: 'hello', protocol: 1, username: 'tester', version: '0.9.71' }));
  expect(JSON.parse(await ready)).toEqual({ type: 'ready', protocol: 1, control: ['terminate'] });
  return ws;
}
describe('communicator transport', () => {
  it('restricts oversized reply retries to known content reads', () => {
    const request = (path: string, body: string) => ({method:'POST', path, body:Buffer.from(body).toString('base64')});
    expect(communicatorResponseMayRepeat(request('/sync/bootstrap/', '{"include_auth":false}'))).toBe(true);
    expect(communicatorResponseMayRepeat(request('/agents/retrieve', '{}'))).toBe(true);
    expect(communicatorResponseMayRepeat(request('/config/retrieve', '{}'))).toBe(true);
    expect(communicatorResponseMayRepeat({method:'GET',path:'/skills',body:''})).toBe(true);
    for (const body of ['{}', '{"include_auth":true}', '{"include_auth":false,"auth_candidate":{}}', '{"include_auth":false,"session_id":"session"}', '{"include_auth":false,"auth_candidate":null}', 'invalid JSON']) {
      expect(communicatorResponseMayRepeat(request('/sync/bootstrap',body))).toBe(false);
    }
    for (const path of ['/auth','/mcp','/sync/status','/cron/check']) {
      expect(communicatorResponseMayRepeat(request(path, '{}'))).toBe(false);
    }
  });
  it('reports a completed oversized write as unknown without inviting a retry', async () => {
    await setup();
    const ws = await open();
    const id = randomUUID();
    const reply = new Promise<string>((resolve) => ws.once('message', (data: unknown) => resolve(String(data))));
    ws.send(JSON.stringify({id, type:'request', method:'POST', path:'/host/big', headers:{}, body:''}));
    const response = JSON.parse(await reply);
    expect(response).toMatchObject({id, status:409});
    expect(JSON.parse(Buffer.from(response.body, 'base64').toString())).toMatchObject({code:'communicator_outcome_unknown'});
    const next = new Promise<string>((resolve) => ws.once('message', (data: unknown) => resolve(String(data))));
    ws.send(JSON.stringify({id:randomUUID(),type:'request',method:'POST',path:'/host/echo',headers:{},body:''}));
    expect(JSON.parse(await next).status).toBe(200);
    ws.close();
  });
  it('rejects admin/provider URLs, traversal and recursive connections', () => {
    for (const path of [
      '/admin/users',
      '/auth/sessions/admin',
      '/v1/responses',
      '//evil/host/a',
      '/host/../admin/users',
      '/host/%2e%2e/admin',
      '/host/daemon/connect',
      '/host/communicator/connect',
      // The router ignores trailing slashes; the deny-list must too.
      '/host/agent-sessions/abc/watchdog/stream/',
      '/host/agent-sessions/abc/watchdog/stream//',
      '/host/daemon/connect/',
      '/host/communicator/connect/',
      '/admin/users/',
    ])
      expect(communicatorPathAllowed(path)).toBe(false);
    for (const path of [
      '/auth',
      '/auth/sessions',
      '/auth/sessions/heartbeat',
      '/auth/sessions/release',
      '/sync/bootstrap',
      '/sync/status',
      '/cron/check',
      '/cron/report',
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
  it('pins MCP credentials on a trailing-slash path too', async () => {
    await setup();
    const ws = await open();
    const reply = new Promise<string>((resolve) =>
      ws.once('message', (data: unknown) => resolve(String(data))),
    );
    ws.send(
      JSON.stringify({
        id: randomUUID(),
        type: 'request',
        method: 'POST',
        path: '/mcp/',
        headers: { authorization: 'Bearer foreign-session' },
        body: '',
      }),
    );
    expect(JSON.parse(await reply).status).toBe(401);
    ws.close();
  });
  it('rejects one invalid request frame without closing the shared connection', async () => {
    await setup();
    const ws = await open();
    let closed = false;
    ws.once('close', () => {
      closed = true;
    });
    const next = () =>
      new Promise<{ id: string; status: number }>((resolve) =>
        ws.once('message', (data: unknown) => resolve(JSON.parse(String(data)))),
      );
    for (const frame of [
      { method: 'GET', path: '/admin/users' },
      { method: 'GET', path: '/host/agent-sessions/abc/watchdog/stream/' },
      { method: 'TRACE', path: '/host/echo' },
    ]) {
      const id = randomUUID();
      const reply = next();
      ws.send(JSON.stringify({ id, type: 'request', headers: {}, body: '', ...frame }));
      expect(await reply).toMatchObject({ id, status: 400 });
    }
    const id = randomUUID();
    const reply = next();
    ws.send(
      JSON.stringify({ id, type: 'request', method: 'POST', path: '/host/echo', headers: {}, body: '' }),
    );
    expect(await reply).toMatchObject({ id, status: 200 });
    expect(closed).toBe(false);
    auth.allowed = false;
    const revoked = new Promise<number>((resolve) => ws.once('close', resolve));
    ws.send(
      JSON.stringify({
        id: randomUUID(),
        type: 'request',
        method: 'POST',
        path: '/host/echo',
        headers: {},
        body: '',
      }),
    );
    expect(await revoked).toBe(1008);
  });
  it('pushes content invalidations without admin payloads or sync feedback', async () => {
    await setup();
    const ws = await open();
    const messages: string[] = [];
    ws.on('message', (data: unknown) => messages.push(String(data)));
    wsPublisher.publish('host.updated', { config_version: '123', host_id: 1 });
    wsPublisher.publish('host.updated', { source: 'cron_report', id: 1 });
    wsPublisher.publish('host.updated', { source: 'daemon_window', id: 1 });
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
  it('ignores host events for other hosts and still follows its own', async () => {
    await setup();
    const ws = await open();
    const frames: Record<string, unknown>[] = [];
    ws.on('message', (data: unknown) => frames.push(JSON.parse(String(data))));
    wsPublisher.publish('host.updated', { id: 2, fqdn: 'another-host' });
    wsPublisher.publish('host.pruned', { id: 2, fqdn: 'another-host' });
    await new Promise((resolve) => setTimeout(resolve, 350));
    expect(frames).toEqual([]);
    wsPublisher.publish('host.updated', { id: 1, fqdn: 'this-host' });
    await new Promise((resolve) => setTimeout(resolve, 350));
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({ type: 'invalidate' });
    wsPublisher.publish('host.updated', { fqdn: 'unattributed' });
    await new Promise((resolve) => setTimeout(resolve, 350));
    expect(frames).toHaveLength(2);
    ws.close();
  });
  it('answers an oversized reply with 502 and keeps the shared connection open', async () => {
    await setup();
    const ws = await open();
    const closed = vi.fn();
    ws.on('close', closed);
    const id = randomUUID();
    const big = new Promise<Record<string, unknown>>((resolve) =>
      ws.once('message', (data: unknown) => resolve(JSON.parse(String(data)))),
    );
    ws.send(JSON.stringify({ id, type: 'request', method: 'GET', path: '/host/big', headers: {}, body: '' }));
    const reply = await big;
    expect(reply.status).toBe(502);
    expect(JSON.parse(Buffer.from(String(reply.body), 'base64').toString())).toMatchObject({
      code: 'communicator_response_too_large',
    });
    const next = new Promise<Record<string, unknown>>((resolve) =>
      ws.once('message', (data: unknown) => resolve(JSON.parse(String(data)))),
    );
    const follow = randomUUID();
    ws.send(JSON.stringify({ id: follow, type: 'request', method: 'POST', path: '/host/echo', headers: {}, body: '' }));
    expect(await next).toMatchObject({ id: follow, status: 200 });
    expect(closed).not.toHaveBeenCalled();
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

it('separates credential invalidations from content and never broadcasts credential metadata', async () => {
  await setup();
  const ws = await open();
  const frames: Record<string, unknown>[] = [];
  ws.on('message', (data: unknown) => frames.push(JSON.parse(String(data))));
  wsPublisher.publish('auth.canonical', {
    engine: 'codex',
    account_id: 99,
    generation: 7,
    auth: 'must-not-leak',
  });
  await new Promise((resolve) => setTimeout(resolve, 350));
  expect(frames).toContainEqual({ type: 'auth_changed' });
  expect(frames.some((frame) => frame.type === 'invalidate')).toBe(false);
  expect(JSON.stringify(frames)).not.toContain('must-not-leak');
  expect(JSON.stringify(frames)).not.toContain('account_id');
  ws.close();
});

it('targets only previously authorized account metadata', async () => {
  await setup();
  const ws = await open();
  const response = new Promise(resolve => ws.once('message', resolve));
  ws.send(JSON.stringify({ id: randomUUID(), type: 'request', method: 'POST', path: '/auth', headers: {}, body: '' }));
  await response;
  const frames: unknown[] = [];
  ws.on('message', (data: unknown) => frames.push(JSON.parse(String(data))));
  wsPublisher.publish('auth.canonical', { engine: 'claude', account_id: 7, generation: 9, auth: 'never-forward' });
  wsPublisher.publish('auth.canonical', { engine: 'claude', account_id: 8, generation: 10, auth: 'never-forward' });
  await new Promise(resolve => setTimeout(resolve, 350));
  expect(frames).toContainEqual({ type: 'auth_changed', engine: 'claude', account_id: 7, generation: 9 });
  expect(frames).toContainEqual({ type: 'auth_changed' });
  expect(frames).toHaveLength(2);
  expect(JSON.stringify(frames)).not.toContain('never-forward');
  ws.close();
});

it('preserves account acquisition, heartbeat and release for all native engines', async () => {
  await setup();
  const ws = await open();
  for (const engine of ['codex', 'claude', 'grok']) {
    for (const path of ['/auth/sessions', '/auth/sessions/heartbeat', '/auth/sessions/release']) {
      const id = randomUUID();
      const body = { engine, session_id: randomUUID(), scope_id: 'isolated-native-home' };
      const reply = new Promise<string>(resolve => ws.once('message', (data: unknown) => resolve(String(data))));
      ws.send(JSON.stringify({ id, type: 'request', method: 'POST', path, headers: {'content-type':'application/json'}, body: Buffer.from(JSON.stringify(body)).toString('base64') }));
      const response = JSON.parse(await reply);
      expect(response).toMatchObject({ id, status: 200 });
      const decoded = JSON.parse(Buffer.from(response.body, 'base64').toString());
      expect(decoded.data ?? decoded).toEqual({ body, hostKey: 'host-one' });
    }
  }
  ws.close();
});

describe('communicator effects that may already have happened', () => {
  async function frameReply(ws: Awaited<ReturnType<typeof open>>, frame: Record<string, unknown>) {
    const id = randomUUID();
    const reply = new Promise<{ id: string; status: number; body: string }>((resolve) => {
      const on = (data: unknown) => {
        const parsed = JSON.parse(String(data));
        if (parsed.id !== id) return;
        ws.off('message', on);
        resolve(parsed);
      };
      ws.on('message', on);
    });
    ws.send(JSON.stringify({ id, type: 'request', headers: {}, body: '', ...frame }));
    return reply;
  }
  const code = (reply: { body: string }) => JSON.parse(Buffer.from(reply.body, 'base64').toString()).code;

  it('never answers a throw after dispatch with a retryable status for a write', async () => {
    await setup();
    const ws = await open();
    let dispatched = 0;
    const real = app.inject.bind(app) as (...args: unknown[]) => Promise<unknown>;
    const spy = vi.spyOn(app, 'inject').mockImplementation(((...args: unknown[]) => {
      const options = args[0] as { url?: string };
      if (options.url === '/host/echo') {
        dispatched++;
        return new Promise((_, reject) => setTimeout(() => reject(new Error('transport fault after the handler ran')), 120));
      }
      return real(...args);
    }) as never);
    // A concurrent unrelated request must be served while the write is in doubt.
    const doubtful = frameReply(ws, { method: 'POST', path: '/host/echo' });
    const unrelated = await frameReply(ws, { method: 'POST', path: '/auth/sessions' });
    expect(unrelated.status).toBe(200);
    const write = await doubtful;
    expect(write.status).toBe(409);
    expect(code(write)).toBe('communicator_outcome_unknown');
    expect(dispatched).toBe(1);
    spy.mockRestore();
    expect((await frameReply(ws, { method: 'POST', path: '/host/echo' })).status).toBe(200);
    ws.close();
  });

  it('keeps a repeatable read retryable when the same fault hits it', async () => {
    await setup();
    const ws = await open();
    const spy = vi.spyOn(app, 'inject').mockImplementation((() => Promise.reject(new Error('fault'))) as never);
    const read = await frameReply(ws, { method: 'GET', path: '/versions' });
    expect(read.status).toBeGreaterThanOrEqual(500);
    expect(code(read)).not.toBe('communicator_outcome_unknown');
    spy.mockRestore();
    ws.close();
  });

  it('keeps a committed write\'s reply when only the topology bookkeeping fails', async () => {
    await setup();
    const { communicatorRegistry } = await import('../../../src/services/topology/communicator-registry.js');
    const ws = await open();
    const spy = vi.spyOn(communicatorRegistry, 'observeDispatch').mockImplementation(() => {
      throw new Error('bookkeeping failure');
    });
    const reply = await frameReply(ws, { method: 'POST', path: '/auth/sessions' });
    expect(reply.status).toBe(200);
    spy.mockRestore();
    ws.close();
  });

  it('measures the whole encoded frame, not only the payload', async () => {
    await setup();
    const ws = await open();
    const read = await frameReply(ws, { method: 'GET', path: '/host/wide' });
    expect(read.status).toBe(502);
    expect(code(read)).toBe('communicator_response_too_large');
    ws.close();
  });

  it('scopes host events for two distinct hosts and still broadcasts a fleet-wide one', async () => {
    await setup();
    const open2 = async (key: string) => {
      const ws = await app.injectWS('/host/communicator/connect', { headers: { 'x-api-key': key } });
      const ready = new Promise((resolve) => ws.once('message', resolve));
      ws.send(JSON.stringify({ type: 'hello', protocol: 1, username: key, version: '0.9.76' }));
      await ready;
      const frames: Record<string, unknown>[] = [];
      ws.on('message', (data: unknown) => frames.push(JSON.parse(String(data))));
      return { ws, frames };
    };
    const one = await open2('host-one');
    const two = await open2('host-two');
    for (const [type, payload] of [
      ['host.updated', { id: 1 }],
      ['host.deleted', { id: 2, fqdn: 'two' }],
      ['host.pruned', { id: 2, fqdn: 'two', reason: 'inactive' }],
      ['host.created', { id: 1, fqdn: 'one' }],
      ['host.force_delete_ip_mismatch', { id: 2, fqdn: 'two', ip: '192.0.2.9' }],
    ] as const)
      wsPublisher.publish(type, payload);
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(one.frames.filter((f) => f.type === 'invalidate')).toHaveLength(1);
    expect(two.frames.filter((f) => f.type === 'invalidate')).toHaveLength(1);
    one.frames.length = 0;
    two.frames.length = 0;
    wsPublisher.publish('host.updated', { fqdn: 'fleet-wide, names no host' });
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(one.frames.filter((f) => f.type === 'invalidate')).toHaveLength(1);
    expect(two.frames.filter((f) => f.type === 'invalidate')).toHaveLength(1);
    one.ws.close();
    two.ws.close();
  });
});
