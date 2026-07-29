import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { corsPlugin } from '../../../src/http/plugins/cors.js';
import { selectFormatter, type EnvelopeKind } from '../../../src/http/envelope/select.js';
import { registerOpenAiCompatRoutes } from '../../../src/routes/v1/index.js';
import { registerAnthropicCompatRoutes } from '../../../src/routes/anthropic-v1/index.js';
import { loadTestEnv } from '../../helpers/test-keyring.js';

/**
 * Both proxy families are wired to their provider wire format by URL prefix
 * alone: selectFormatter matches on the prefix, and cors.ts keeps a parallel
 * list of the prefixes that get the open cross-site treatment. Neither list is
 * checked against the routes that actually get registered, so a mount they do
 * not cover — a bare `/anthropic/v1`, say, which selectFormatter's anthropic
 * branch misses because it demands the trailing slash the openai branch
 * special-cases — would answer with standard-envelope error bodies and drop out
 * of the open-CORS surface. No per-endpoint suite would notice, because they
 * all exercise a path they named themselves.
 *
 * So this suite names no path either: it reads Fastify's own route table via
 * the onRoute hook and demands that every entry land in its family's envelope
 * and under an open-CORS prefix.
 */

/**
 * cors.ts keeps OPEN_PATH_PREFIXES module-private, so the list is mirrored here
 * and pinned to the plugin's real behaviour below — a prefix that stops being
 * open upstream fails the reflection check rather than passing on the mirror.
 */
const OPEN_PATH_PREFIXES = ['/v1/', '/anthropic/v1/'];

/** In nobody's allow-list: only the open prefixes reflect it back. */
const UNLISTED_ORIGIN = 'https://evil.example';

interface RegisteredRoute {
  method: string;
  url: string;
}

/**
 * The envelope a route's prefix obliges it to use. Matched without the trailing
 * slash on purpose: a route mounted at the bare `/v1` or `/anthropic/v1` is
 * still that family's public surface and has to be enveloped as such.
 */
function family(url: string): EnvelopeKind | null {
  if (url.startsWith('/anthropic/v1')) return 'anthropic';
  if (url.startsWith('/v1')) return 'openai';
  return null;
}

/** Fill `:param` / `*` placeholders — the CORS delegator reads the prefix only. */
function probeUrl(url: string): string {
  return url.replace(/:[^/]+/g, 'probe').replace(/\*/g, 'probe');
}

/**
 * Mount both route groups on a bare app and record what Fastify registered.
 * Nothing here answers a request, so the services the registrars build for
 * themselves never dereference the empty ctx.
 */
async function captureRoutes(): Promise<RegisteredRoute[]> {
  const app = Fastify({ logger: false });
  const routes: RegisteredRoute[] = [];

  // Registered before anything mounts a route so nothing can be missed. This is
  // the app's own table, including the HEAD routes Fastify derives from GET.
  app.addHook('onRoute', (route) => {
    const methods = Array.isArray(route.method) ? route.method : [route.method];
    for (const method of methods) routes.push({ method, url: route.url });
  });

  const ctx = { db: {} as never, env: {} as never, keyring: {} as never };
  await registerOpenAiCompatRoutes(app, ctx);
  await registerAnthropicCompatRoutes(app, ctx);

  await app.ready();
  await app.close();
  return routes;
}

/**
 * The real CORS plugin with an empty allow-list, so the only thing that can
 * reflect UNLISTED_ORIGIN is the open-prefix branch. The delegator decides on
 * `req.url` alone, so one catch-all stands in for every captured route.
 */
async function buildCorsProbe(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  app.decorate('env', { ...loadTestEnv(), CORS_ALLOWED_ORIGINS: '' });
  await app.register(corsPlugin);
  app.get('/*', async () => ({ ok: true }));
  await app.ready();
  return app;
}

describe('envelope + CORS family of every registered proxy route', () => {
  let routes: RegisteredRoute[];
  let cors: FastifyInstance;

  beforeAll(async () => {
    routes = await captureRoutes();
    cors = await buildCorsProbe();
  });

  afterAll(async () => {
    await cors.close();
  });

  it('mounts routes in both proxy families and nowhere else', () => {
    expect(routes.length).toBeGreaterThan(0);
    // A route outside both families would silently opt out of every assertion
    // below, since they are all keyed off the family.
    expect(routes.filter((r) => family(r.url) === null)).toEqual([]);
    // Both registrars really contributed, so a dropped one cannot leave the
    // rest of this suite trivially green.
    expect(routes.some((r) => family(r.url) === 'openai')).toBe(true);
    expect(routes.some((r) => family(r.url) === 'anthropic')).toBe(true);
  });

  it('resolves every route to its own provider envelope', () => {
    const observed = routes.map((r) => `${r.method} ${r.url} -> ${selectFormatter(r.url).kind}`);
    expect(observed).toEqual(routes.map((r) => `${r.method} ${r.url} -> ${family(r.url)}`));
  });

  it('keeps every route under an open-CORS prefix', async () => {
    for (const route of routes) {
      expect(
        OPEN_PATH_PREFIXES.some((prefix) => route.url.startsWith(prefix)),
        `${route.method} ${route.url}`,
      ).toBe(true);
    }

    // ...and the mirrored prefixes are the ones cors.ts still treats as open.
    for (const url of new Set(routes.map((r) => probeUrl(r.url)))) {
      const res = await cors.inject({ method: 'GET', url, headers: { origin: UNLISTED_ORIGIN } });
      expect(res.headers['access-control-allow-origin'], url).toBe(UNLISTED_ORIGIN);
    }
  });
});
