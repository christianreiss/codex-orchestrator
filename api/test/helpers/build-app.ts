import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import { envelopePlugin } from '../../src/http/plugins/envelope.js';
import { requestIdPlugin } from '../../src/http/plugins/request-id.js';

/**
 * Lightweight app for plugin-level integration tests. No DB, no static, no WS.
 */
export async function buildTestApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(cookie);
  await app.register(requestIdPlugin);
  await app.register(envelopePlugin);
  return app;
}
