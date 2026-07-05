import type { FastifyInstance } from 'fastify';
import type { Env } from '../env.js';
import type { Database } from '../db/client.js';
import type { Keyring } from '../security/keyring.js';
import { createRunnerClient } from '../services/runner-client.js';
import { createRunnerValidationService } from '../services/runner-validation.js';
import { createCanonicalAuthStoreService } from '../services/canonical-auth-store.js';
import { ENGINE_CLAUDE, ENGINE_CODEX, type Engine } from '../util/engine.js';
import { nowIso } from '../util/timestamp.js';
import { writeRunnerTelemetry, type RunnerTelemetryState } from '../services/runner-telemetry.js';
import type { RunnerValidationService } from '../services/runner-validation.js';
import type { CanonicalAuthStoreService } from '../services/canonical-auth-store.js';

type WorkerReason = 'startup' | 'interval';

export interface AuthVerificationTelemetryWriter {
  write(engine: Engine, state: RunnerTelemetryState, checkedAt: string): Promise<void>;
}

export interface AuthVerificationTickDeps {
  runnerValidation: RunnerValidationService;
  authStore: CanonicalAuthStoreService;
  telemetry: AuthVerificationTelemetryWriter;
  ttlSeconds: number;
  reason: WorkerReason;
  log?: Pick<FastifyInstance['log'], 'debug' | 'info' | 'warn'>;
  now?: () => string;
}

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
  const telemetry: AuthVerificationTelemetryWriter = {
    write: (engine, state, checkedAt) => writeRunnerTelemetry(db, engine, state, checkedAt),
  };
  let running = false;
  let stopped = false;

  const run = async (reason: WorkerReason): Promise<void> => {
    if (running || stopped) return;
    running = true;
    try {
      await runAuthVerificationWorkerTick({
        runnerValidation,
        authStore,
        telemetry,
        ttlSeconds,
        reason,
        log: app.log,
      });
    } catch (err) {
      app.log.warn({ err, reason }, 'auth verification worker tick failed');
    } finally {
      running = false;
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

export async function runAuthVerificationWorkerTick(deps: AuthVerificationTickDeps): Promise<void> {
  await Promise.all([
    verifyEngine(ENGINE_CODEX, deps),
    verifyEngine(ENGINE_CLAUDE, deps),
  ]);
}

async function verifyEngine(
  engine: Engine,
  deps: AuthVerificationTickDeps,
): Promise<void> {
  const { runnerValidation, authStore, ttlSeconds, reason, log } = deps;
  const row = await runnerValidation.resolveCanonicalPayload(engine);
  const validated = runnerValidation.validateCanonicalPayload(row);
  if (!row || !validated) return;
  if (!needsLiveVerification(row, ttlSeconds)) {
    log?.debug?.({ engine, reason, state: row.verificationState }, 'canonical auth verification still fresh');
    return;
  }

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
    await deps.telemetry.write(engine, 'fail', (deps.now ?? nowIso)());
    log?.warn?.({ engine, reason, reason_detail: verdict.reason }, 'canonical auth verification failed');
  } else if (verdict.refreshed) {
    await deps.telemetry.write(engine, 'ok', (deps.now ?? nowIso)());
    log?.info?.({ engine, reason, digest: verdict.digest }, 'canonical auth refreshed by worker');
  } else if (verdict.state === 'verified') {
    await deps.telemetry.write(engine, 'ok', (deps.now ?? nowIso)());
    log?.debug?.({ engine, reason, state: verdict.state }, 'canonical auth verification checked');
  } else {
    log?.debug?.({ engine, reason, state: verdict.state }, 'canonical auth verification unavailable');
  }
}

function needsLiveVerification(
  row: { verificationState: string; verificationCheckedAt: string | null },
  ttlSeconds: number,
): boolean {
  if (row.verificationState !== 'verified' && row.verificationState !== 'failed') return true;
  const checkedMs = row.verificationCheckedAt ? Date.parse(row.verificationCheckedAt) : NaN;
  if (!Number.isFinite(checkedMs)) return true;
  return Date.now() - checkedMs > Math.max(0, ttlSeconds) * 1000;
}
