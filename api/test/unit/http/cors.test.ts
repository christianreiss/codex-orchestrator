import { describe, it, expect } from 'vitest';
import Fastify, { type FastifyInstance, type LightMyRequestResponse } from 'fastify';
import { corsPlugin } from '../../../src/http/plugins/cors.js';
import { loadTestEnv } from '../../helpers/test-keyring.js';

/**
 * The CORS delegator is the only cross-site gate in the tree: it reflects any
 * Origin on the public `/v1/*` and `/anthropic/v1/*` surface, but every other
 * route (admin, host APIs, MCP) may only be reflected back to an origin listed
 * in `CORS_ALLOWED_ORIGINS` — and all of it is sent with `credentials: true`,
 * so a widened prefix check or a leaked reflection hands a hostile page
 * credentialed admin access.
 */

const OPEN_ROUTES = ['/v1/messages', '/anthropic/v1/messages'];
/** Paths that merely start with the prefix *text* are not the open surface. */
const NEAR_MISS_ROUTES = ['/v1x/thing', '/anthropic/v1x/thing'];
const RESTRICTED_ROUTES = ['/admin/hosts', ...NEAR_MISS_ROUTES];

const LISTED = 'https://console.example.com';
const UNLISTED = 'https://evil.example';

async function buildProbe(allowedOrigins: string): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  app.decorate('env', { ...loadTestEnv(), CORS_ALLOWED_ORIGINS: allowedOrigins });
  await app.register(corsPlugin);
  for (const url of [...OPEN_ROUTES, ...RESTRICTED_ROUTES]) {
    app.get(url, async () => ({ ok: true }));
  }
  await app.ready();
  return app;
}

function get(app: FastifyInstance, url: string, origin?: string): Promise<LightMyRequestResponse> {
  return app.inject({ method: 'GET', url, headers: origin ? { origin } : {} });
}

/** A browser preflight: OPTIONS carrying Origin + Access-Control-Request-Method. */
function preflight(app: FastifyInstance, url: string, origin?: string): Promise<LightMyRequestResponse> {
  return app.inject({
    method: 'OPTIONS',
    url,
    headers: { ...(origin ? { origin } : {}), 'access-control-request-method': 'POST' },
  });
}

function allowOrigin(res: LightMyRequestResponse): string | undefined {
  return res.headers['access-control-allow-origin'] as string | undefined;
}

describe('cors origin policy', () => {
  it('lets same-origin (no Origin header) requests through everywhere', async () => {
    const app = await buildProbe('');
    for (const url of [...OPEN_ROUTES, ...RESTRICTED_ROUTES]) {
      const res = await get(app, url);
      expect(res.statusCode, url).toBe(200);
      // Nothing to reflect, so no grant is handed out either.
      expect(allowOrigin(res), url).toBeUndefined();

      // An OPTIONS without an Origin is not a preflight at all — it is turned
      // away as malformed rather than granted anything.
      const pre = await preflight(app, url);
      expect(pre.statusCode, url).toBe(400);
      expect(allowOrigin(pre), url).toBeUndefined();
    }
    await app.close();
  });

  it('reflects an arbitrary origin with credentials on the open prefixes', async () => {
    const app = await buildProbe('');
    for (const url of OPEN_ROUTES) {
      const res = await get(app, url, UNLISTED);
      expect(res.statusCode, url).toBe(200);
      expect(allowOrigin(res), url).toBe(UNLISTED);
      expect(res.headers['access-control-allow-credentials'], url).toBe('true');

      const pre = await preflight(app, url, UNLISTED);
      expect(pre.statusCode, url).toBe(204);
      expect(allowOrigin(pre), url).toBe(UNLISTED);
      expect(pre.headers['access-control-allow-credentials'], url).toBe('true');
    }
    await app.close();
  });

  it('does not reflect an unlisted origin on a non-open route', async () => {
    const app = await buildProbe(LISTED);
    for (const url of RESTRICTED_ROUTES) {
      // The request still runs (only a browser enforces CORS), but it is
      // handed no grant, so the response stays unreadable cross-site.
      const res = await get(app, url, UNLISTED);
      expect(res.statusCode, url).toBe(200);
      expect(allowOrigin(res), url).toBeUndefined();
      expect(res.headers['access-control-allow-credentials'], url).toBeUndefined();

      // A denied preflight is not answered at all by @fastify/cors.
      const pre = await preflight(app, url, UNLISTED);
      expect(pre.statusCode, url).toBe(404);
      expect(allowOrigin(pre), url).toBeUndefined();
    }
    await app.close();
  });

  it('reflects a listed origin on a non-open route', async () => {
    // Blank and empty entries in the list are ignored, not treated as origins.
    const app = await buildProbe(` ${LISTED} , , https://ops.example.com `);
    for (const url of RESTRICTED_ROUTES) {
      for (const origin of [LISTED, 'https://ops.example.com']) {
        const res = await get(app, url, origin);
        expect(res.statusCode, url).toBe(200);
        expect(allowOrigin(res), url).toBe(origin);
        expect(res.headers['access-control-allow-credentials'], url).toBe('true');

        const pre = await preflight(app, url, origin);
        expect(pre.statusCode, url).toBe(204);
        expect(allowOrigin(pre), url).toBe(origin);
        expect(pre.headers['access-control-allow-credentials'], url).toBe('true');
      }
    }
    await app.close();
  });

  it('treats a path that only starts with the prefix text as non-open', async () => {
    const app = await buildProbe('');
    // With an empty allowlist nothing outside `/v1/` and `/anthropic/v1/` may
    // be reflected — a prefix check that matched `/v1x` would say otherwise.
    for (const url of NEAR_MISS_ROUTES) {
      const res = await get(app, url, UNLISTED);
      expect(res.statusCode, url).toBe(200);
      expect(allowOrigin(res), url).toBeUndefined();

      const pre = await preflight(app, url, UNLISTED);
      expect(pre.statusCode, url).toBe(404);
      expect(allowOrigin(pre), url).toBeUndefined();
    }
    await app.close();
  });
});
