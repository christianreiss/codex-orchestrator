import type { FastifyInstance } from 'fastify';
import type { Database } from '../db/client.js';
import type { Env } from '../env.js';
import type { Keyring } from '../security/keyring.js';
import { createAgentPortalService } from '../services/agent-portal.js';

/**
 * DB-backed retention worker. Database rows are the source of truth; the timer is
 * only a wake-up mechanism, so process restarts merely continue where the last
 * tick stopped. The portal has no outbound push channel — operators reach it
 * through their own permanent link — so this worker only ages rows out.
 */
export function startAgentPortalWorker(
  app: FastifyInstance,
  db: Database,
  env: Env,
  keyring: Keyring,
): void {
  const portal = createAgentPortalService(db, env, keyring);
  let stopped = false;
  let running = false;

  const tick = async (): Promise<void> => {
    if (stopped || running) return;
    running = true;
    try {
      const purged = await portal.purgeExpired();
      if (purged.sessions || purged.browser_sessions || purged.abandoned_sessions) {
        app.log.info({ purged }, 'agent portal retention purge');
      }
    } catch (error) {
      app.log.error({ err: error }, 'agent portal worker tick failed');
    } finally {
      running = false;
    }
  };

  const interval = setInterval(() => void tick(), env.AGENT_PORTAL_PURGE_INTERVAL_SECONDS * 1000);
  interval.unref();
  void tick();
  app.addHook('onClose', async () => {
    stopped = true;
    clearInterval(interval);
  });
}
