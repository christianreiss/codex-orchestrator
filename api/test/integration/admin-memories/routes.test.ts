import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { envelopePlugin } from '../../../src/http/plugins/envelope.js';
import { requestIdPlugin } from '../../../src/http/plugins/request-id.js';
import { ApiError } from '../../../src/http/errors.js';
import { registerAdminMemoriesRoutes } from '../../../src/routes/admin/memories/index.js';
import type { RouteContext } from '../../../src/routes/index.js';

const apps: Array<ReturnType<typeof Fastify>> = [];

async function buildApp(role: string | null) {
  const app = Fastify({ logger: false });
  apps.push(app);
  await app.register(requestIdPlugin);
  await app.register(envelopePlugin);
  app.decorate('requireAdmin', async (req: import('fastify').FastifyRequest) => {
    if (role === null) {
      throw new ApiError('Admin session required', {
        status: 401,
        code: 'admin_required',
        type: 'authentication_error',
      });
    }
    req.admin = {
      user: { id: 7, accessLevel: role, active: 1 } as never,
      session: { id: 1 } as never,
    };
  });
  app.decorate('resolveAdmin', async () => null);
  await registerAdminMemoriesRoutes(app, {
    db: {} as never,
    env: {} as never,
    keyring: {} as never,
  } as RouteContext);
  return app;
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe('admin memory lifecycle route guards', () => {
  it('requires an authenticated admin to read the graph', async () => {
    const app = await buildApp(null);
    const response = await app.inject({ method: 'GET', url: '/admin/memories/graph' });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ status: 'error', code: 'admin_required' });
  });

  it('allows viewers to read but rejects lifecycle mutations before touching the database', async () => {
    const app = await buildApp('viewer');
    const response = await app.inject({
      method: 'POST',
      url: '/admin/memories/host',
      payload: { id: 'note', host_id: 1, content: 'body' },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ status: 'error', code: 'admin_role_required' });
  });

  it('validates scope and record ids before querying storage', async () => {
    const app = await buildApp('owner');
    const badScope = await app.inject({ method: 'GET', url: '/admin/memories/fleet/1' });
    expect(badScope.statusCode).toBe(422);
    expect(badScope.json()).toMatchObject({ status: 'error', code: 'validation_failed' });

    const badId = await app.inject({ method: 'GET', url: '/admin/memories/host/nope' });
    expect(badId.statusCode).toBe(422);
    expect(badId.json()).toMatchObject({ status: 'error', code: 'validation_failed' });
  });

  it('keeps shared append content-only', async () => {
    const app = await buildApp('admin');
    const response = await app.inject({
      method: 'POST',
      url: '/admin/memories/shared/1/append',
      payload: { content: 'entry', tags: ['must-not-overwrite'] },
    });
    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({ status: 'error', code: 'validation_failed' });
  });
});
