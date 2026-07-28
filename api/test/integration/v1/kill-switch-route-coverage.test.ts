import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { envelopePlugin } from '../../../src/http/plugins/envelope.js';
import { requestIdPlugin } from '../../../src/http/plugins/request-id.js';
import { registerOpenAiCompatRoutes } from '../../../src/routes/v1/index.js';
import { registerAnthropicCompatRoutes } from '../../../src/routes/anthropic-v1/index.js';
import { ApiError } from '../../../src/http/errors.js';
import type { RateLimiter } from '../../../src/http/plugins/rate-limit.js';
import type { KillSwitch } from '../../../src/services/openai-kill-switch.js';
import type { ClaudeKillSwitch } from '../../../src/services/claude-kill-switch.js';

/**
 * Both proxy families advertise a blanket kill switch, but the hook is attached
 * per route by hand in routes/v1/index.ts and routes/anthropic-v1/index.ts. A
 * route registered without it would keep serving traffic while an operator
 * believes the API is off, and the per-endpoint suites would not notice because
 * they all stub the switch permanently on.
 *
 * So this suite never names a path: it reads Fastify's own route table via the
 * onRoute hook, removes the two CORS preflight wildcards, and demands a 503
 * from everything that is left.
 */

/**
 * The only routes allowed to answer while the switch is on. Both kill-switch
 * hooks skip OPTIONS by design so CORS preflight keeps working, and both
 * handlers 204 without reaching a backend. Nothing else belongs here.
 */
const PREFLIGHT_ALLOWLIST = new Set(['OPTIONS /v1/*', 'OPTIONS /anthropic/v1/*']);

interface RegisteredRoute {
  method: string;
  url: string;
}

function routeKey(route: RegisteredRoute): string {
  return `${route.method} ${route.url}`;
}

function guardedRoutes(routes: RegisteredRoute[]): RegisteredRoute[] {
  return routes.filter((route) => !PREFLIGHT_ALLOWLIST.has(routeKey(route)));
}

function disabledOpenAiKillSwitch(): KillSwitch {
  return {
    isDisabled: async () => true,
    throwIfDisabled: async () => {
      throw new ApiError('OpenAI API disabled by administrator', {
        status: 503,
        code: 'api_disabled',
        type: 'api_error',
      });
    },
  };
}

function disabledClaudeKillSwitch(): ClaudeKillSwitch {
  return {
    isDisabled: async () => true,
    ensureEnabled: async () => {
      throw new ApiError('Claude API is currently disabled by administrator', {
        status: 503,
        code: 'api_disabled',
        type: 'api_error',
      });
    },
    setDisabled: async () => undefined,
  };
}

/** Fill `:param` / `*` placeholders — the switch fires long before a handler
 * looks at them, so any value routes. */
function probeUrl(url: string): string {
  return url.replace(/:[^/]+/g, 'kill-switch-probe').replace(/\*/g, 'kill-switch-probe');
}

/**
 * Mount both route groups on a bare app with the switch reporting disabled, and
 * record what Fastify registered. The services the routes build for themselves
 * (key resolver, models, runner adapter) are all lazy against the empty ctx, so
 * only the switch needs an override.
 */
async function buildApp(): Promise<{ app: FastifyInstance; routes: RegisteredRoute[] }> {
  const app = Fastify({ logger: false });
  const routes: RegisteredRoute[] = [];

  // Registered before anything mounts a route so nothing can be missed. This is
  // the app's own table, including the HEAD routes Fastify derives from GET.
  app.addHook('onRoute', (route) => {
    const methods = Array.isArray(route.method) ? route.method : [route.method];
    for (const method of methods) routes.push({ method, url: route.url });
  });

  const rateLimiter: RateLimiter = {
    hit: async () => ({
      ok: true,
      count: 1,
      resetAt: new Date(Date.now() + 60_000).toISOString(),
    }),
  };
  app.decorate('rateLimiter', rateLimiter);
  app.decorateRequest('clientIp', '');
  app.addHook('onRequest', async (req) => {
    req.clientIp = '127.0.0.1';
  });

  await app.register(requestIdPlugin);
  await app.register(envelopePlugin);

  const ctx = { db: {} as never, env: {} as never, keyring: {} as never };
  await registerOpenAiCompatRoutes(app, ctx, { killSwitch: disabledOpenAiKillSwitch() });
  await registerAnthropicCompatRoutes(app, ctx, { killSwitch: disabledClaudeKillSwitch() });

  await app.ready();
  return { app, routes };
}

describe('kill-switch coverage across every registered proxy route', () => {
  let app: FastifyInstance;
  let routes: RegisteredRoute[];

  beforeAll(async () => {
    ({ app, routes } = await buildApp());
  });

  afterAll(async () => {
    await app.close();
  });

  it('leaves every non-OPTIONS proxy route to the kill switch', () => {
    const guarded = guardedRoutes(routes);
    expect(guarded.length).toBeGreaterThan(0);

    // A stale allowlist entry would silently exempt nothing (or, worse, a route
    // that was later renamed onto it), so both wildcards must really exist.
    expect(routes.map(routeKey)).toEqual(expect.arrayContaining([...PREFLIGHT_ALLOWLIST]));

    // ...and the allowlist may remove nothing beyond those two: what is left is
    // exactly every non-OPTIONS route the app declares.
    expect(guarded.map(routeKey).sort()).toEqual(
      routes
        .filter((route) => route.method !== 'OPTIONS')
        .map(routeKey)
        .sort(),
    );

    // Both families are mounted, so a registration that silently dropped one of
    // them cannot leave this suite trivially green.
    expect(guarded.every((r) => r.url.startsWith('/v1/') || r.url.startsWith('/anthropic/v1/'))).toBe(true);
    expect(guarded.some((r) => r.url.startsWith('/v1/'))).toBe(true);
    expect(guarded.some((r) => r.url.startsWith('/anthropic/v1/'))).toBe(true);

    // Every HEAD route is one Fastify cloned off a GET (preHandlers included),
    // which is what lets the probe below swap the verb. A hand-declared HEAD
    // route would have no twin and has to be probed on its own terms.
    const declared = new Set(routes.map(routeKey));
    for (const route of guarded.filter((r) => r.method === 'HEAD')) {
      expect(declared).toContain(`GET ${route.url}`);
    }
  });

  it('answers 503 api_disabled on every guarded route', async () => {
    const guarded = guardedRoutes(routes);

    const observed: string[] = [];
    for (const route of guarded) {
      // Probe the derived HEAD routes through their GET twin: an HTTP HEAD
      // response carries no body to read the error code out of.
      const method = route.method === 'HEAD' ? 'GET' : route.method;
      const res = await app.inject({
        method: method as 'GET' | 'POST',
        url: probeUrl(route.url),
        payload: method === 'GET' ? undefined : {},
      });
      const body = JSON.parse(res.payload) as { error?: { code?: string } };
      observed.push(`${routeKey(route)} -> ${res.statusCode} ${body.error?.code ?? '<no code>'}`);
    }

    expect(observed).toEqual(guarded.map((route) => `${routeKey(route)} -> 503 api_disabled`));
  });
});
