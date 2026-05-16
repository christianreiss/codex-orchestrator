import fp from 'fastify-plugin';
import type { FastifyInstance } from 'fastify';
import { randomBytes } from 'node:crypto';

/**
 * Adds an X-Request-Id header (echoed back) and per-request `req.id`. If the
 * caller supplied one we honour it (length-limited); otherwise we generate.
 */
export const requestIdPlugin = fp(
  async function requestIdPlugin(app: FastifyInstance) {
    app.addHook('onRequest', async (req, reply) => {
      const incoming = req.headers['x-request-id'];
      const candidate = Array.isArray(incoming) ? incoming[0] : incoming;
      const id =
        candidate && /^[A-Za-z0-9._-]{1,128}$/.test(candidate)
          ? candidate
          : randomBytes(8).toString('hex');
      (req as { id: string }).id = id;
      reply.header('x-request-id', id);
    });
  },
  { name: 'request-id' },
);
