import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import { envelopePlugin } from '../../../src/http/plugins/envelope.js';
import { requestIdPlugin } from '../../../src/http/plugins/request-id.js';
import { registerAdminOverviewRoutes } from '../../../src/routes/admin/overview/index.js';
import type { Env } from '../../../src/env.js';
import type { RouteContext } from '../../../src/routes/index.js';

/**
 * Integration test for /admin/ws/info. We bypass the real auth-admin plugin
 * by decorating `app.requireAdmin` with a no-op preHandler — the route still
 * runs in the normal Fastify pipeline (envelope, request-id, error handler).
 *
 * The DB and Keyring are stubbed because the route does not touch them.
 */
async function buildApp(env: Env): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(cookie);
  await app.register(requestIdPlugin);
  await app.register(envelopePlugin);
  app.decorate('requireAdmin', async () => {
    /* allow */
  });
  app.decorate('resolveAdmin', async () => null);
  const ctx: RouteContext = {
    db: {} as unknown as RouteContext['db'],
    env,
    keyring: {} as unknown as RouteContext['keyring'],
  };
  await registerAdminOverviewRoutes(app, ctx);
  await app.ready();
  return app;
}

function fakeEnv(overrides: Partial<Env> = {}): Env {
  return {
    ADMIN_WS_ENABLED: false,
    ADMIN_WS_HEARTBEAT_SECONDS: 25,
    ADMIN_WS_BACKLOG_LIMIT: 200,
    ...(overrides as object),
  } as Env;
}

describe('GET /admin/ws/info', () => {
  let app: FastifyInstance;
  afterAll(async () => {
    await app?.close?.();
  });

  it('returns disabled state when ADMIN_WS_ENABLED is false', async () => {
    app = await buildApp(fakeEnv());
    const res = await app.inject({ method: 'GET', url: '/admin/ws/info' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      status: string;
      enabled: boolean;
      url: string | null;
      heartbeat_seconds: number;
    };
    expect(body.status).toBe('ok');
    expect(body.enabled).toBe(false);
    expect(body.url).toBeNull();
    expect(body.heartbeat_seconds).toBeGreaterThanOrEqual(5);
  });

  it('returns wss:// URL when ADMIN_WS_PUBLIC_URL is set', async () => {
    app = await buildApp(
      fakeEnv({
        ADMIN_WS_ENABLED: true,
        ADMIN_WS_PUBLIC_URL: 'wss://orch.example.com/admin/ws',
      } as Partial<Env>),
    );
    const res = await app.inject({ method: 'GET', url: '/admin/ws/info' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { status: string; url: string; enabled: boolean };
    expect(body.enabled).toBe(true);
    expect(body.url).toBe('wss://orch.example.com/admin/ws');
  });
});
