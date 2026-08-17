/**
 * The gate that makes the capability layer default-deny rather than
 * best-effort.
 *
 * Every other test here asserts that a *known* route enforces a *known*
 * capability. None of them can see the route nobody thought about — the new
 * `POST /admin/…/rotate` that ships with `preHandler: app.requireAdmin` and is
 * therefore open to every `viewer` on the installation. That was the shape of
 * the pre-existing hole: authorization by remembering, on a tree of 300 routes.
 *
 * So this boots the real route tree — the same `registerAllRoutes` the server
 * calls, against a fake database — and fails when any route under a governed
 * prefix has no entry in the inventory. The plugin performs the same check at
 * `onReady`, which means a missing entry is a refusal to start and not just a
 * red CI run; this test is here so the refusal is discovered in CI rather than
 * on the first deploy.
 */

import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import { afterEach, describe, expect, it } from 'vitest';
import { envelopePlugin } from '../../../src/http/plugins/envelope.js';
import { requestIdPlugin } from '../../../src/http/plugins/request-id.js';
import { makeCapabilitiesPlugin } from '../../../src/http/plugins/capabilities.js';
import { registerAllRoutes } from '../../../src/routes/index.js';
import { isCapability } from '../../../src/security/capabilities.js';
import {
  ROUTE_CAPABILITIES,
  guardForRoute,
  isGovernedRoute,
  routeKey,
} from '../../../src/security/route-capabilities.js';
import { createDbFake } from '../../helpers/db-fake.js';
import { loadTestEnv, testKeyring } from '../../helpers/test-keyring.js';

interface Registered {
  method: string;
  url: string;
}

const apps: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

const HERE = dirname(fileURLToPath(import.meta.url));
/** The committed admin bundle, so the static mount registers its wildcard. */
const STATIC_ROOT = resolve(HERE, '../../../../public/admin');

/**
 * Boots the whole tree and returns every route it registered. Auth is stubbed
 * at the plugin boundary rather than skipped: the capabilities plugin declares
 * `auth-admin` as a dependency, and registering it against a stand-in is what
 * proves that dependency is satisfiable without a database.
 */
async function registeredRoutes(staticRoot = ''): Promise<Registered[]> {
  const routes: Registered[] = [];
  const app = Fastify({ logger: false });
  apps.push(app);
  await app.register(cookie);
  await app.register(multipart);
  await app.register(requestIdPlugin);
  await app.register(
    fp(
      async (instance: FastifyInstance) => {
        instance.decorate('resolveAdmin', async () => null);
        instance.decorate('requireAdmin', async () => {});
        instance.decorate('requireHost', async () => {});
        instance.decorate('requireMtls', async () => {});
      },
      { name: 'auth-admin' },
    ),
  );
  await app.register(makeCapabilitiesPlugin());
  await app.register(envelopePlugin);

  app.addHook('onRoute', (route) => {
    for (const method of Array.isArray(route.method) ? route.method : [route.method]) {
      routes.push({ method, url: route.url });
    }
  });

  await registerAllRoutes(app, {
    db: createDbFake() as never,
    env: { ...loadTestEnv(), STATIC_ROOT: staticRoot } as never,
    keyring: testKeyring(),
  });
  await app.ready();
  return routes;
}

/**
 * The pre-authentication surface, pinned. Everything here is reachable with no
 * session, so each entry is a decision rather than an omission: adding a route
 * to this list is the reviewable act, and a route that drifts into it without
 * one fails.
 */
const EXPECTED_PUBLIC = [
  'GET /admin/*',
  'GET /admin/auth/status',
  'POST /admin/auth/login',
  'POST /admin/auth/login/method',
  'POST /admin/auth/passkey/login',
  'POST /admin/auth/passkey/login/options',
  'POST /admin/auth/password/request',
  'POST /admin/auth/password/reset',
  'GET /cli/auth/verify',
  'POST /cli/auth/poll/:id',
  'POST /cli/auth/start',
].sort();

describe('route capability coverage', () => {
  it('boots the whole route tree and finds routes to check', async () => {
    const routes = await registeredRoutes();
    // A boot that registered nothing would pass every assertion below.
    expect(routes.length).toBeGreaterThan(400);
    expect(routes.filter((r) => isGovernedRoute(r.url)).length).toBeGreaterThan(250);
  });

  it('assigns a capability to every route under a governed prefix', async () => {
    const routes = await registeredRoutes();
    const ungoverned = routes
      .filter((route) => isGovernedRoute(route.url))
      .filter((route) => guardForRoute(route.method, route.url) === undefined)
      .map((route) => routeKey(route.method, route.url));
    expect(
      [...new Set(ungoverned)].sort(),
      'assign each one a capability in src/security/route-capabilities.ts, ' +
        'or an explicit public entry with the reason it has to be reachable unauthenticated',
    ).toEqual([]);
  });

  it('carries no inventory entry for a route that is no longer registered', async () => {
    // Booted *with* the committed bundle, so the static mount registers its
    // wildcard for real. Hard-coding that one key instead would mean the
    // inventory keeps a dead entry, and this test keeps passing, the day the
    // mount's pattern changes.
    expect(existsSync(STATIC_ROOT), `no admin bundle at ${STATIC_ROOT}`).toBe(true);
    const routes = await registeredRoutes(STATIC_ROOT);
    const live = new Set(routes.map((route) => routeKey(route.method, route.url)));
    expect(live, 'the static mount did not register its wildcard').toContain('GET /admin/*');
    const stale = Object.keys(ROUTE_CAPABILITIES).filter((key) => !live.has(key));
    expect(stale, 'delete the entry, or restore the route it grants').toEqual([]);
  });

  it('opens exactly the pre-authentication surface and no more', async () => {
    const routes = await registeredRoutes(STATIC_ROOT);
    const seen = new Set<string>();
    const publicRoutes: string[] = [];
    for (const route of routes) {
      if (!isGovernedRoute(route.url)) continue;
      const key = routeKey(route.method, route.url);
      if (seen.has(key)) continue;
      seen.add(key);
      if (guardForRoute(route.method, route.url)?.kind === 'public') publicRoutes.push(key);
    }
    expect(publicRoutes.sort()).toEqual(EXPECTED_PUBLIC);
  });

  it('names only capabilities that exist', () => {
    const unknown = Object.entries(ROUTE_CAPABILITIES)
      .filter(([, guard]) => guard.kind !== 'public' && !isCapability(guard.capability))
      .map(([key]) => key);
    expect(unknown).toEqual([]);
  });

  it('refuses to start when a governed route has no entry', async () => {
    const app = Fastify({ logger: false });
    apps.push(app);
    await app.register(requestIdPlugin);
    await app.register(
      fp(
        async (instance: FastifyInstance) => {
          instance.decorate('resolveAdmin', async () => null);
          instance.decorate('requireAdmin', async () => {});
        },
        { name: 'auth-admin' },
      ),
    );
    await app.register(makeCapabilitiesPlugin());
    app.post('/admin/brand-new-thing', async () => ({ ok: true }));

    await expect(app.ready()).rejects.toThrow(/POST \/admin\/brand-new-thing/);
  });
});
