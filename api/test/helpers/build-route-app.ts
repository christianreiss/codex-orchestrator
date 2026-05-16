import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import { envelopePlugin } from '../../src/http/plugins/envelope.js';
import { requestIdPlugin } from '../../src/http/plugins/request-id.js';

/**
 * Lightweight Fastify app for route-level tests. Auth is short-circuited via
 * a no-op decoration; tests inject their own DB / keyring / env stubs.
 */
export async function buildRouteApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(cookie);
  await app.register(requestIdPlugin);
  await app.register(envelopePlugin);
  app.decorate('requireAdmin', async () => {});
  app.decorate('resolveAdmin', async () => null);
  return app;
}
