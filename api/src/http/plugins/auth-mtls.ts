import fp from 'fastify-plugin';
import type { FastifyInstance } from 'fastify';
import { parseMtls, type MtlsClaims } from '../../security/mtls.js';

declare module 'fastify' {
  interface FastifyRequest {
    mtls: MtlsClaims;
  }
}

export const authMtlsPlugin = fp(
  async function authMtlsPlugin(app: FastifyInstance) {
    app.decorateRequest('mtls', null as unknown as MtlsClaims);
    app.addHook('onRequest', async (req) => {
      req.mtls = parseMtls(req);
    });
  },
  { name: 'auth-mtls' },
);
