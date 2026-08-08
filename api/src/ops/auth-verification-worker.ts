import type { FastifyInstance } from 'fastify';
import type { Env } from '../env.js';
import type { Database } from '../db/client.js';
import type { Keyring } from '../security/keyring.js';
import { createRunnerClient } from '../services/runner-client.js';
import { createRunnerValidationService } from '../services/runner-validation.js';
import {
  createCanonicalAuthStoreService,
  unverifiableWithoutRefreshSpend,
} from '../services/canonical-auth-store.js';
import { inspectCredential } from '../services/auth-generation.js';
import { ENGINE_CLAUDE, ENGINE_CODEX, type Engine } from '../util/engine.js';
import { nowIso } from '../util/timestamp.js';
import { writeRunnerTelemetry, type RunnerTelemetryState } from '../services/runner-telemetry.js';
import type { RunnerValidationService } from '../services/runner-validation.js';
import type { CanonicalAuthStoreService } from '../services/canonical-auth-store.js';

type WorkerReason = 'startup' | 'interval';

const DEFAULT_MAX_INTERVAL_SECONDS = 21600;

export interface AuthVerificationTelemetryWriter {
  write(engine: Engine, state: RunnerTelemetryState, checkedAt: string): Promise<void>;
}

/**
 * One remembered probe attempt per engine. The persisted row only advances
 * `verificationCheckedAt` when a probe produces a verdict; attempts that end
 * `unknown` (runner outage, provider blip) and probes of `pending` quarantine
 * rows (checkedAt null by construction) would otherwise retry on every tick.
 */
export interface AuthProbeAttempt {
  rowId: number;
  digest: string;
  /** row.verificationCheckedAt at the moment of the attempt — unchanged after
   * the attempt means the probe persisted nothing. */
  checkedAtAtAttempt: string | null;
  lastAttemptMs: number;
  attempts: number;
}

export type AuthProbeScheduleMemory = Map<Engine, AuthProbeAttempt>;

export interface AuthVerificationTickDeps {
  runnerValidation: RunnerValidationService;
  authStore: CanonicalAuthStoreService;
  telemetry: AuthVerificationTelemetryWriter;
  ttlSeconds: number;
  reason: WorkerReason;
  log?: Pick<FastifyInstance['log'], 'debug' | 'info' | 'warn'>;
  now?: () => string;
  /** Ceiling for the dynamic probe schedule. Defaults to 21600 (6 h). */
  maxIntervalSeconds?: number;
  /** Cross-tick attempt memory; production passes one persistent Map. */
  scheduleMemory?: AuthProbeScheduleMemory;
  /** Test seam for schedule math. */
  nowMs?: () => number;
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
  const maxIntervalSeconds = Math.max(
    ttlSeconds,
    Number(env.AUTH_RUNNER_VERIFY_MAX_INTERVAL_SECONDS ?? DEFAULT_MAX_INTERVAL_SECONDS),
  );
  const runnerValidation = createRunnerValidationService({ db, keyring });
  const runner = createRunnerClient({ env });
  const authStore = createCanonicalAuthStoreService({ db, keyring, runnerValidation, runner });
  const telemetry: AuthVerificationTelemetryWriter = {
    write: (engine, state, checkedAt) => writeRunnerTelemetry(db, engine, state, checkedAt),
  };
  const scheduleMemory: AuthProbeScheduleMemory = new Map();
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
        maxIntervalSeconds,
        scheduleMemory,
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
  await Promise.all([verifyEngine(ENGINE_CODEX, deps), verifyEngine(ENGINE_CLAUDE, deps)]);
}

/**
 * Re-check interval for a row with a persisted verdict: the time it has been
 * proven good, clamped to [ttl, max]. A verdict sets checkedAt = now, so the
 * gap doubles after every successful check — a stateless factor-2 ladder
 * (15 m → 30 m → 1 h → 2 h → 4 h → cap) derived from two persisted columns
 * that survives worker restarts. Traffic-touches advance checkedAt the same
 * way and extend the ladder without a probe.
 */
export function probeIntervalSeconds(input: {
  createdAt: string;
  checkedAt: string | null;
  ttlSeconds: number;
  maxIntervalSeconds: number;
}): number {
  const minSeconds = Math.max(0, input.ttlSeconds);
  const maxSeconds = Math.max(minSeconds, input.maxIntervalSeconds);
  const createdMs = Date.parse(input.createdAt);
  const checkedMs = input.checkedAt ? Date.parse(input.checkedAt) : NaN;
  if (!Number.isFinite(createdMs) || !Number.isFinite(checkedMs)) return minSeconds;
  const provenSeconds = (checkedMs - createdMs) / 1000;
  if (provenSeconds <= minSeconds) return minSeconds;
  return Math.min(maxSeconds, provenSeconds);
}

/** Retry ladder for attempts that persist no verdict: ttl · 2^(attempts-1), capped. */
export function probeBackoffSeconds(
  attempts: number,
  ttlSeconds: number,
  maxIntervalSeconds: number,
): number {
  const minSeconds = Math.max(1, ttlSeconds);
  const maxSeconds = Math.max(minSeconds, maxIntervalSeconds);
  const exponent = Math.max(0, Math.min(30, Math.floor(attempts) - 1));
  return Math.min(maxSeconds, minSeconds * 2 ** exponent);
}

export function isProbeDue(input: {
  row: {
    id: number;
    verificationState: string;
    verificationCheckedAt: string | null;
    createdAt: string;
  };
  digest: string;
  memory: AuthProbeAttempt | undefined;
  nowMs: number;
  ttlSeconds: number;
  maxIntervalSeconds: number;
}): { due: boolean; intervalSeconds: number; source: 'row' | 'memory' | 'first-sight' } {
  const { row, digest, memory, nowMs, ttlSeconds, maxIntervalSeconds } = input;
  const matching = memory && memory.rowId === row.id && memory.digest === digest ? memory : undefined;
  const checkedMs = row.verificationCheckedAt ? Date.parse(row.verificationCheckedAt) : NaN;
  const rowScheduleUsable =
    (row.verificationState === 'verified' || row.verificationState === 'failed') &&
    Number.isFinite(checkedMs);

  if (rowScheduleUsable) {
    const intervalSeconds = probeIntervalSeconds({
      createdAt: row.createdAt,
      checkedAt: row.verificationCheckedAt,
      ttlSeconds,
      maxIntervalSeconds,
    });
    if (nowMs - checkedMs <= intervalSeconds * 1000) {
      return { due: false, intervalSeconds, source: 'row' };
    }
    // Due by the row schedule — but if our own last attempt targeted this
    // exact persisted verdict and persisted nothing (unknown outcome), the
    // attempt ladder governs instead of re-firing every tick.
    if (matching && matching.checkedAtAtAttempt === row.verificationCheckedAt) {
      const backoff = probeBackoffSeconds(matching.attempts, ttlSeconds, maxIntervalSeconds);
      return {
        due: nowMs - matching.lastAttemptMs > backoff * 1000,
        intervalSeconds: backoff,
        source: 'memory',
      };
    }
    return { due: true, intervalSeconds, source: 'row' };
  }

  // Pending rows (checkedAt null by construction) and rows with unparsable
  // stamps: first sight probes immediately, then the attempt ladder governs.
  if (matching) {
    const backoff = probeBackoffSeconds(matching.attempts, ttlSeconds, maxIntervalSeconds);
    return {
      due: nowMs - matching.lastAttemptMs > backoff * 1000,
      intervalSeconds: backoff,
      source: 'memory',
    };
  }
  return { due: true, intervalSeconds: Math.max(0, ttlSeconds), source: 'first-sight' };
}

async function verifyEngine(engine: Engine, deps: AuthVerificationTickDeps): Promise<void> {
  const { runnerValidation, authStore, ttlSeconds, reason, log } = deps;
  const maxIntervalSeconds = Math.max(
    ttlSeconds,
    deps.maxIntervalSeconds ?? DEFAULT_MAX_INTERVAL_SECONDS,
  );
  const scheduleMemory = deps.scheduleMemory ?? new Map<Engine, AuthProbeAttempt>();
  const nowMsFn = deps.nowMs ?? Date.now;
  const quarantine = await runnerValidation.resolvePendingQuarantine?.(engine);
  const row = quarantine ?? (await runnerValidation.resolveCanonicalPayload(engine));
  const validated = runnerValidation.validateCanonicalPayload(row);
  if (!row || !validated) return;
  const withFallback = runnerValidation.ensureAuthsFallback(validated.auth, engine);
  const entries = runnerValidation.normalizeAuthEntries(withFallback, engine);
  const normalizedAuth = runnerValidation.canonicalizeAuthPayload(
    withFallback,
    entries,
    validated.last_refresh,
    engine,
  );
  const normalizedDigest = runnerValidation.calculateDigest(JSON.stringify(normalizedAuth));
  const requiresNormalization = normalizedDigest !== validated.digest;
  const requiresCanonicalReissue =
    runnerValidation.canonicalAuthFromPayload({
      ...row,
      verificationState: 'verified',
    }) === null;
  const forceImmediateRepair =
    row.verificationState === 'verified' &&
    (requiresNormalization || requiresCanonicalReissue);
  const authToProbe = requiresNormalization ? normalizedAuth : validated.auth;

  const writeRowStateTelemetry = async (): Promise<void> => {
    const checkedAt = row.verificationCheckedAt ?? (deps.now ?? nowIso)();
    await deps.telemetry.write(engine, row.verificationState === 'verified' ? 'ok' : 'fail', checkedAt);
  };

  if (!forceImmediateRepair) {
    // A probe could only pass on this credential by spending its refresh
    // token; never even start the ensure round-trip. Verified lineage keeps
    // serving (hosts hold the refresh token and heal it natively); pending
    // rows write no telemetry, mirroring the unknown-verdict rule below.
    if (unverifiableWithoutRefreshSpend(inspectCredential(authToProbe, engine))) {
      if (row.verificationState === 'verified' || row.verificationState === 'failed') {
        await writeRowStateTelemetry();
      }
      log?.debug?.(
        { engine, reason, state: row.verificationState },
        'canonical auth probe skipped: unverifiable without refresh spend',
      );
      return;
    }

    const schedule = isProbeDue({
      row: {
        id: row.id,
        verificationState: row.verificationState,
        verificationCheckedAt: row.verificationCheckedAt,
        createdAt: row.createdAt,
      },
      digest: validated.digest,
      memory: scheduleMemory.get(engine),
      nowMs: nowMsFn(),
      ttlSeconds,
      maxIntervalSeconds,
    });
    if (!schedule.due) {
      // Still keep telemetry (runner_state_*, runner_last_check_*, ...)
      // current on the probe-free path — otherwise a payload that self-heals
      // via a host upload or a gateway traffic-touch leaves the dashboard
      // showing the last live-probe's stale verdict.
      if (row.verificationState === 'verified' || row.verificationState === 'failed') {
        await writeRowStateTelemetry();
      }
      log?.debug?.(
        { engine, reason, state: row.verificationState, interval_seconds: schedule.intervalSeconds, source: schedule.source },
        'canonical auth verification still fresh',
      );
      return;
    }
  }

  const prior = scheduleMemory.get(engine);
  const matchingPrior =
    prior && prior.rowId === row.id && prior.digest === validated.digest ? prior : undefined;
  scheduleMemory.set(engine, {
    rowId: row.id,
    digest: validated.digest,
    checkedAtAtAttempt: row.verificationCheckedAt,
    lastAttemptMs: nowMsFn(),
    attempts: (matchingPrior?.attempts ?? 0) + 1,
  });

  // The scheduler's minimum interval equals ttlSeconds, so every due call is
  // already past ensureServedVerification's inner withinTtl fast path; do not
  // lower the schedule's min clamp below the ttl.
  const verdict = await authStore.ensureServedVerification({
    engine,
    hostId: null,
    row: {
      id: row.id,
      verificationState: row.verificationState,
      verificationCheckedAt: row.verificationCheckedAt,
      verificationReason: row.verificationReason,
    },
    auth: authToProbe,
    digest: validated.digest,
    lastRefresh: validated.last_refresh,
    ttlSeconds,
    forceLive: forceImmediateRepair,
    reissueCanonical: requiresCanonicalReissue,
  });

  if (verdict.state === 'failed') {
    scheduleMemory.delete(engine);
    await deps.telemetry.write(engine, 'fail', (deps.now ?? nowIso)());
    log?.warn?.({ engine, reason, reason_detail: verdict.reason }, 'canonical auth verification failed');
  } else if (verdict.state === 'verified') {
    scheduleMemory.delete(engine);
    await deps.telemetry.write(engine, 'ok', (deps.now ?? nowIso)());
    if (verdict.refreshed) {
      log?.info?.({ engine, reason, digest: verdict.digest }, 'canonical auth refreshed by worker');
    } else {
      log?.debug?.({ engine, reason, state: verdict.state }, 'canonical auth verification checked');
    }
  } else {
    // Unknown: nothing persisted; the attempt memory above governs retries.
    log?.debug?.({ engine, reason, state: verdict.state }, 'canonical auth verification unavailable');
  }
}
