import { describe, it, expect, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import { envelopePlugin } from '../../../src/http/plugins/envelope.js';
import { requestIdPlugin } from '../../../src/http/plugins/request-id.js';
import { registerAdminOverviewRoutes } from '../../../src/routes/admin/overview/index.js';
import { RunnerProxyService } from '../../../src/services/runner-proxy.js';
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

  it('POST /admin/runner/run reports unconfigured instead of the old not-wired stub', async () => {
    app = await buildApp({ ADMIN_WS_ENABLED: false } as Env);
    const res = await app.inject({
      method: 'POST',
      url: '/admin/runner/run',
      payload: { prompt: 'hi' },
      headers: { 'content-type': 'application/json' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { status: string; detail?: string; reachable?: boolean };
    expect(body.status).toBe('unconfigured');
    expect(body.detail).toContain('AUTH_RUNNER_URL');
    expect(body.reachable).toBe(false);
  });

  it('RunnerProxyService.status exposes Codex and Claude runner telemetry separately', async () => {
    const svc = new RunnerProxyService(
      {
        ADMIN_WS_ENABLED: false,
        AUTH_RUNNER_URL: 'http://runner:8080/verify',
        AUTH_RUNNER_SHARED_SECRET: 'secret',
      } as Env,
      undefined,
      {
        versionReader: async () =>
          new Map([
            ['runner_state', 'ok'],
            ['runner_last_check', '2026-06-05T07:00:00Z'],
            ['runner_last_ok', '2026-06-05T07:00:00Z'],
            ['runner_state_claude', 'fail'],
            ['runner_last_check_claude', '2026-06-05T07:05:00Z'],
            ['runner_last_fail_claude', '2026-06-05T07:05:00Z'],
          ]),
      },
    );

    const status = await svc.status();

    expect(status.state).toBe('fail');
    expect(status.engines?.codex.state).toBe('ok');
    expect(status.engines?.codex.last_run).toBe('2026-06-05T07:00:00Z');
    expect(status.engines?.claude.state).toBe('fail');
    expect(status.engines?.claude.last_run).toBe('2026-06-05T07:05:00Z');
    expect(status.engines?.claude.last_error).toContain('Claude runner failed');
  });
});
