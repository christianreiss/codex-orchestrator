import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
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

/** The `/admin` URL a SvelteKit route directory serves, `[param]`s filled in. */
function pageUrl(segments: string[]): string {
  const path = segments
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
  const app = Fastify({ logger: false, ignoreTrailingSlash: true, caseSensitive: true });
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
  await registerStaticAdminRoutes(app, ctx);

  await app.ready();
  return app;
}

describe('admin SPA navigation collisions', () => {
  let app: FastifyInstance;
  let root: string;

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'codex-admin-spa-'));
    writeFileSync(join(root, 'index.html'), '<!doctype html><title>Codex Admin</title>');
    app = await buildAdminSpaApp(root);
  });

  afterAll(async () => {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  });

  const urls = spaPageUrls(FRONTEND_ROUTES);

  it('derives the page list from the frontend routes', () => {
    // Guard against a silently empty walk (moved directory, renamed page file)
    // turning the per-URL checks below into a no-op.
    expect(urls.length).toBeGreaterThan(20);
    expect(urls).toContain('/admin');
    expect(urls).toContain('/admin/hosts');
  });

  it.each(urls)('serves the SPA shell for browser navigation to %s', async (url) => {
    const res = await app.inject({ method: 'GET', url, headers: { accept: HTML_NAVIGATION } });

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
});
