import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { registerSyncCacheRoutes } from '../../../src/routes/sync-cache.js';
import {
  authoritativeReads,
  requiresAuthoritativeReads,
  scopedDatabase,
} from '../../../src/db/fresh-read.js';
import { ForbiddenError } from '../../../src/http/errors.js';
import { buildRouteApp } from '../../helpers/build-route-app.js';
import { randomUUID } from 'node:crypto';

const state = vi.hoisted(() => ({ allowed: true, enabled: true }));
vi.mock('../../../src/services/host-auth.js', () => ({
  createHostAuthService: () => ({
    authenticate: async () => {
      if (!state.allowed) throw new ForbiddenError('revoked');
      expect(requiresAuthoritativeReads()).toBe(true);
      return { id: 1, secure: 1 };
    },
  }),
}));
vi.mock('../../../src/services/engine-switch.js', () => ({ readFleetEngineState: async () => ({}) }));
vi.mock('../../../src/services/host-engine-policy.js', () => ({
  assertHostEngineEnabled: () => {
    if (!state.enabled) throw new ForbiddenError('engine disabled');
  },
}));
vi.mock('../../../src/services/mcp-session.js', () => ({
  McpSessionService: class {
    async verify(token: string) {
      return { id: token === 'own' ? 1 : 2 };
    }
  },
}));

let app: FastifyInstance;
afterEach(async () => {
  state.allowed = state.enabled = true;
  await app?.close();
});

async function setup() {
  app = await buildRouteApp();
  const seen: Array<{ path: string; body: unknown; snapshot: boolean }> = [];
  const base = {
    tag: () => false,
    transaction: async (run: (tx: unknown) => Promise<unknown>) => run({ tag: () => true }),
  };
  const db = scopedDatabase(base);
  await registerSyncCacheRoutes(app, {
    db: db as never,
    env: { CXX_COMMUNICATOR_ENABLED: true, CXX_COMMUNICATOR_SYNC_ENABLED: true } as never,
    keyring: {} as never,
  });
  for (const path of ['/sync/bootstrap', '/config/retrieve', '/auth', '/auth/sessions', '/mcp']) {
    app.post(path, async (req) => {
      expect(requiresAuthoritativeReads()).toBe(true);
      seen.push({ path, body: req.body, snapshot: db.tag() });
      const input = req.body as Record<string, unknown>;
      if (path === '/sync/bootstrap' && input.include_content === false)
        return { auth: { status: 'valid', verification_state: 'verified', account_id: 4 } };
      if (path === '/mcp')
        return { jsonrpc: '2.0', id: input.id, result: { content: [{ type: 'text', text: 'skill body' }] } };
      return { config: { content: 'current config' }, config_seen_digest: input.config ?? null };
    });
  }
  await app.ready();
  return { seen };
}
function input(path = '/config/retrieve', body: Record<string, unknown> = {}) {
  return {
    protocol: 2,
    request_id: randomUUID(),
    method: 'POST',
    path,
    body: { engine: 'codex', ...body },
    headers: {},
    known: {},
  };
}

describe('strict communicator cache route', () => {
  it('checks every read, enters a consistent snapshot and confirms unchanged bytes', async () => {
    const { seen } = await setup();
    const first = await app.inject({
      method: 'POST',
      url: '/sync/cache',
      payload: input('/config/retrieve', { config: 'old disk digest' }),
    });
    expect(first.statusCode).toBe(200);
    const one = first.json().data;
    expect(one.protocol).toBe(2);
    expect(one.resources.length).toBeGreaterThan(0);
    expect(seen).toEqual([{ path: '/config/retrieve', body: { engine: 'codex' }, snapshot: true }]);
    const request = input();
    request.known = Object.fromEntries(
      one.resources.map((r: { path: string[]; revision: string }) => [JSON.stringify(r.path), r.revision]),
    );
    const second = await app.inject({ method: 'POST', url: '/sync/cache', payload: request });
    expect(second.json().data.resources.every((r: object) => !('content' in r))).toBe(true);
    state.allowed = false;
    expect((await app.inject({ method: 'POST', url: '/sync/cache', payload: request })).statusCode).toBe(403);
    expect(seen).toHaveLength(2);
  });

  it('keeps credential work outside the content snapshot and never repeats candidates', async () => {
    const { seen } = await setup();
    const reply = await app.inject({
      method: 'POST',
      url: '/sync/cache',
      payload: input('/sync/bootstrap', {
        auth_candidate: { test: 'candidate' },
        session_id: 'session',
        include_auth: true,
      }),
    });
    expect(reply.statusCode).toBe(200);
    expect(seen).toHaveLength(2);
    expect(seen[0]?.snapshot).toBe(false);
    expect(seen[1]?.snapshot).toBe(true);
    expect(seen[1]?.body).not.toHaveProperty('auth_candidate');
    expect(seen[1]?.body).not.toHaveProperty('session_id');
    expect(reply.json().data.body.auth.account_id).toBe(4);
  });

  it('pins MCP credentials, validates engine gates and refuses arbitrary tools/forwarding', async () => {
    await setup();
    const request = input('/mcp', {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'skill_retrieve', arguments: { slug: 'sample' } },
    });
    request.headers = { authorization: 'Bearer own' };
    expect((await app.inject({ method: 'POST', url: '/sync/cache', payload: request })).statusCode).toBe(200);
    request.headers = { authorization: 'Bearer another-host' };
    expect((await app.inject({ method: 'POST', url: '/sync/cache', payload: request })).statusCode).toBe(403);
    request.headers = { authorization: 'Bearer own', 'x-forwarded-for': '127.0.0.1' };
    expect((await app.inject({ method: 'POST', url: '/sync/cache', payload: request })).statusCode).toBe(422);
    state.enabled = false;
    expect((await app.inject({ method: 'POST', url: '/sync/cache', payload: input() })).statusCode).toBe(403);
    expect(requiresAuthoritativeReads()).toBe(false);
    expect(authoritativeReads(() => requiresAuthoritativeReads())).toBe(true);
  });
});
