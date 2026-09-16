import fp from 'fastify-plugin';
import type { FastifyInstance } from 'fastify';
import { randomBytes } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';

export function generateRequestId(req: { headers: IncomingHttpHeaders }): string {
  const incoming = req.headers['x-request-id'];
  const candidate = Array.isArray(incoming) ? incoming[0] : incoming;
  return candidate && /^[A-Za-z0-9._-]{1,128}$/.test(candidate)
    ? candidate
    : randomBytes(8).toString('hex');
}

/**
 * Adds an X-Request-Id header (echoed back) and per-request `req.id`. If the
 * caller supplied one we honour it (length-limited); otherwise we generate.
 */
export const requestIdPlugin = fp(
  async function requestIdPlugin(app: FastifyInstance) {
    app.addHook('onRequest', async (req, reply) => {
      const incoming = req.headers['x-request-id'];
      const candidate = Array.isArray(incoming) ? incoming[0] : incoming;
      // Reuse the id generated before Fastify bound its request logger. The
      // fallback also supports standalone users of this plugin.
      const id = candidate && /^[A-Za-z0-9._-]{1,128}$/.test(candidate)
        ? candidate
        : /^[0-9a-f]{16}$/.test(req.id) ? req.id : generateRequestId(req);
      req.id = id;
      reply.header('x-request-id', id);
    });
  },
  { name: 'request-id' },
);
