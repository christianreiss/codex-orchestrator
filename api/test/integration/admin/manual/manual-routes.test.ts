import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildRouteApp } from '../../../helpers/build-route-app.js';
import { registerAdminManualRoutes } from '../../../../src/routes/admin/manual/index.js';
import type { RouteContext } from '../../../../src/routes/index.js';

function makeCtx(root: string): RouteContext {
  return {
    db: {} as RouteContext['db'],
    env: { STATIC_ROOT: root } as RouteContext['env'],
    keyring: {} as RouteContext['keyring'],
  };
}

describe('admin/manual routes', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'manual-routes-'));
    mkdirSync(join(root, 'manual', 'articles'), { recursive: true });
    writeFileSync(
      join(root, 'manual', 'articles', 'welcome.md'),
      ['---', 'title: Welcome', 'category: Orientation', '---', 'Welcome to the manual.'].join('\n'),
    );
    writeFileSync(
      join(root, 'manual', 'articles', 'hosts.md'),
      ['---', 'title: Hosts', 'category: Operations', '---', 'Hosts are machines registered with the orchestrator.'].join('\n'),
    );
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('returns the manifest', async () => {
    const app = await buildRouteApp();
    await registerAdminManualRoutes(app, makeCtx(root));
    const r = await app.inject({ method: 'GET', url: '/admin/manual/manifest' });
    expect(r.statusCode).toBe(200);
    const body = JSON.parse(r.payload) as { status: string; articles: Array<{ slug: string }> };
    expect(body.status).toBe('ok');
    expect(body.articles.map((a) => a.slug).sort()).toEqual(['hosts', 'welcome']);
    await app.close();
  });

  it('returns search hits', async () => {
    const app = await buildRouteApp();
    await registerAdminManualRoutes(app, makeCtx(root));
    const r = await app.inject({ method: 'GET', url: '/admin/manual/search?q=hosts' });
    expect(r.statusCode).toBe(200);
    const body = JSON.parse(r.payload) as { hits: Array<{ slug: string; score: number }> };
    expect(body.hits.length).toBeGreaterThanOrEqual(1);
    expect(body.hits[0]?.slug).toBe('hosts');
    await app.close();
  });

  it('ranks the title hit above a body-only hit', async () => {
    const app = await buildRouteApp();
    await registerAdminManualRoutes(app, makeCtx(root));
    const r = await app.inject({ method: 'GET', url: '/admin/manual/search?q=orchestrator' });
    expect(r.statusCode).toBe(200);
    const body = JSON.parse(r.payload) as { hits: Array<{ slug: string }> };
    expect(body.hits.length).toBeGreaterThanOrEqual(1);
    expect(body.hits[0]?.slug).toBe('hosts');
    await app.close();
  });

  it('returns empty hits when q is blank', async () => {
    const app = await buildRouteApp();
    await registerAdminManualRoutes(app, makeCtx(root));
    const r = await app.inject({ method: 'GET', url: '/admin/manual/search?q=' });
    expect(r.statusCode).toBe(200);
    const body = JSON.parse(r.payload) as { hits: unknown[] };
    expect(body.hits).toEqual([]);
    await app.close();
  });

  it('returns the article body for a valid slug', async () => {
    const app = await buildRouteApp();
    await registerAdminManualRoutes(app, makeCtx(root));
    const r = await app.inject({ method: 'GET', url: '/admin/manual/article/welcome' });
    expect(r.statusCode).toBe(200);
    const body = JSON.parse(r.payload) as { slug: string; body: string };
    expect(body.slug).toBe('welcome');
    expect(body.body).toContain('Welcome to the manual');
    await app.close();
  });

  it('rejects an invalid slug with 422', async () => {
    const app = await buildRouteApp();
    await registerAdminManualRoutes(app, makeCtx(root));
    const r = await app.inject({ method: 'GET', url: '/admin/manual/article/BadSlug' });
    expect(r.statusCode).toBe(422);
    await app.close();
  });

  it('returns 404 for an unknown slug', async () => {
    const app = await buildRouteApp();
    await registerAdminManualRoutes(app, makeCtx(root));
    const r = await app.inject({ method: 'GET', url: '/admin/manual/article/missing' });
    expect(r.statusCode).toBe(404);
    await app.close();
  });
});
