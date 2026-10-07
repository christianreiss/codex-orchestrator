import type { FastifyInstance } from 'fastify';
import type { Database } from '../db/client.js';
import type { Env } from '../env.js';
import type { Keyring } from '../security/keyring.js';
import { createGrokAuthOwner } from '../services/grok-auth-owner.js';
import { createRunnerClient } from '../services/runner-client.js';
import { GrokUsageService } from '../services/grok-usage.js';

/** Wake frequently for newly enrolled accounts; durable per-account checks limit
 * successful and failed provider requests to once every five minutes. */
export function startGrokUsageWorker(app: FastifyInstance, db: Database, env: Env, keyring: Keyring): void {
  const usage = new GrokUsageService({
    db,
    authOwner: createGrokAuthOwner({ db, keyring, runner: createRunnerClient({ env }) }),
  });
  let stopped = false;
  let pending: Promise<void> | null = null;
  function tick() {
    if (stopped || pending) return;
    pending = usage
      .refreshEnabled()
      .catch(() => app.log.warn('Grok usage worker failed; retrying on the next tick'))
      .finally(() => {
        pending = null;
      });
  }
  const interval = setInterval(tick, 30_000);
  interval.unref();
  tick();
  app.addHook('onClose', async () => {
    stopped = true;
    clearInterval(interval);
    await pending;
  });
}
