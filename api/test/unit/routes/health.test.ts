import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { registerHealthRoutes } from '../../../src/routes/health.js';

const context = { db: {}, env: {}, keyring: {} } as never;

describe('health and readiness routes', () => {
  it('keeps liveness green while critical infrastructure is incomplete', async () => {
    const app = Fastify();
    await registerHealthRoutes(app, context, async () => ({
      critical_complete: false,
      checks: [{ id: 'signer', label: 'Wrapper signer', ok: false, critical: true, detail: 'missing' }],
    }));

    const health = await app.inject({ method: 'GET', url: '/healthz' });
    const readiness = await app.inject({ method: 'GET', url: '/readyz' });
    expect(health.statusCode).toBe(200);
    expect(health.json()).toMatchObject({ ok: true });
    expect(readiness.statusCode).toBe(503);
    expect(readiness.json()).toMatchObject({ ok: false, checks: [{ id: 'signer', ok: false }] });
    await app.close();
  });

  it('releases readiness only when all critical checks complete', async () => {
    const app = Fastify();
    await registerHealthRoutes(app, context, async () => ({
      critical_complete: true,
      checks: [{ id: 'wrappers', label: 'Wrapper platform matrix', ok: true, critical: true, detail: '4 platforms' }],
    }));

    const readiness = await app.inject({ method: 'GET', url: '/readyz' });
    expect(readiness.statusCode).toBe(200);
    expect(readiness.json()).toMatchObject({ ok: true, checks: [{ id: 'wrappers', ok: true }] });
    await app.close();
  });
});
