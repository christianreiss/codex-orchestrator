import type { FastifyInstance } from 'fastify';
import type { Database } from '../db/client.js';
import type { Keyring } from '../security/keyring.js';
import { WatchdogsService } from '../services/watchdogs.js';
import { SchedulesService } from '../services/schedules.js';

const SWEEP_INTERVAL_MS = 10 * 60_000;

export function startSchedulesWorker(app: FastifyInstance, db: Database, keyring: Keyring) {
  const service = new SchedulesService(db, keyring);
  const watchdogs = new WatchdogsService(db,keyring);
  let running: Promise<void> | null = null,
    stopped = false,
    lastSweep = 0;
  const tick = () => {
    if (stopped || running) return;
    running = watchdogs.tick().then(() => service.tick())
      .then(async () => {
        // Retiring dead wake-ups is housekeeping, not delivery: every 10 minutes is plenty.
        if (Date.now() - lastSweep < SWEEP_INTERVAL_MS) return;
        lastSweep = Date.now();
        await service.sweepStale();
      })
      .catch((err) => {
        app.log.error({ err }, 'schedule tick failed');
      })
      .finally(() => {
        running = null;
      });
  };
  const timer = setInterval(tick, 10_000);
  timer.unref();
  tick();
  app.addHook('onClose', async () => {
    stopped = true;
    clearInterval(timer);
    await running;
  });
}
