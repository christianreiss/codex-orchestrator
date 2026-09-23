import type { FastifyInstance } from 'fastify';
import type { Database } from '../db/client.js';
import type { Env } from '../env.js';
import { makeAdminEventsWriter } from '../services/admin-events-writer.js';
import { InsecureWindowAdminService } from '../services/insecure-window-admin.js';

/**
 * Closes the fleet-wide insecure window when its deadline passes.
 *
 * This repo generally sweeps expiry on read — git-director.ts argues the case,
 * and it is right where the reader can do the work itself. It cannot here. The
 * fleet grant is denormalized onto `hosts.insecure_enabled_until` so that
 * `insecureWindowActive()` (a synchronous predicate) and
 * `messagingHostEligibleSql` (a SQL fragment MySQL executes) stay correct; the
 * cost is that a lapsed window leaves rows that are stale-permissive to both
 * until somebody sweeps. "Work hours ended" is a security deadline, and it must
 * not wait for the fleet to send traffic before it takes effect.
 *
 * The DB is the source of truth: the stored deadline survives restarts, so a
 * process that dies mid-close resumes on the next tick.
 *
 * The same tick retires stale approval requests (timed out, abandoned by their
 * wrapper, or superseded). Otherwise a request is only swept when someone reads
 * the pending list, and a dashboard left open keeps asking the operator about
 * callers that stopped waiting long ago. The cadence is set by that job: the
 * heartbeat TTL is 30 s, so a 10 s tick clears an abandoned row within 40 s.
 */
const TICK_INTERVAL_MS = 10_000;

export function startInsecureFleetWindowWorker(
  app: FastifyInstance,
  db: Database,
  env: Env,
): void {
  const insecure = new InsecureWindowAdminService({
    db,
    env,
    events: makeAdminEventsWriter(db),
  });
  let stopped = false;
  let running = false;

  const tick = async (): Promise<void> => {
    if (stopped || running) return;
    running = true;
    try {
      if (await insecure.sweepIfLapsed()) {
        app.log.info('insecure fleet window expired; all insecure access closed');
      }
      const retired = await insecure.sweepStaleRequests();
      if (retired > 0) app.log.info({ retired }, 'stale insecure approval requests retired');
    } catch (error) {
      app.log.error({ err: error }, 'insecure fleet window worker tick failed');
    } finally {
      running = false;
    }
  };

  const interval = setInterval(() => void tick(), TICK_INTERVAL_MS);
  interval.unref();
  void tick();
  app.addHook('onClose', async () => {
    stopped = true;
    clearInterval(interval);
  });
}
