import type { FastifyInstance } from 'fastify';
import type { RouteContext } from '../routes/index.js';
import { FeedbackWorker } from '../services/feedback/worker.js';

export function startFeedbackWorker(app: FastifyInstance, ctx: RouteContext) {
  const worker = new FeedbackWorker(ctx, app);
  let busy = false;
  let closed = false;
  let active: Promise<void> | null = null;
  const tick = async () => {
    if (busy || closed) return;
    busy = true;
    try { await worker.tick(); }
    catch { app.log.warn('Feedback worker unavailable; retained local reports and pending jobs'); }
    finally { busy = false; }
  };
  const start = () => { if (!busy && !closed) active = tick(); };
  const timer = setInterval(start, 60000);
  timer.unref();
  app.addHook('onReady', async () => { start(); });
  app.addHook('onClose', async () => { closed = true; clearInterval(timer); worker.stop(); await active; });
}
