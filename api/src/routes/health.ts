import type { FastifyInstance } from 'fastify';
import type { RouteContext } from './index.js';
import { createSetupStatusService } from '../services/setup-status.js';
import type { SetupCheck } from '../services/setup-status.js';

type ReadinessProvider = () => Promise<{ critical_complete: boolean; checks: SetupCheck[] }>;

function defaultReadiness(ctx: RouteContext): ReadinessProvider {
  const setup = createSetupStatusService(ctx.db, ctx.env, ctx.keyring);
  return () => setup.readiness();
}

export async function registerHealthRoutes(
  app: FastifyInstance,
  ctx: RouteContext,
  readiness: ReadinessProvider = defaultReadiness(ctx),
): Promise<void> {
  app.get('/healthz', async () => ({ ok: true, ts: new Date().toISOString() }));
  app.get('/readyz', async (_req, reply) => {
    const status = await readiness();
    if (!status.critical_complete) reply.code(503);
    return { ok: status.critical_complete, ts: new Date().toISOString(), checks: status.checks };
  });
}
