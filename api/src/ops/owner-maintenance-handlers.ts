import { SchedulesService } from '../services/schedules.js';
import { AgentSupervisor } from '../services/agent-supervisor.js';
import { WatchdogsService } from '../services/watchdogs.js';
import type { FastifyInstance } from 'fastify';
import type { RouteContext } from '../routes/index.js';
import { requireOwnerRuntime } from '../control-plane/state/runtime.js';
import { AgentTransfersService } from '../services/agent-transfers.js';
import { SettingsService } from '../services/settings.js';
import { pruneSupersededAuth } from '../services/auth-generation-retention.js';
import { evaluateRollout } from '../services/wrapper-rollout.js';
import { MattPocockSkillsService } from '../services/mattpocock-skills.js';
import { FeedbackService } from '../services/feedback.js';
import { FeedbackWorker } from '../services/feedback/worker.js';
import { runOwnerPortalRetention } from '../services/server-retention/portal-owner.js';
import type { OwnerMaintenanceOperation } from './owner-maintenance.js';
import type { OwnerWorkObligation, OwnerWorkResult } from './owner-worker.js';

export type OwnerMaintenanceHandler = (work: OwnerWorkObligation) => Promise<OwnerWorkResult>;
/** Concrete migrated handlers. The final binder must require the remaining
 * domain handlers; absence is never interpreted as disabled work. */
export function createAuxiliaryMaintenanceHandlers(
  app: FastifyInstance,
  ctx: RouteContext,
): Partial<Record<OwnerMaintenanceOperation, OwnerMaintenanceHandler>> {
  const runtime = requireOwnerRuntime(ctx.db);
  const transfers = new AgentTransfersService({
    db: ctx.db,
    settings: new SettingsService(ctx.db),
    dataRoot: ctx.env.DATA_ROOT ?? 'storage',
  });
  const feedback = new FeedbackWorker(ctx, app);
  app.addHook('onClose', async () => {
    feedback.stop();
  });
  return {
    schedules: async () => {
      const service = new SchedulesService(ctx.db, ctx.keyring);
      await service.tick();
      await service.sweepStale();
      return { observed: true };
    },
    supervisor: async () => {
      await new AgentSupervisor(ctx.db, ctx.keyring).tick();
      return { retryAfterMs: 60_000 };
    },
    watchdogs: async () => {
      await new WatchdogsService(ctx.db, ctx.keyring).tick();
      return { observed: true };
    },
    'portal-retention': (work) => runOwnerPortalRetention(ctx.db, runtime, ctx.env, work),
    'auth-retention': async () => {
      await pruneSupersededAuth(ctx.db);
    },
    'transfer-expiry': async () => {
      await transfers.sweepExpired();
    },
    'transfer-orphans': async () => {
      const result = await transfers.reconcileOrphans();
      return result.next_due_at === undefined
        ? { observed: true }
        : { retryAt: Math.max(Date.now() + 1, result.next_due_at) };
    },
    'skill-source': async () => {
      await new MattPocockSkillsService(ctx.db).refresh({ force: false });
      return { observed: true };
    },
    'wrapper-rollout': async () => {
      await evaluateRollout(ctx.db);
      return { observed: true };
    },
    feedback: async (work) => {
      if (work.key.startsWith('claim:'))
        await new FeedbackService(ctx.db, ctx.keyring).expireClaims(work.key.slice('claim:'.length));
      else await feedback.tick();
      return { observed: true };
    },
  };
}
