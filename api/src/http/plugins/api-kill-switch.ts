import fp from 'fastify-plugin';
import type { FastifyInstance } from 'fastify';
import { ApiError } from '../errors.js';

/** Admit every HTTP surface consistently, before authentication or handlers. */
export function apiKillSwitch(disabled: () => Promise<boolean>) {
  return fp(async (app: FastifyInstance) => {
    app.addHook('onRequest', async (request) => {
      if (request.routeOptions.url === '/admin/api/state') return;
      if (await disabled()) throw new ApiError('API disabled by administrator', {
        status: 503, code: 'api_disabled',
      });
    });
  }, { name: 'api-kill-switch' });
}
