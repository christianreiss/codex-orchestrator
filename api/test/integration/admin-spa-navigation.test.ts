import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { envelopePlugin } from '../../src/http/plugins/envelope.js';
import { UnauthorizedError } from '../../src/http/errors.js';
import type { RouteContext } from '../../src/routes/index.js';
import { registerStaticAdminRoutes } from '../../src/routes/admin/pages/static.js';
import { registerAdminAuthAndUsersRoutes } from '../../src/routes/admin-auth-users/index.js';
import { registerAdminHostsRoutes } from '../../src/routes/admin/hosts/index.js';
import { registerAdminOverviewSettingsRoutes } from '../../src/routes/admin-overview-settings/index.js';
import { registerAdminContentRoutes } from '../../src/routes/admin-content/index.js';
import { registerAdminMemoriesRoutes } from '../../src/routes/admin/memories/index.js';
import { registerAdminManualRoutes } from '../../src/routes/admin/manual/index.js';
import { registerExternalClientRoutes } from '../../src/routes/external/index.js';
import { registerAdminTopologyRoutes } from '../../src/routes/admin/topology/index.js';
import { loadTestEnv, testKeyring } from '../helpers/test-keyring.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const FRONTEND_ROUTES = resolve(HERE, '../../../frontend/src/routes');
const HTML_NAVIGATION = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8';

/**
 * Value substituted for a `[param]` segment. Deliberately not a word any
 * admin JSON route uses as a literal segment, so the derived URL exercises
 * the page's own path rather than accidentally hitting a sibling endpoint.
 */
const PARAM_SAMPLE = 'spa-nav-sample';

/**
 * The `/admin` URL a SvelteKit route directory serves, `[param]`s filled in.
 * `(group)` directories are layout-only and add no URL segment.
 */
function pageUrl(segments: string[]): string {
  const path = segments
    .filter((segment) => !/^\(.*\)$/.test(segment))
    .map((segment) => (segment.startsWith('[') ? PARAM_SAMPLE : segment))
    .join('/');
  return path ? `/admin/${path}` : '/admin';
}

/**
 * Every page the SPA ships, read off `frontend/src/routes/**\/+page.svelte`.
 * Deriving the list rather than pinning it means a page added under a path
 * that an admin JSON GET already owns fails here instead of silently losing
 * deep-link and refresh for that page.
 */
function spaPageUrls(dir: string, segments: string[] = []): string[] {
  const urls: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      urls.push(...spaPageUrls(join(dir, entry.name), [...segments, entry.name]));
    } else if (entry.name === '+page.svelte') {
      urls.push(pageUrl(segments));
    }
  }
  return urls;
}

/**
 * The admin surface as `routes/index.ts` mounts it: every JSON route tree
 * first, the static SPA mount last. Auth is stubbed to reject, which is what
 * an unauthenticated browser navigation looks like.
 */
async function buildAdminSpaApp(root: string): Promise<FastifyInstance> {
  const app = Fastify({ logger: false, routerOptions: { ignoreTrailingSlash: true, caseSensitive: true } });
  const ctx: RouteContext = {
    db: {} as RouteContext['db'],
    env: { ...loadTestEnv(), STATIC_ROOT: root },
    keyring: testKeyring(),
  };

  await app.register(cookie);
  await app.register(envelopePlugin);
  app.decorate('db', ctx.db);
  app.decorate('env', ctx.env);
  app.decorate('resolveAdmin', async () => null);
  app.decorate('requireAdmin', async () => {
    throw new UnauthorizedError('Admin session required', 'admin_required');
  });
  await registerAdminAuthAndUsersRoutes(app, ctx);
  await registerAdminHostsRoutes(app, ctx);
  await registerAdminOverviewSettingsRoutes(app, ctx);
  await registerAdminContentRoutes(app, ctx);
  await registerAdminMemoriesRoutes(app, ctx);
  await registerAdminManualRoutes(app, ctx);
  await registerAdminTopologyRoutes(app, ctx);
  await registerExternalClientRoutes(app, ctx);
  await registerStaticAdminRoutes(app, ctx);

  await app.ready();
  return app;
}

describe('admin SPA navigation collisions', () => {
  let app: FastifyInstance;
  let root: string;

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'codex-admin-spa-'));
    mkdirSync(join(root, '_app'));
    writeFileSync(join(root, '_app/version.json'), '{ "version": "fixture" }\n');
    writeFileSync(join(root, 'index.html'), '<!doctype html><title>Codex Admin</title>');
    app = await buildAdminSpaApp(root);
  });

  it('serves the exact SvelteKit version manifest used for error recovery', async () => {
    const response = await app.inject('/admin/_app/version.json');
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toMatch(/application\/json/);
    expect(response.body).toBe('{ "version": "fixture" }\n');
  });

  afterAll(async () => {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  });

  // The catch-all source cannot express the concrete bookmarked audit-log URL.
  const urls = [...spaPageUrls(FRONTEND_ROUTES), '/admin/logs'];

  it('derives the page list from the frontend routes', () => {
    // Guard against a silently empty walk (moved directory, renamed page file)
    // turning the per-URL checks below into a no-op.
    expect(urls.length).toBeGreaterThan(20);
    expect(urls).toContain('/admin');
    expect(urls).toContain('/admin/hosts');
    // The agents page shares its path with the legacy agents-document API.
    expect(urls).toContain('/admin/agents');
  });

  it.each(urls)('serves the SPA shell for browser navigation to %s', async (url) => {
    const res = await app.inject({ method: 'GET', url, headers: { accept: HTML_NAVIGATION } });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.payload).toContain('Codex Admin');
  });

  it('serves HEAD navigation without leaking the policy JSON', async () => {
    const res = await app.inject({ method: 'HEAD', url: '/admin/agents', headers: { accept: HTML_NAVIGATION } });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.payload).toBe('');
    expect(String(res.headers.vary).toLowerCase().split(/, */)).toContain('accept');
  });

  it('keeps JSON authentication when JSON precedes HTML in Accept', async () => {
    const res = await app.inject({ method: 'GET', url: '/admin/agents', headers: { accept: 'application/json, text/html' } });
    expect(res.statusCode).toBe(401);
    expect(res.headers['content-type']).toContain('application/json');
  });

  it.each([
    ['text/html;q=0, */*', 401],
    ['text/html;q=0.2, application/json;q=0.9', 401],
    ['application/json;q=0.2, text/html;q=0.9', 200],
    ['TEXT/HTML', 200],
    ['text/html-extra', 401],
    ['*/*', 401],
  ] as const)('negotiates an explicit navigation preference for %s', async (accept, status) => {
    const response = await app.inject({ method: 'GET', url: '/admin/agents', headers: { accept } });
    expect(response.statusCode).toBe(status);
    expect(response.headers['content-type']).toContain(status === 200 ? 'text/html' : 'application/json');
  });

  it('keeps the HTML fallback within the admin mount and honours a rejected HTML type', async () => {
    for (const [url, accept] of [['/administrator', 'text/html'], ['/admin/missing-page', 'text/html;q=0']]) {
      const response = await app.inject({ method: 'GET', url, headers: { accept } });
      expect(response.statusCode).toBe(404);
      expect(response.payload).not.toContain('Codex Admin');
    }
  });

  it.each(['GET', 'HEAD'] as const)('serves the graph deep link on %s navigation', async method => {
    const res = await app.inject({ method, url: '/admin/agents?view=graph', headers: { accept: HTML_NAVIGATION } });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
  });

  it.each(['/admin/hosts', '/admin/hosts/', '/admin/agents', '/admin/agents?view=graph', '/admin/logs', '/admin/external-clients'])('keeps JSON authentication for %s', async (url) => {
    const res = await app.inject({
      method: 'GET',
      url,
      headers: { accept: 'application/json' },
    });

    expect(res.statusCode).toBe(401);
    expect(String(res.headers.vary).toLowerCase().split(/, */)).toContain('accept');
    expect(JSON.parse(res.payload)).toMatchObject({
      status: 'error',
      code: 'admin_required',
    });
  });
});
