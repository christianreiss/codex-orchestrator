import type { FastifyInstance } from 'fastify';
import type { Database } from '../db/client.js';
import { pruneSupersededAuth } from '../services/auth-generation-retention.js';

const RETENTION_INTERVAL_MS = 24 * 60 * 60 * 1000;

export function startAuthRetentionWorker(app: FastifyInstance, db: Database): void {
  let running = false;
  let stopped = false;
  const run = async (): Promise<void> => {
    if (running || stopped) return;
    running = true;
    try {
      let total = 0;
      for (;;) {
        const removed = await pruneSupersededAuth(db);
        total += removed;
        if (removed < 500) break;
      }
      if (total > 0) app.log.info({ removed: total }, 'superseded auth history pruned');
    } catch (err) {
      app.log.warn({ err }, 'auth retention worker failed');
    } finally {
      running = false;
    }
  };
  const first = setTimeout(() => void run(), 5_000);
  first.unref?.();
  const timer = setInterval(() => void run(), RETENTION_INTERVAL_MS);
  timer.unref?.();
  app.addHook('onClose', async () => {
    stopped = true;
    clearTimeout(first);
    clearInterval(timer);
  });
}
