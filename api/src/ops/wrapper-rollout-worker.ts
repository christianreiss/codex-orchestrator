import type { FastifyInstance } from 'fastify';
import type { Database } from '../db/client.js';
import type { Env } from '../env.js';
import { evaluateRollout, rolloutSettingsFromEnv } from '../services/wrapper-rollout.js';

const TICK_INTERVAL_MS = 60_000;

/**
 * Advances or auto-halts the staged cxx rollout once a minute. Off with the
 * feature flag: no ticks, and the gates ignore any stored rollout.
 */
export function startWrapperRolloutWorker(app: FastifyInstance, db: Database, env: Env): void {
  if (!rolloutSettingsFromEnv(env).enabled) return;
  let stopped = false;
  let running = false;

  const tick = async (): Promise<void> => {
    if (stopped || running) return;
    running = true;
    try {
      const result = await evaluateRollout(db);
      if (result.advanced && result.state) {
        app.log.info(
          { rollout_id: result.state.id, status: result.state.status, stage_index: result.state.stage_index },
          'cxx rollout advanced',
        );
      }
      if (result.halted && result.state) {
        app.log.warn({ rollout_id: result.state.id, reason: result.state.halted_reason }, 'cxx rollout halted');
      }
    } catch (error) {
      app.log.error({ err: error }, 'cxx rollout worker tick failed');
    } finally {
      running = false;
    }
  };

  const interval = setInterval(() => void tick(), TICK_INTERVAL_MS);
  interval.unref();
  app.addHook('onClose', async () => {
    stopped = true;
    clearInterval(interval);
  });
}
