import type { FastifyInstance } from 'fastify';
import type { Database } from '../db/client.js';
import type { Env } from '../env.js';
import { AgentTransfersService } from '../services/agent-transfers.js';
import { SettingsService } from '../services/settings.js';

/**
 * How often the orphan reaper runs relative to the expiry sweep. Orphans are a
 * crash artefact rather than a normal outcome, and the walk touches the whole
 * storage tree, so it does not belong on the same cadence as the sweep.
 */
const ORPHAN_EVERY_N_TICKS = 12;

/**
 * Disk reclamation for expired transfers.
 *
 * The service already sweeps on read, which is the house rule (see
 * git-director.ts). This worker exists anyway for the reason
 * insecure-fleet-window-worker.ts exists: read-sweeping only reclaims when
 * somebody looks, and what is being reclaimed here is DISK. A fleet that goes
 * quiet over a weekend would otherwise hold every byte it was handed on Friday.
 *
 * Database rows are the source of truth and the timer is only a wake-up, so a
 * restart continues where the last tick stopped. Nothing here is transactional
 * across the two halves on purpose — an interrupted sweep leaves a row whose
 * bytes are already gone, which the next tick finishes.
 */
export function startAgentTransfersWorker(app: FastifyInstance, db: Database, env: Env): void {
  const transfers = new AgentTransfersService({
    db,
    settings: new SettingsService(db),
    dataRoot: env.DATA_ROOT ?? '/app/storage',
  });
  let stopped = false;
  let running = false;
  let ticks = 0;

  const tick = async (): Promise<void> => {
    if (stopped || running) return;
    running = true;
    try {
      const swept = await transfers.sweepExpired();
      if (swept.expired) {
        app.log.info({ swept }, 'agent transfers expiry sweep');
      }
      ticks += 1;
      if (ticks % ORPHAN_EVERY_N_TICKS === 0) {
        const orphans = await transfers.reconcileOrphans();
        if (orphans.removed) {
          app.log.warn({ orphans }, 'agent transfers orphan reclaim');
        }
      }
    } catch (error) {
      app.log.error({ err: error }, 'agent transfers worker tick failed');
    } finally {
      running = false;
    }
  };

  const interval = setInterval(() => void tick(), env.TRANSFERS_PURGE_INTERVAL_SECONDS * 1000);
  interval.unref();
  void tick();
  app.addHook('onClose', async () => {
    stopped = true;
    clearInterval(interval);
  });
}
