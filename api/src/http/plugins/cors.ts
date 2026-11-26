import fp from 'fastify-plugin';
import cors from '@fastify/cors';
import type { FastifyInstance, FastifyRequest } from 'fastify';

/**
 * CORS policy:
 *   - /v1/*, /anthropic/v1/*, /grok/v1/* and /kimi/v1/* are open (browsers + SDKs).
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
const OPEN_PATH_PREFIXES = ['/v1/', '/anthropic/v1/', '/grok/v1/', '/kimi/v1/'];

/**
 * Rate-limit headers the upstream source passes through from OpenAI-compatible
 * providers (`x-ratelimit-*`) and Anthropic (`anthropic-ratelimit-*`), plus the
 * SDKs' retry hint, exposed by name to browser callers.
 */
const PROVIDER_QUOTA_HEADERS = [
  ...['limit', 'remaining', 'reset'].flatMap((kind) => ['requests', 'tokens'].map((unit) => `x-ratelimit-${kind}-${unit}`)),
  ...['requests', 'tokens', 'input-tokens', 'output-tokens'].flatMap((unit) =>
    ['limit', 'remaining', 'reset'].map((kind) => `anthropic-ratelimit-${unit}-${kind}`),
  ),
  'x-should-retry',
];

const RESTRICTED_ALLOWED_HEADERS = [
  'authorization',
  'content-type',
  'x-api-key',
  'x-request-id',
  'anthropic-version',
  'anthropic-beta',
  'openai-organization',
  'openai-project',
];

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
            // /v1, /anthropic/v1, /grok/v1 and /kimi/v1 are the documented open public API surface.
            if (open) return originCb(null, true);
            originCb(null, allowedOrigins.includes(origin));
          },
          methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
          // The open surface leaves allowedHeaders unset, so @fastify/cors
          // reflects the preflight's requested headers: provider SDKs in a
          // browser send a moving set of them (`x-stainless-*`,
          // `idempotency-key`, `openai-beta`,
          // `anthropic-dangerous-direct-browser-access`) and CORS has no prefix
          // wildcard. What reaches a provider is still decided by the upstream
          // header allowlist. The key must be absent, not undefined: the plugin
          // spreads these options over its defaults. Every other route keeps
          // the fixed list.
          ...(open ? {} : { allowedHeaders: RESTRICTED_ALLOWED_HEADERS }),
          exposedHeaders: [
            'x-request-id',
            // Anthropic SDKs read `request-id` (distinct from x-request-id) to
            // populate response._request_id — expose it for browser callers,
            // matching the already-exposed OpenAI x-request-id.
            'request-id',
            'x-codex-version',
            'retry-after',
            // Upstream source: provider retry hint and this gateway's own id
            // (the provider's request id replaces x-request-id there).
            'retry-after-ms',
            'x-gateway-request-id',
            // Upstream source: the provider's rate-limit headers, which the
            // forward passes through (CORS has no wildcard with credentials).
            ...PROVIDER_QUOTA_HEADERS,
          ],
          credentials: true,
          maxAge: 86400,
        });
      },
    });
  },
  { name: 'cors' },
);
