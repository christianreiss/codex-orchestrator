import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { envelopePlugin } from '../../src/http/plugins/envelope.js';
import { UnauthorizedError } from '../../src/http/errors.js';
import type { RouteContext } from '../../src/routes/index.js';
import { adminSpaHtmlPreHandler } from '../../src/routes/admin/pages/static.js';
import { registerAdminProjectsRoutes } from '../../src/routes/admin/projects/index.js';

describe('admin SPA navigation collisions', () => {
  let app: FastifyInstance;
  let root: string;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'codex-admin-spa-'));
    writeFileSync(join(root, 'index.html'), '<!doctype html><title>Codex Admin</title>');
    app = Fastify({ logger: false });
    await app.register(envelopePlugin);
    app.decorate('requireAdmin', async () => {
      throw new UnauthorizedError('Admin session required', 'admin_required');
    });
    const ctx = { env: { STATIC_ROOT: root } } as RouteContext;
    const adminSpa = adminSpaHtmlPreHandler(ctx);
    app.get('/admin/hosts', { preHandler: [adminSpa, app.requireAdmin] }, async () => ({ hosts: [] }));
    await registerAdminProjectsRoutes(app, {
      ...ctx,
      db: {} as RouteContext['db'],
      keyring: {} as RouteContext['keyring'],
    });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('serves the SPA shell for browser navigation to a colliding admin URL', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/admin/hosts',
      headers: { accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.payload).toContain('Codex Admin');
  });

  it('keeps the JSON API contract when the client asks for JSON', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/admin/hosts',
      headers: { accept: 'application/json' },
    });

    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.payload)).toMatchObject({
      status: 'error',
      code: 'admin_required',
    });
  });

  it.each([
    '/admin/projects/example/notes',
    '/admin/projects/example/todos',
    '/admin/projects/example/files',
    '/admin/projects/example/feedback',
  ])('serves the SPA shell for project sub-route navigation to %s', async (url) => {
    const res = await app.inject({
      method: 'GET',
      url,
      headers: { accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.payload).toContain('Codex Admin');
  });
});
