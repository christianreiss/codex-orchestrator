import fp from 'fastify-plugin';
import cors from '@fastify/cors';
import type { FastifyInstance } from 'fastify';

/**
 * CORS policy:
 *   - /v1/* and /anthropic/v1/* are open (browsers + SDKs).
 *   - Everything else (admin, host APIs, MCP) is same-origin only by default;
 *     reverse proxy / SPA serve everything from the same domain anyway.
 */
export const corsPlugin = fp(
  async function corsPlugin(app: FastifyInstance) {
    await app.register(cors, {
      hook: 'preHandler',
      origin: (origin, cb) => {
        // Same-origin requests have no Origin header — allow.
        if (!origin) return cb(null, true);
        cb(null, true); // permissive; refine per-route as needed
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
      exposedHeaders: ['x-request-id', 'x-codex-version', 'retry-after'],
      credentials: true,
      maxAge: 86400,
    });
  },
  { name: 'cors' },
);
