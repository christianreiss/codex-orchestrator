import { mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Database } from '../db/client.js';
import type { Env } from '../env.js';
import type { FastifyInstance } from 'fastify';
import { startOwnerWorker } from './owner-worker.js';
import { requireOwnerMaintenanceCommands } from './owner-maintenance.js';
import { chatGptUsageObligations } from './provider-obligations.js';
import { ChatGptUsageService, type FetchResult } from '../services/chatgpt-usage.js';
import { nowIso } from '../util/timestamp.js';

type WorkerLog = {
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
};

export const DEFAULT_CHATGPT_USAGE_CRON_INTERVAL_SECONDS = 900;

export function resolveChatGptUsageWorkerIntervalSeconds(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return DEFAULT_CHATGPT_USAGE_CRON_INTERVAL_SECONDS;
  }
  return Math.max(30, Math.trunc(value));
}

export interface ChatGptUsageWorkerTickDeps {
  usage: Pick<ChatGptUsageService, 'fetchLatest'>;
  healthPath: string;
  log: WorkerLog;
  now?: () => string;
  signal?: AbortSignal;
  /**
   * Codex fleet master switch. This worker is its own container, so it reads
   * the database flag every tick rather than sharing the API's cache.
   */
  codexEnabled?: () => Promise<boolean>;
}

/**
 * Polls the provider once (subject to the service's five-minute cooldown).
 * The heartbeat is written only after a provider-backed usable snapshot, so
 * Compose health accurately represents telemetry freshness rather than merely
 * a process that is still alive.
 */
export async function runChatGptUsageWorkerTick(deps: ChatGptUsageWorkerTickDeps): Promise<FetchResult> {
  deps.signal?.throwIfAborted();
  if (deps.codexEnabled && !(await deps.codexEnabled())) {
    // Deliberately off is not unhealthy: keep the heartbeat fresh so Compose
    // does not flag the container, and record why nothing was polled.
    await writeUsageHeartbeat(deps.healthPath, {
      checked_at: (deps.now ?? nowIso)(),
      fetched_at: null,
      next_eligible_at: null,
      suspended: 'codex_engine_disabled',
    });
    deps.log.info({ reason: 'engine_disabled' }, 'chatgpt usage polling suspended: Codex is disabled fleet-wide');
    return { status: 'unavailable', snapshot: null, cached: false, next_eligible_at: null, error: 'engine_disabled' };
  }
  deps.signal?.throwIfAborted();
  const result = await deps.usage.fetchLatest(false, deps.signal);
  deps.signal?.throwIfAborted();
  const snapshotStatus =
    typeof result.snapshot?.['status'] === 'string' ? result.snapshot['status'] : 'unavailable';
  const fields = {
    status: result.status,
    snapshot_status: snapshotStatus,
    cached: result.cached,
    fetched_at: result.snapshot?.['fetched_at'] ?? null,
    next_eligible_at: result.next_eligible_at,
  };

  if (result.status === 'ok' && snapshotStatus === 'ok') {
    await writeUsageHeartbeat(deps.healthPath, {
      checked_at: (deps.now ?? nowIso)(),
      fetched_at: typeof result.snapshot?.['fetched_at'] === 'string' ? result.snapshot['fetched_at'] : null,
      next_eligible_at: result.next_eligible_at,
    });
    deps.log.info(fields, 'chatgpt usage refresh succeeded');
  } else {
    deps.log.warn({ ...fields, error: result.error ?? null }, 'chatgpt usage refresh failed');
  }
  return result;
}

export async function writeUsageHeartbeat(
  healthPath: string,
  payload: Record<string, unknown>,
): Promise<void> {
  await mkdir(dirname(healthPath), { recursive: true });
  const temporaryPath = `${healthPath}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(payload)}\n`, { mode: 0o600 });
  await rename(temporaryPath, healthPath);
}

/** Own one tick at a time, including the initial tick, until shutdown drains it. */
export function createChatGptUsageWorkerLifecycle(deps: {
  tick: (signal: AbortSignal) => Promise<unknown>;
  close: () => Promise<void>;
  intervalMs: number;
  log: WorkerLog;
}): { start: () => Promise<void>; stop: () => Promise<void> } {
  const controller = new AbortController();
  let pending: Promise<void> | undefined;
  let closing: Promise<void> | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  const tick = (): Promise<void> => {
    if (controller.signal.aborted) return Promise.resolve();
    if (pending) return pending;
    pending = Promise.resolve().then(() => deps.tick(controller.signal)).then(() => undefined)
      .catch((err: unknown) => {
        if (!controller.signal.aborted) deps.log.error({ err: errorMessage(err) }, 'chatgpt usage worker tick failed');
      }).finally(() => { pending = undefined; });
    return pending;
  };
  return {
    start() {
      if (!timer && !controller.signal.aborted) {
        timer = setInterval(() => void tick(), deps.intervalMs);
        timer.unref?.();
      }
      return tick();
    },
    stop() {
      if (!closing) {
        controller.abort(new Error('chatgpt usage worker stopping'));
        clearInterval(timer);
        closing = (async () => { await pending; await deps.close(); })();
      }
      return closing;
    },
  };
}

/** Provider refresh belongs to the sole API owner; no independent database writer. */
export function startChatGptUsageWorker(app: FastifyInstance, db: Database, env: Env): void {
  const commands = requireOwnerMaintenanceCommands(db);
  const intervalMs = resolveChatGptUsageWorkerIntervalSeconds(env.CHATGPT_USAGE_CRON_INTERVAL) * 1000;
  startOwnerWorker(app, db, {
    name: 'chatgpt-usage', tables: ['versions', 'providerAccounts', 'authCanonicalHeads', 'chatgptUsageSnapshots'],
    select: snapshot => chatGptUsageObligations(snapshot, intervalMs),
    run: obligation => commands.run('chatgpt-usage', obligation),
    error: error => app.log.warn({ err: error }, 'owner ChatGPT usage request failed'),
  });
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  throw new Error('Standalone quota writer retired; startChatGptUsageWorker must run inside the sole API owner');
}
