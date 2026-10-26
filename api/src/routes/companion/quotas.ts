import type { FastifyInstance, FastifyRequest } from 'fastify';

export function registerCompanionQuotas(
  app: FastifyInstance,
  deps: {
    authorize(req: FastifyRequest): Promise<unknown>;
    read(): Promise<unknown>;
  },
) {
  app.get('/companion/v1/quotas', async (req) => {
    await deps.authorize(req);
    const result = await deps.read();
    await deps.authorize(req);
    return result;
  });
}
