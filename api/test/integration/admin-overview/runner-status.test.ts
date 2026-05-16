import { describe, it, expect, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import { envelopePlugin } from '../../../src/http/plugins/envelope.js';
import { requestIdPlugin } from '../../../src/http/plugins/request-id.js';
import { registerAdminOverviewRoutes } from '../../../src/routes/admin/overview/index.js';
import type { Env } from '../../../src/env.js';
import type { RouteContext } from '../../../src/routes/index.js';

async function buildApp(env: Env): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(cookie);
  await app.register(requestIdPlugin);
  await app.register(envelopePlugin);
  app.decorate('requireAdmin', async () => undefined);
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

describe('runner endpoints', () => {
  let app: FastifyInstance;
  afterEach(async () => {
    await app?.close?.();
  });

  it('GET /admin/runner reports configured=false when AUTH_RUNNER_URL is unset', async () => {
    app = await buildApp({ ADMIN_WS_ENABLED: false } as Env);
    const res = await app.inject({ method: 'GET', url: '/admin/runner' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      status: string;
      runner: { configured: boolean; ready: boolean };
    };
    expect(body.status).toBe('ok');
    expect(body.runner.configured).toBe(false);
    expect(body.runner.ready).toBe(false);
  });

  it('POST /admin/runner/run returns 503 with runner_not_wired code', async () => {
    app = await buildApp({ ADMIN_WS_ENABLED: false } as Env);
    const res = await app.inject({
      method: 'POST',
      url: '/admin/runner/run',
      payload: { prompt: 'hi' },
      headers: { 'content-type': 'application/json' },
    });
    expect(res.statusCode).toBe(503);
    const body = res.json() as { status: string; message: string; code?: string };
    expect(body.status).toBe('error');
    expect(body.code ?? body.message).toContain('runner_not_wired');
  });
});
