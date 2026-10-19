import { ServerRetentionService } from '../services/server-retention/index.js';
import { pruneHosts } from '../services/host-lifecycle.js';
import { ChatAttachments } from '../services/agent-chat/attachments.js';
import type { FastifyInstance } from 'fastify';
import type { Database } from '../db/client.js';
import type { Env } from '../env.js';
import type { Keyring } from '../security/keyring.js';
import { createAgentPortalService } from '../services/agent-portal.js';
import { isoOffsetSeconds } from '../util/timestamp.js';

/** How long after an API start the abandonment sweep waits for live wrappers to reconnect. */
const ABANDONED_SESSION_START_GRACE_SECONDS = 150;

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
  // A live wrapper retries its heartbeat at most every 60 s (cxx backoff ceiling)
  // and a communicator redial adds up to 10 s more; give it twice that after a
  // start before treating a lapsed bridge as an abandoned session.
  const abandonedGraceUntil = isoOffsetSeconds(ABANDONED_SESSION_START_GRACE_SECONDS);
  let stopped = false;
  let running: Promise<void> | null = null;

  const phase = async (name: string, run: () => Promise<unknown>) => {
    if (stopped) return;
    try { await run(); }
    catch (error) { app.log.error({ err: error, phase: name }, 'server retention phase failed'); }
  };
  const run = async () => {
    await phase('portal', async () => {
      const purged = await portal.purgeExpired({ abandonedGraceUntil });
      if (purged.sessions || purged.browser_sessions || purged.abandoned_sessions) {
        app.log.info({ purged }, 'agent portal retention purge');
      }
    });
    await phase('history', async () => {
      const purged = await new ServerRetentionService(db).purge();
      if (Object.values(purged).some(Boolean)) app.log.info({ purged }, 'server history retention purge');
    });
    await phase('hosts', () => pruneHosts(db));
    await phase('attachments', () => new ChatAttachments(db, keyring, env.DATA_ROOT ?? 'storage').purge());
  };
  const tick = (): Promise<void> | undefined => {
    if (stopped || running) return;
    running = run().finally(() => { running = null; });
    return running;
  };

  const interval = setInterval(() => void tick(), env.AGENT_PORTAL_PURGE_INTERVAL_SECONDS * 1000);
  interval.unref();
  void tick();
  app.addHook('onClose', async () => {
    stopped = true;
    clearInterval(interval);
    await running;
  });
}
