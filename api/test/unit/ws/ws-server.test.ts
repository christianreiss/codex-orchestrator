import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { registerWsServer } from '../../../src/ws/server.js';
import { wsPublisher } from '../../../src/ws/publisher.js';
import { UnauthorizedError, type ApiError } from '../../../src/http/errors.js';
import type { AdminContext } from '../../../src/http/plugins/auth-admin.js';
import type { Env } from '../../../src/env.js';

/**
 * `/admin/ws` is registered by hand here rather than through the admin router,
 * so `requireAdmin` never sees it and the route-table guard only knows it is
 * meant to be admin-only. Its own preHandler is the whole gate, and the
 * heartbeat is the only thing that ever revisits that decision — without it a
 * revoked session keeps streaming every admin event for as long as the socket
 * lives. The teardown matters just as much: the interval and the publisher
 * subscription outlive the socket unless both close paths detach them.
 *
 * The Fastify instance is a stub that captures the route, so the preHandler and
 * the connection handler can be driven directly against a fake socket.
 */

const NOW = '2026-07-29T12:00:00Z';
const HEARTBEAT_SECONDS = 5;
const HEARTBEAT_MS = HEARTBEAT_SECONDS * 1000;

const ADMIN = { user: { id: 1 }, session: { id: 9 } } as unknown as AdminContext;

/** The connection request, which the heartbeat has to re-present for re-auth. */
const REQ = { id: 'req-1' } as unknown as FastifyRequest;

interface Route {
  path: string;
  opts: { websocket?: boolean; preHandler: (req: FastifyRequest) => Promise<void> };
  handler: (socket: FakeSocket, req: FastifyRequest) => void;
}

/**
 * Enough of a `ws` socket for the handler: `close()` moves readyState the way a
 * real socket does, while `emit()` fires the lifecycle listeners *without*
 * touching readyState — that keeps the socket "open" after a teardown, so a
 * leaked interval or subscription shows up as a frame instead of hiding behind
 * the readyState guard.
 */
class FakeSocket {
  readyState = 1;
  closed = 0;
  sendThrows = false;
  readonly sent: string[] = [];
  private readonly listeners = new Map<string, Array<() => void>>();

  send(data: string): void {
    if (this.sendThrows) throw new Error('WebSocket is not open');
    this.sent.push(data);
  }

  close(): void {
    this.closed += 1;
    this.readyState = 3;
  }

  on(event: string, cb: () => void): void {
    const bucket = this.listeners.get(event) ?? [];
    bucket.push(cb);
    this.listeners.set(event, bucket);
  }

  emit(event: string): void {
    for (const cb of this.listeners.get(event) ?? []) cb();
  }

  frames(): Array<Record<string, unknown>> {
    return this.sent.map((raw) => JSON.parse(raw) as Record<string, unknown>);
  }
}

interface Harness {
  routes: Route[];
  registrations: Array<{ plugin: unknown; opts: unknown }>;
  resolveAdmin: ReturnType<typeof vi.fn>;
  /** Swap what the next `resolveAdmin` call returns, as a revocation would. */
  setAdmin(ctx: AdminContext | null): void;
}

function env(over: Partial<Env> = {}): Env {
  return {
    ADMIN_WS_ENABLED: true,
    ADMIN_WS_HEARTBEAT_SECONDS: HEARTBEAT_SECONDS,
    ADMIN_WS_BACKLOG_LIMIT: 200,
    ...over,
  } as unknown as Env;
}

async function register(over: Partial<Env> = {}): Promise<Harness> {
  const routes: Route[] = [];
  const registrations: Array<{ plugin: unknown; opts: unknown }> = [];
  let admin: AdminContext | null = ADMIN;
  const resolveAdmin = vi.fn(async (_req: FastifyRequest) => admin);

  const app = {
    register: async (plugin: unknown, opts: unknown) => {
      registrations.push({ plugin, opts });
    },
    resolveAdmin,
    get: (path: string, opts: Route['opts'], handler: Route['handler']) => {
      routes.push({ path, opts, handler });
    },
  };

  await registerWsServer(app as unknown as FastifyInstance, env(over));
  return {
    routes,
    registrations,
    resolveAdmin,
    setAdmin: (ctx) => {
      admin = ctx;
    },
  };
}

/** Registers, then opens one connection through the captured handler. */
async function connect(over: Partial<Env> = {}): Promise<Harness & { socket: FakeSocket }> {
  const harness = await register(over);
  const socket = new FakeSocket();
  harness.routes[0]!.handler(socket, REQ);
  return { ...harness, socket };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(NOW));
});

afterEach(() => {
  // Drops any heartbeat still pending, so a leak cannot reach the next test.
  vi.useRealTimers();
});

describe('registerWsServer registration', () => {
  it('registers nothing at all when ADMIN_WS_ENABLED is false', async () => {
    const { routes, registrations } = await register({ ADMIN_WS_ENABLED: false });

    expect(registrations).toEqual([]);
    expect(routes).toEqual([]);
  });

  it('registers the websocket plugin and a websocket GET /admin/ws', async () => {
    const { routes, registrations } = await register();

    expect(registrations).toHaveLength(1);
    expect(registrations[0]!.opts).toEqual({ options: { maxPayload: 1024 * 1024 } });
    expect(routes).toHaveLength(1);
    expect(routes[0]!.path).toBe('/admin/ws');
    expect(routes[0]!.opts.websocket).toBe(true);
  });
});

describe('/admin/ws preHandler', () => {
  it('admits a request that resolves to an admin context', async () => {
    const { routes, resolveAdmin } = await register();

    await expect(routes[0]!.opts.preHandler(REQ)).resolves.toBeUndefined();
    expect(resolveAdmin).toHaveBeenCalledWith(REQ);
  });

  it('rejects an unauthenticated request with admin_required', async () => {
    const { routes, setAdmin } = await register();
    setAdmin(null);

    const err = await routes[0]!.opts.preHandler(REQ).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(UnauthorizedError);
    expect((err as ApiError).status).toBe(401);
    expect((err as ApiError).code).toBe('admin_required');
  });
});

describe('/admin/ws connection', () => {
  it('greets the socket with a hello frame', async () => {
    const { socket } = await connect();

    expect(socket.frames()).toEqual([{ type: 'hello', ts: NOW }]);
  });

  it('forwards published events only while the socket is open', async () => {
    const { socket } = await connect();

    wsPublisher.publish('host.updated', { id: 1 });
    expect(socket.frames().at(-1)).toEqual({ type: 'host.updated', payload: { id: 1 }, ts: NOW });

    socket.readyState = 0;
    wsPublisher.publish('host.updated', { id: 2 });
    expect(socket.frames()).toHaveLength(2);

    socket.readyState = 1;
    wsPublisher.publish('host.updated', { id: 3 });
    expect(socket.frames().at(-1)).toEqual({ type: 'host.updated', payload: { id: 3 }, ts: NOW });
  });

  it('swallows a send that throws so the fan-out reaches other sockets', async () => {
    const { socket } = await connect();
    socket.sendThrows = true;

    expect(() => wsPublisher.publish('host.updated', { id: 1 })).not.toThrow();
  });

  it('pings on every heartbeat tick while the admin session survives', async () => {
    const { socket, resolveAdmin } = await connect();

    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS - 1);
    expect(socket.frames()).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(socket.frames().at(-1)).toEqual({ type: 'ping', ts: '2026-07-29T12:00:05Z' });

    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS);
    expect(socket.frames().at(-1)).toEqual({ type: 'ping', ts: '2026-07-29T12:00:10Z' });
    // Re-auth is per tick, against the connection's own request.
    expect(resolveAdmin.mock.calls).toEqual([[REQ], [REQ]]);
  });

  it('closes the socket instead of pinging once the admin session is gone', async () => {
    const { socket, setAdmin } = await connect();
    setAdmin(null);

    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS);

    expect(socket.closed).toBe(1);
    expect(socket.frames()).toEqual([{ type: 'hello', ts: NOW }]);

    // readyState is CLOSED now, so later ticks do not re-close it.
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS * 3);
    expect(socket.closed).toBe(1);
  });

  it.each(['close', 'error'])('clears the heartbeat and unsubscribes on %s', async (event) => {
    const { socket, resolveAdmin } = await connect();
    socket.emit(event);

    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS * 3);
    wsPublisher.publish('host.updated', { id: 1 });

    // The socket still reads as open, so only a detached interval and a
    // detached subscription can explain the silence.
    expect(socket.readyState).toBe(1);
    expect(resolveAdmin).not.toHaveBeenCalled();
    expect(socket.frames()).toEqual([{ type: 'hello', ts: NOW }]);
  });
});
