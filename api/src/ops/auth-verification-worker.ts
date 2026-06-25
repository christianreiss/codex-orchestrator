import type { FastifyInstance } from 'fastify';
import type { Env } from '../env.js';
import type { Database } from '../db/client.js';
import type { Keyring } from '../security/keyring.js';
import { createRunnerClient } from '../services/runner-client.js';
import { createRunnerValidationService } from '../services/runner-validation.js';
import { createCanonicalAuthStoreService } from '../services/canonical-auth-store.js';
import { ENGINE_CLAUDE, ENGINE_CODEX, type Engine } from '../util/engine.js';

export function startAuthVerificationWorker(
  app: FastifyInstance,
  env: Env,
  db: Database,
  keyring: Keyring,
): void {
  if (!env.AUTH_RUNNER_URL) return;

  const intervalSeconds = Math.max(30, Number(env.AUTH_RUNNER_VERIFY_WORKER_INTERVAL_SECONDS ?? 300));
  const ttlSeconds = Math.max(0, Number(env.AUTH_RUNNER_VERIFY_TTL_SECONDS ?? 900));
  const runnerValidation = createRunnerValidationService({ db, keyring });
  const runner = createRunnerClient({ env });
  const authStore = createCanonicalAuthStoreService({ db, keyring, runnerValidation, runner });
  let running = false;
  let stopped = false;

  const run = async (reason: 'startup' | 'interval'): Promise<void> => {
    if (running || stopped) return;
    running = true;
    try {
      await Promise.all([
        verifyEngine(ENGINE_CODEX, reason),
        verifyEngine(ENGINE_CLAUDE, reason),
      ]);
    } catch (err) {
      app.log.warn({ err, reason }, 'auth verification worker tick failed');
    } finally {
      running = false;
    }
  };

  const verifyEngine = async (engine: Engine, reason: 'startup' | 'interval'): Promise<void> => {
    const row = await runnerValidation.resolveCanonicalPayload(engine);
    const validated = runnerValidation.validateCanonicalPayload(row);
    if (!row || !validated) return;

    const verdict = await authStore.ensureServedVerification({
      engine,
      hostId: null,
      row: {
        id: row.id,
        verificationState: row.verificationState,
        verificationCheckedAt: row.verificationCheckedAt,
        verificationReason: row.verificationReason,
      },
      auth: validated.auth,
      digest: validated.digest,
      lastRefresh: validated.last_refresh,
      ttlSeconds,
    });

    if (verdict.state === 'failed') {
      app.log.warn({ engine, reason, reason_detail: verdict.reason }, 'canonical auth verification failed');
    } else if (verdict.refreshed) {
      app.log.info({ engine, reason, digest: verdict.digest }, 'canonical auth refreshed by worker');
    } else {
      app.log.debug({ engine, reason, state: verdict.state }, 'canonical auth verification checked');
    }
  };

  const first = setTimeout(() => {
    void run('startup');
  }, 1000);
  first.unref?.();

  const timer = setInterval(() => {
    void run('interval');
  }, intervalSeconds * 1000);
  timer.unref?.();

  app.addHook('onClose', async () => {
    stopped = true;
    clearTimeout(first);
    clearInterval(timer);
  });
}
