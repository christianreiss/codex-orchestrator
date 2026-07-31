import type { FastifyInstance } from 'fastify';

import type { Database } from '../db/client.js';
import type { Env } from '../env.js';
import type { Keyring } from '../security/keyring.js';
import { createAgentMessagingService } from '../services/agent-messaging.js';

/**
 * Queue housekeeping only. Delivery is always claimed by an outbound host
 * connection; the API never opens a host listener and never pushes off-box.
 */
export function startAgentMessagingWorker(
  app: FastifyInstance,
  db: Database,
  env: Env,
  keyring: Keyring,
): void {
  const messaging = createAgentMessagingService(db, env, keyring);
  let stopped = false;
  let running = false;
  const tick = async (): Promise<void> => {
    if (stopped || running) return;
    running = true;
    try {
      const changed = await messaging.maintenance();
      if (changed.expired || changed.retried || changed.dead) {
        app.log.info({ changed }, 'agent messaging queue maintenance');
      }
    } catch (error) {
      app.log.error({ err: error }, 'agent messaging worker tick failed');
    } finally {
      running = false;
    }
  };
  const interval = setInterval(() => void tick(), 30_000);
  interval.unref();
  void tick();
  app.addHook('onClose', async () => {
    stopped = true;
    clearInterval(interval);
  });
}
