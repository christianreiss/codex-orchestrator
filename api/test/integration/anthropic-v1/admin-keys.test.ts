import { describe, it, expect } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import { envelopePlugin } from '../../../src/http/plugins/envelope.js';
import { requestIdPlugin } from '../../../src/http/plugins/request-id.js';

/**
 * Smoke tests for /admin/claude/keys/*. We exercise the route registration
 * itself — assert that the routes are mounted, gated behind requireAdmin,
 * and respond with the standard envelope.
 *
 * Full DB-backed coverage of the service lives elsewhere (contract suite).
 */

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(cookie);
  await app.register(requestIdPlugin);
  await app.register(envelopePlugin);

  // Stub the admin auth plugin contract.
  app.decorate('requireAdmin', async function requireAdmin() {
    throw new (
      await import('../../../src/http/errors.js')
    ).UnauthorizedError('Admin session required', 'admin_required');
  });
  app.decorate('resolveAdmin', async () => null);

  const { registerAdminClaudeKeyRoutes } = await import(
    '../../../src/routes/admin/keys/claude.js'
  );
  await registerAdminClaudeKeyRoutes(app, {
    db: {} as never,
    env: {} as never,
    keyring: {} as never,
  });
  return app;
}

describe('admin claude key routes are protected', () => {
  it('GET /admin/claude/keys requires admin (401 standard envelope)', async () => {
    const app = await buildApp();
    const r = await app.inject({ method: 'GET', url: '/admin/claude/keys' });
    expect(r.statusCode).toBe(401);
    const body = JSON.parse(r.payload);
    expect(body).toMatchObject({ status: 'error', code: 'admin_required' });
    await app.close();
  });

  it('POST /admin/claude/keys requires admin', async () => {
    const app = await buildApp();
    const r = await app.inject({
      method: 'POST',
      url: '/admin/claude/keys',
      payload: { name: 'x' },
    });
    expect(r.statusCode).toBe(401);
    await app.close();
  });

  it('POST /admin/claude/keys/:id/toggle requires admin', async () => {
    const app = await buildApp();
    const r = await app.inject({
      method: 'POST',
      url: '/admin/claude/keys/1/toggle',
      payload: { active: true },
    });
    expect(r.statusCode).toBe(401);
    await app.close();
  });

  it('DELETE /admin/claude/keys/:id requires admin', async () => {
    const app = await buildApp();
    const r = await app.inject({ method: 'DELETE', url: '/admin/claude/keys/1' });
    expect(r.statusCode).toBe(401);
    await app.close();
  });
});
