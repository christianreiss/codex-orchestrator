import { Readable } from 'node:stream';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { McpServer } from '../src/services/mcp-server.js';
import type { McpToolsRegistry } from '../src/services/mcp-tools.js';
import type { McpResourcesService } from '../src/services/mcp-resources.js';
import type { Host } from '../src/db/schema.js';
import { bindOwnerHostPrincipal, requestHost } from '../src/control-plane/state/admission.js';
import { createAdminAuthService } from '../src/services/admin-auth.js';
import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { describe, it, expect } from 'vitest';
import type { Database } from '../src/db/client.js';
import type { StateSeed } from '../src/control-plane/state/catalog.js';
import {
  OwnerStateSnapshot,
  OwnerStateStore,
  type PreparedOwnerState,
} from '../src/control-plane/state/store.js';
import { CommandExecutor } from '../src/control-plane/commands.js';
import type { PersistenceTransaction } from '../src/control-plane/persistence.js';
import {
  bindOwnerRuntime,
  mutateOwnerState,
  type OwnerRuntime,
  withOwnerRpcResponse,
  assertOwnerRequestAuthority,
  withOwnerBackgroundScope,
} from '../src/control-plane/state/runtime.js';
import { DeadlineQueue } from '../src/control-plane/deadlines.js';
import { makeAuthAdminPlugin } from '../src/http/plugins/auth-admin.js';
import { envelopePlugin } from '../src/http/plugins/envelope.js';
import { createDbFake } from './helpers/db-fake.js';
import { loadTestEnv } from './helpers/test-keyring.js';
import { sha256 } from '../src/security/hash.js';
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
async function setup(renew = false, beforeAuth?: (app: FastifyInstance) => void) {
  const token = 'test-admin-token',
    env = loadTestEnv(),
    now = new Date().toISOString(),
    sessionId = randomUUID();
  let lost = false;
  const seed = {
    hosts: [
      {
        id: 1,
        apiKey: 'host-key',
        apiKeyHash: null,
        status: 'active',
        secure: 1,
        engines: 'codex',
        expiresAt: null,
        ip4: null,
        ip6: null,
        insecureEnabledUntil: null,
        insecureGraceUntil: null,
      },
    ],
    adminUsers: [
      {
        id: 1,
        active: 1,
        accessLevel: 'owner',
        name: 'Owner',
        username: 'owner',
        email: 'owner@test',
        passwordHash: 'unused',
        createdAt: now,
        updatedAt: now,
      },
    ],
    adminSessions: [
      {
        id: sessionId,
        userId: 1,
        tokenHash: sha256(token),
        expiresAt: new Date(Date.now() + (renew ? 60000 : 31 * 86400000)).toISOString(),
        lastSeenAt: now,
        createdAt: now,
      },
    ],
  } as unknown as StateSeed;
  const fake = createDbFake(),
    db = fake as unknown as Database,
    state = new OwnerStateStore(new OwnerStateSnapshot({ epoch: randomUUID(), sequence: 0n }, seed)),
    deadlines = new DeadlineQueue((error) => {
      throw error;
    });
  const assertOwner = () => {
    if (lost) throw new Error('Owner lost');
  };
  const executor = new CommandExecutor<OwnerStateSnapshot, PersistenceTransaction, PreparedOwnerState>({
    state,
    assertOwner,
    loseOwner(error) {
      throw error;
    },
    committed() {},
    notificationError(error) {
      throw error;
    },
    persistence: {
      async receipt() {
        return undefined;
      },
      async transaction(run) {
        await run(fake as unknown as PersistenceTransaction);
      },
      async record() {},
    },
  });
  const runtime: OwnerRuntime = { state, deadlines, assertOwner, execute: (c) => executor.execute(c) };
  bindOwnerRuntime(db, runtime);
  const app = Fastify();
  beforeAuth?.(app);
  await app.register(cookie);
  await app.register(makeAuthAdminPlugin(db, env));
  await app.register(envelopePlugin);
  const headers = { cookie: env.ADMIN_SESSION_COOKIE + '=' + token };
  const revoke = () =>
    mutateOwnerState(runtime, {
      kind: 'test.revoke',
      payload: {},
      prepare(c) {
        c.draft.upsert('adminUsers', { ...c.snapshot.table('adminUsers').get(1)!, active: 0 });
        return null;
      },
    });
  return {
    app,
    runtime,
    headers,
    db,
    env,
    revoke,
    lose() {
      lost = true;
    },
    sessionId,
    async close() {
      await app.close();
      deadlines.close();
    },
  };
}
describe('protected response completion', () => {
  it.each([204, 304])('preserves no-body status %s without introducing content-length', async (status) => {
    const f = await setup();
    try {
      f.app.get('/empty-response', { preHandler: f.app.requireAdmin }, async (_req, reply) =>
        reply.code(status).send(),
      );
      const response = await f.app.inject({ url: '/empty-response', headers: f.headers });
      expect(response.statusCode).toBe(status);
      expect(response.body).toBe('');
      expect(response.headers['content-length']).toBeUndefined();
    } finally {
      await f.close();
    }
  });

  it('revalidates after a later async onSend hook, before handing bytes to transport', async () => {
    const f = await setup(),
      entered = deferred(),
      release = deferred();
    try {
      f.app.addHook('onSend', async (_req, reply, payload) => {
        if (reply.statusCode < 400) {
          entered.resolve();
          await release.promise;
        }
        return payload;
      });
      f.app.get('/private-late', { preHandler: f.app.requireAdmin }, async () => ({ secret: 'LATE_SECRET' }));
      const pending = f.app.inject({ url: '/private-late', headers: f.headers });
      const responsePromise = pending.then((response) => response);
      await entered.promise;
      await f.revoke();
      release.resolve();
      const response = await responsePromise;
      expect(response.statusCode).toBe(401);
      expect(response.body).not.toContain('LATE_SECRET');
    } finally {
      release.resolve();
      await f.close();
    }
  });

  it('preserves committed MCP acknowledgements when a later hook revokes the sibling read', async () => {
    const f = await setup(),
      entered = deferred(),
      release = deferred();
    try {
      f.app.addHook('onSend', async (_req, reply, payload) => {
        if (reply.statusCode < 400) {
          entered.resolve();
          await release.promise;
        }
        return payload;
      });
      f.app.get('/rpc-late', { preHandler: f.app.requireAdmin }, async (_req, reply) => {
        reply.envelopeRaw = true;
        const read = await withOwnerRpcResponse(async () => ({ jsonrpc: '2.0', id: 1, result: 'LATE_READ' }));
        const action = await withOwnerRpcResponse(async () => {
          const result = await mutateOwnerState(f.runtime, {
            kind: 'test.ack',
            payload: {},
            responseAuthorization: 'commit',
            prepare: () => ({ credential: 'COMMITTED_ACK' }),
          });
          return { jsonrpc: '2.0', id: 2, result };
        });
        return [read, action];
      });
      const pending = f.app.inject({ url: '/rpc-late', headers: f.headers }).then((response) => response);
      await entered.promise;
      await f.revoke();
      release.resolve();
      const response = await pending;
      expect(response.statusCode).toBe(200);
      expect(response.json()[0].error.code).toBe(-32001);
      expect(response.json()[1].result.credential).toBe('COMMITTED_ACK');
      expect(response.body).not.toContain('LATE_READ');
      expect(Number(response.headers['content-length'])).toBe(Buffer.byteLength(response.body));
    } finally {
      release.resolve();
      await f.close();
    }
  });

  it('drops a prefetched stream chunk after revocation while transport is backpressured', async () => {
    const entered = deferred(),
      observed: string[] = [];
    let response!: FastifyReply;
    const f = await setup(false, (app) => {
      app.addHook('onRequest', async (_req, reply) => {
        response = reply;
        const write = reply.raw.write;
        reply.raw.write = function (this: FastifyReply['raw'], ...args: unknown[]) {
          observed.push(String(args[0]));
          Reflect.apply(write, this, args);
          entered.resolve();
          return false;
        } as typeof reply.raw.write;
      });
    });
    let buffered: Readable | undefined;
    try {
      f.app.addHook('onSend', async (_req, _reply, payload) => {
        if (payload instanceof Readable) buffered = payload;
        return payload;
      });
      f.app.get('/stream-private', { preHandler: f.app.requireAdmin }, async (_req, reply) => {
        reply.type('application/octet-stream');
        return Readable.from(['FIRST', 'BUFFERED_SECRET']);
      });
      const pending = f.app.inject({ url: '/stream-private', headers: f.headers }).then(
        () => undefined,
        (error: unknown) => error,
      );
      await entered.promise;
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(buffered!.readableLength).toBeGreaterThan(0);
      await f.revoke();
      response.raw.emit('drain');
      await pending;
      expect(observed).toEqual(['FIRST']);
      expect(response.raw.destroyed).toBe(true);
    } finally {
      await f.close();
    }
  });

  it.each([false, true])(
    'denies cold read after revocation, including automatic renewal=%s',
    async (renew) => {
      const f = await setup(renew),
        entered = deferred(),
        release = deferred();
      try {
        f.app.get(
          '/private',
          { preHandler: f.app.requireAdmin, config: { ownerResponse: 'committed-action' } },
          async () => {
            entered.resolve();
            await release.promise;
            return { secret: 'NEVER_DELIVER' };
          },
        );
        const request = f.app.inject({ url: '/private', headers: f.headers }).then((r) => r);
        await entered.promise;
        await f.revoke();
        release.resolve();
        const response = await request;
        expect(response.statusCode).toBe(401);
        expect(response.body).not.toContain('NEVER_DELIVER');
      } finally {
        await f.close();
      }
    },
  );
  it('denies cold read after owner loss', async () => {
    const f = await setup(),
      entered = deferred(),
      release = deferred();
    try {
      f.app.get('/private', { preHandler: f.app.requireAdmin }, async () => {
        entered.resolve();
        await release.promise;
        return { secret: 'NEVER_DELIVER' };
      });
      const request = f.app.inject({ url: '/private', headers: f.headers }).then((r) => r);
      await entered.promise;
      f.lose();
      release.resolve();
      const response = await request;
      expect(response.statusCode).toBeGreaterThanOrEqual(500);
      expect(response.body).not.toContain('NEVER_DELIVER');
    } finally {
      await f.close();
    }
  });
  it.each([false, true])(
    'delivers a committed self-rotation result only while its owner is valid (fenced=%s)',
    async (fenced) => {
      const f = await setup(),
        committed = deferred(),
        release = deferred();
      try {
        f.app.post(
          '/rotate',
          { preHandler: f.app.requireAdmin, config: { ownerResponse: 'committed-action' } },
          async () => {
            const result = await mutateOwnerState(f.runtime, {
              kind: 'test.rotate',
              responseAuthorization: 'commit',
              payload: {},
              prepare(c) {
                c.draft.remove('adminSessions', f.sessionId);
                return { replacement_credential: 'ACK_REQUIRED' };
              },
            });
            committed.resolve();
            await release.promise;
            return result;
          },
        );
        const request = f.app.inject({ method: 'POST', url: '/rotate', headers: f.headers }).then((r) => r);
        await committed.promise;
        await mutateOwnerState(f.runtime, {
          kind: 'test.unrelated',
          payload: {},
          prepare(c) {
            c.draft.upsert('versions', {
              name: 'unrelated',
              version: '1',
              updatedAt: new Date().toISOString(),
            });
            return null;
          },
        });
        if (fenced) f.lose();
        release.resolve();
        const response = await request;
        expect(response.statusCode).toBe(fenced ? 500 : 200);
        if (fenced) expect(response.body).not.toContain('ACK_REQUIRED');
        else expect(response.body).toContain('ACK_REQUIRED');
      } finally {
        await f.close();
      }
    },
  );
  it('does not let a committed MCP sibling authorize a revoked read result', async () => {
    const f = await setup();
    try {
      f.app.post('/mcp', { preHandler: f.app.requireAdmin }, async (_req, reply) => {
        const read = await withOwnerRpcResponse(async () => ({
          jsonrpc: '2.0',
          id: 1,
          result: { secret: 'NEVER_DELIVER' },
        }));
        const mutation = await withOwnerRpcResponse(async () => ({
          jsonrpc: '2.0',
          id: 2,
          result: await mutateOwnerState(f.runtime, {
            kind: 'test.rotate',
            responseAuthorization: 'commit',
            payload: {},
            prepare(c) {
              c.draft.remove('adminSessions', f.sessionId);
              return { replacement_credential: 'ACK_REQUIRED' };
            },
          }),
        }));
        const denied = await withOwnerRpcResponse(async () => {
          try {
            assertOwnerRequestAuthority();
            return { jsonrpc: '2.0', id: 3, result: { secret: 'NEVER_DELIVER' } };
          } catch {
            return { jsonrpc: '2.0', id: 3, error: { code: -32001, message: 'revoked' } };
          }
        });
        reply.envelopeRaw = true;
        return JSON.stringify([read, mutation, denied]);
      });
      const response = await f.app.inject({ method: 'POST', url: '/mcp', headers: f.headers });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body[0].error.code).toBe(-32001);
      expect(body[1].result.replacement_credential).toBe('ACK_REQUIRED');
      expect(body[2].error).toBeDefined();
      expect(response.body).not.toContain('NEVER_DELIVER');
    } finally {
      await f.close();
    }
  });
});

it.each(['extend', 'shorten', 'close', 'change-ip'] as const)(
  'revalidates insecure-host responses when windows %s', async (change) => {
    const f = await setup();
    const until = new Date(Date.now() + 600_000);
    const updateHost = (patch: Partial<Host>) => mutateOwnerState(f.runtime, {
      kind: 'test.host.window', payload: {}, prepare(c) {
        c.draft.upsert('hosts', { ...c.snapshot.hosts.get(1)!, ...patch });
        return null;
      },
    });
    try {
      await updateHost({ secure: 0, insecureEnabledUntil: until, insecureGraceUntil: until });
      f.app.get('/host-window', {
        preHandler: async () => bindOwnerHostPrincipal(
          f.db, requestHost(f.runtime.state.snapshot().hosts.get(1)!, 'host-key'), true,
        ),
      }, async () => {
        await withOwnerBackgroundScope(() => updateHost(
          change === 'change-ip' ? { ip4: '192.0.2.1' } : {
            insecureEnabledUntil: change === 'close' ? null : new Date(until.getTime() + (change === 'extend' ? 60_000 : -60_000)),
            insecureGraceUntil: change === 'close' ? null : new Date(until.getTime() + (change === 'extend' ? 60_000 : -60_000)),
          },
        ));
        return { secret: 'ADMITTED_WINDOW_RESPONSE' };
      });
      const response = await f.app.inject({ method: 'GET', url: '/host-window', headers: f.headers });
      expect(response.statusCode).toBe(change === 'extend' ? 200 : 401);
      expect(response.body.includes('ADMITTED_WINDOW_RESPONSE')).toBe(change === 'extend');
    } finally { await f.close(); }
  },
);

it('denies a host cold file after key rotation and delivers the explicit rotating action ACK', async () => {
  const f = await setup(),
    entered = deferred(),
    release = deferred();
  const admit = async () =>
    bindOwnerHostPrincipal(f.db, requestHost(f.runtime.state.snapshot().hosts.get(1)!, 'host-key'));
  try {
    f.app.get('/file', { preHandler: admit }, async (_req, reply) => {
      entered.resolve();
      await release.promise;
      reply.envelopeRaw = true;
      return Buffer.from('NEVER_DELIVER');
    });
    f.app.post(
      '/rotate-host',
      { preHandler: admit, config: { ownerResponse: 'committed-action' } },
      async () => {
        const result = await mutateOwnerState(f.runtime, {
          kind: 'test.host.rotate',
          responseAuthorization: 'commit',
          payload: {},
          prepare(c) {
            c.draft.upsert('hosts', { ...c.snapshot.hosts.get(1)!, apiKeyHash: sha256('new-key') });
            return { api_key: 'new-key' };
          },
        });
        await withOwnerBackgroundScope(() =>
          mutateOwnerState(f.runtime, {
            kind: 'test.other',
            payload: {},
            prepare(c) {
              c.draft.upsert('versions', {
                name: 'other',
                version: '1',
                updatedAt: new Date().toISOString(),
              });
              return null;
            },
          }),
        );
        return result;
      },
    );
    const cold = f.app.inject({ url: '/file' }).then((r) => r);
    await entered.promise;
    const rotated = await f.app.inject({ method: 'POST', url: '/rotate-host' });
    expect(rotated.statusCode).toBe(200);
    expect(rotated.body).toContain('new-key');
    release.resolve();
    const response = await cold;
    expect(response.statusCode).toBe(401);
    expect(response.body).not.toContain('NEVER_DELIVER');
  } finally {
    await f.close();
  }
});
it('returns the real logout acknowledgement after its session deletion commits', async () => {
  const f = await setup();
  try {
    const auth = createAdminAuthService(f.db, f.env);
    f.app.post(
      '/logout',
      { preHandler: f.app.requireAdmin, config: { ownerResponse: 'committed-action' } },
      async () => {
        await auth.logoutByToken('test-admin-token');
        return { logged_out: true };
      },
    );
    const response = await f.app.inject({ method: 'POST', url: '/logout', headers: f.headers });
    expect(response.statusCode).toBe(200);
    expect(f.runtime.state.snapshot().adminSessions.has(f.sessionId)).toBe(false);
  } finally {
    await f.close();
  }
});

it.each([false, true])(
  'actual MCP dispatcher isolates committed rotation responses, notifications=%s',
  async (notification) => {
    const f = await setup();
    let calls = 0;
    try {
      const tools = {
        has: () => true,
        dispatch: async (name: string) => {
          calls++;
          if (name === 'rotate')
            return mutateOwnerState(f.runtime, {
              kind: 'test.host.rotate',
              responseAuthorization: 'commit',
              payload: {},
              prepare(c) {
                c.draft.remove('adminSessions', f.sessionId);
                return { replacement_credential: 'ACK_REQUIRED' };
              },
            });
          return { replacement_credential: 'ACK_REQUIRED' };
        },
      } as unknown as McpToolsRegistry;
      const server = new McpServer(tools, {} as McpResourcesService);
      f.app.post('/rpc', { preHandler: f.app.requireAdmin }, async (req, reply) => {
        const result = await server.handlePayload(req.body, {
          host: {} as Host,
          clientIp: null,
          serverVersion: 'test',
        });
        reply.envelopeRaw = true;
        if (result === null) return reply.code(202).send();
        return JSON.stringify(result);
      });
      const body = notification
        ? [{ jsonrpc: '2.0', method: 'tools/call', params: { name: 'rotate' } }]
        : ['read', 'rotate', 'late-read'].map((name) => ({
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/call',
            params: { name },
          }));
      const response = await f.app.inject({ method: 'POST', url: '/rpc', headers: f.headers, payload: body });
      if (notification) {
        expect(response.statusCode).toBe(202);
        expect(response.body).toBe('');
        expect(calls).toBe(1);
      } else {
        expect(response.statusCode).toBe(200);
        const parsed = response.json();
        expect(parsed[0].error).toBeDefined();
        expect(parsed[1].result.replacement_credential).toBe('ACK_REQUIRED');
        expect(parsed[2].error).toBeDefined();
        expect(calls).toBe(2);
      }
    } finally {
      await f.close();
    }
  },
);
