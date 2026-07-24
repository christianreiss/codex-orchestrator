import fp from 'fastify-plugin';
import cors from '@fastify/cors';
import type { FastifyInstance, FastifyRequest } from 'fastify';

/**
 * CORS policy:
 *   - /v1/* and /anthropic/v1/* are open (browsers + SDKs).
 *   - Everything else (admin, host APIs, MCP) is same-origin only by default;
 *     reverse proxy / SPA serve everything from the same domain anyway.
 *     Cross-site credentialed access to those routes is only granted to
 *     origins listed in CORS_ALLOWED_ORIGINS (comma-separated) — an empty
 *     list (the default) means no cross-site origin is reflected and same-
 *     origin callers (no Origin header) still work as before.
 *
 * A delegator is used (rather than a static `origin` function) because it is
 * the only @fastify/cors hook that receives the request, so the open/
 * same-origin-only split can also cover CORS preflight (OPTIONS) requests,
 * which are always dispatched through @fastify/cors's single catch-all
 * OPTIONS route rather than the matched route.
 */
const OPEN_PATH_PREFIXES = ['/v1/', '/anthropic/v1/'];

function isOpenRoute(url: string): boolean {
  return OPEN_PATH_PREFIXES.some((prefix) => url.startsWith(prefix));
}

export const corsPlugin = fp(
  async function corsPlugin(app: FastifyInstance) {
    const allowedOrigins = app.env.CORS_ALLOWED_ORIGINS.split(',')
      .map((o) => o.trim())
      .filter(Boolean);

    await app.register(cors, {
      hook: 'preHandler',
      delegator: (req: FastifyRequest, cb) => {
        const open = isOpenRoute(req.url);
        cb(null, {
          origin: (origin, originCb) => {
            // Same-origin requests have no Origin header — allow.
            if (!origin) return originCb(null, true);
            // /v1 and /anthropic/v1 are the documented open public API surface.
            if (open) return originCb(null, true);
            originCb(null, allowedOrigins.includes(origin));
          },
          methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
          allowedHeaders: [
            'authorization',
            'content-type',
            'x-api-key',
            'x-mtls-fingerprint',
            'x-mtls-subject',
            'x-mtls-issuer',
            'x-request-id',
            'anthropic-version',
            'anthropic-beta',
            'openai-organization',
            'openai-project',
          ],
          exposedHeaders: [
            'x-request-id',
            // Anthropic SDKs read `request-id` (distinct from x-request-id) to
            // populate response._request_id — expose it for browser callers,
            // matching the already-exposed OpenAI x-request-id.
            'request-id',
            'anthropic-ratelimit-requests-limit',
            'anthropic-ratelimit-requests-remaining',
            'anthropic-ratelimit-requests-reset',
            'x-codex-version',
            'retry-after',
          ],
          credentials: true,
          maxAge: 86400,
        });
      },
    });
  },
  { name: 'cors' },
);
