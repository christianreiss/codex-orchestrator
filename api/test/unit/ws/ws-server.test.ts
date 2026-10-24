import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Database } from '../../../src/db/client.js';
import type { Env } from '../../../src/env.js';
import { UnauthorizedError } from '../../../src/http/errors.js';

const authority = vi.hoisted(() => ({
  bound: true,
  resolve: vi.fn(),
  assertOwner: vi.fn(),
  listeners: new Set<() => void>(),
}));
vi.mock('../../../src/control-plane/state/runtime.js', () => ({
  ownerRuntimeFor: () => authority.bound ? {
    assertOwner: authority.assertOwner,
    state: { subscribe: (listener: () => void) => { authority.listeners.add(listener); return () => authority.listeners.delete(listener); } },
  } : undefined,
}));
vi.mock('../../../src/control-plane/state/admission.js', () => ({ resolveOwnerAdmin: authority.resolve }));
import { registerWsServer } from '../../../src/ws/server.js';
import { wsPublisher } from '../../../src/ws/publisher.js';

const NOW = '2026-07-29T12:00:00Z';
const DB = {} as Database;
const REQ = { cookies: { admin_cookie: 'opaque-test-token' } } as unknown as FastifyRequest;
const admin = (expiresAt = '2026-07-29T13:00:00Z') => ({ user: { id: 1, active: 1 }, session: { id: 9, expiresAt } });
class Socket {
  readyState = 1;
  closed = 0;
  sent: Array<Record<string, unknown>> = [];
  listeners = new Map<string, () => void>();
  send(data: string) { this.sent.push(JSON.parse(data)); }
  close() { this.closed++; this.readyState = 3; this.listeners.get('close')?.(); }
  on(event: string, callback: () => void) { this.listeners.set(event, callback); }
}
interface Route {
  path: string;
  opts: { websocket: boolean; preHandler(req: FastifyRequest): Promise<void> };
  handler(socket: Socket, req: FastifyRequest): void;
}
const sockets: Socket[] = [];
async function register(enabled = true) {
  const routes: Route[] = [];
  const resolveAdmin = vi.fn(async () => admin());
  const app = {
    register: vi.fn(), resolveAdmin,
    get(path: string, opts: Route['opts'], handler: Route['handler']) { routes.push({ path, opts, handler }); },
  };
  await registerWsServer(app as unknown as FastifyInstance, {
    ADMIN_WS_ENABLED: enabled, ADMIN_WS_HEARTBEAT_SECONDS: 5, ADMIN_WS_BACKLOG_LIMIT: 200, ADMIN_SESSION_COOKIE: 'admin_cookie',
  } as Env, DB);
  return { app, route: routes[0], routes };
}
async function connect() {
  const harness = await register();
  await harness.route!.opts.preHandler(REQ);
  const socket = new Socket(); sockets.push(socket);
  harness.route!.handler(socket, REQ);
  return { ...harness, socket };
}
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(new Date(NOW));
  authority.bound = true; authority.resolve.mockReset().mockReturnValue(admin());
  authority.assertOwner.mockReset(); authority.listeners.clear();
});
afterEach(() => {
  for (const socket of sockets.splice(0)) socket.listeners.get('close')?.();
  vi.useRealTimers();
});

describe('admin owner stream', () => {
  it('registers nothing when disabled', async () => {
    const { routes } = await register(false); expect(routes).toEqual([]);
  });
  it('requires owner readiness and current RAM authorization before upgrade', async () => {
    const { route, app } = await register();
    authority.bound = false;
    await expect(route!.opts.preHandler(REQ)).rejects.toBeInstanceOf(UnauthorizedError);
    authority.bound = true; authority.resolve.mockReturnValue(null);
    await expect(route!.opts.preHandler(REQ)).rejects.toBeInstanceOf(UnauthorizedError);
    expect(app.resolveAdmin).not.toHaveBeenCalled();
  });
  it('sends a subscribed epoch/sequence hello, then monotonic domain frames', async () => {
    const { socket } = await connect();
    const cursor = wsPublisher.cursor();
    expect(socket.sent).toEqual([{ type: 'hello', ts: NOW, ...cursor, resync: true }]);
    wsPublisher.publish('host.updated', { id: 1 });
    expect(socket.sent[1]).toMatchObject({ type: 'host.updated', epoch: cursor.epoch, sequence: String(BigInt(cursor.sequence) + 1n) });
  });
  it('does not reauthenticate or rediscover unchanged state during ten quiet minutes', async () => {
    const { socket, app } = await connect();
    const calls = authority.resolve.mock.calls.length;
    await vi.advanceTimersByTimeAsync(600_000);
    expect(authority.resolve).toHaveBeenCalledTimes(calls);
    expect(app.resolveAdmin).not.toHaveBeenCalled();
    expect(socket.sent.filter(frame => frame.type === 'ping')).toHaveLength(120);
    expect(socket.closed).toBe(0);
  });
  it('revokes immediately on owner publication, before any following domain frame', async () => {
    const { socket } = await connect();
    authority.resolve.mockReturnValue(null);
    for (const notify of authority.listeners) notify();
    wsPublisher.publish('host.updated', { secret: 'must not arrive' });
    expect(socket.closed).toBe(1); expect(socket.sent).toHaveLength(1);
  });
  it('rechecks authority before publishing even if a revocation notification is missed', async () => {
    const { socket } = await connect(); authority.resolve.mockReturnValue(null);
    wsPublisher.publish('host.updated', {});
    expect(socket.closed).toBe(1); expect(socket.sent).toHaveLength(1);
  });
  it('enforces the exact absolute expiration without traffic', async () => {
    const expires = '2026-07-29T12:00:07Z';
    authority.resolve.mockImplementation(() => Date.now() < Date.parse(expires) ? admin(expires) : null);
    const { socket } = await connect();
    await vi.advanceTimersByTimeAsync(6999); expect(socket.closed).toBe(0);
    await vi.advanceTimersByTimeAsync(1); expect(socket.closed).toBe(1);
  });
  it('reschedules expiry when a committed session renewal arrives', async () => {
    authority.resolve.mockReturnValue(admin('2026-07-29T12:00:07Z'));
    const { socket } = await connect();
    authority.resolve.mockReturnValue(admin());
    for (const notify of authority.listeners) notify();
    await vi.advanceTimersByTimeAsync(8000); expect(socket.closed).toBe(0);
  });
  it('fails closed on owner loss rather than falling back to SQL', async () => {
    const { socket, app } = await connect();
    authority.assertOwner.mockImplementation(() => { throw new Error('owner fenced'); });
    await vi.advanceTimersByTimeAsync(5000);
    expect(socket.closed).toBe(1); expect(app.resolveAdmin).not.toHaveBeenCalled();
  });
  it.each(['close', 'error'])('unsubscribes and cancels timers on %s', async event => {
    const { socket } = await connect(); socket.listeners.get(event)?.();
    const calls = authority.resolve.mock.calls.length;
    wsPublisher.publish('host.updated', {});
    await vi.advanceTimersByTimeAsync(600_000);
    expect(socket.sent).toHaveLength(1); expect(authority.resolve).toHaveBeenCalledTimes(calls);
    expect(authority.listeners.size).toBe(0);
  });
});
