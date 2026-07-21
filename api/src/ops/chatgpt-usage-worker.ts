import { mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createDb } from '../db/client.js';
import { loadEnv } from '../env.js';
import { Keyring } from '../security/keyring.js';
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
}

/**
 * Polls the provider once (subject to the service's five-minute cooldown).
 * The heartbeat is written only after a provider-backed usable snapshot, so
 * Compose health accurately represents telemetry freshness rather than merely
 * a process that is still alive.
 */
export async function runChatGptUsageWorkerTick(
  deps: ChatGptUsageWorkerTickDeps,
): Promise<FetchResult> {
  const result = await deps.usage.fetchLatest(false);
  const snapshotStatus = typeof result.snapshot?.['status'] === 'string'
    ? result.snapshot['status']
    : 'unavailable';
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
      fetched_at: typeof result.snapshot?.['fetched_at'] === 'string'
        ? result.snapshot['fetched_at']
        : null,
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

async function main(): Promise<void> {
  const env = loadEnv();
  const { db, pool } = createDb(env);
  const log = workerLog();
  const usage = new ChatGptUsageService(db, log, {
    env,
    keyring: Keyring.fromEnv(env),
  });
  const intervalSeconds = resolveChatGptUsageWorkerIntervalSeconds(env.CHATGPT_USAGE_CRON_INTERVAL);
  let running = false;
  let stopped = false;

  const tick = async (): Promise<void> => {
    if (running || stopped) return;
    running = true;
    try {
      await runChatGptUsageWorkerTick({
        usage,
        healthPath: env.CHATGPT_USAGE_HEALTH_PATH,
        log,
      });
    } catch (err) {
      log.error({ err: errorMessage(err) }, 'chatgpt usage worker tick failed');
    } finally {
      running = false;
    }
  };

  await tick();
  const timer = setInterval(() => void tick(), intervalSeconds * 1000);
  timer.unref?.();

  const shutdown = async (signal: string): Promise<void> => {
    stopped = true;
    clearInterval(timer);
    log.info({ signal }, 'chatgpt usage worker shutdown requested');
    try {
      await pool.end();
    } catch (err) {
      log.error({ err: errorMessage(err) }, 'chatgpt usage worker database shutdown failed');
    }
    process.exit(0);
  };
  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
}

function workerLog(): WorkerLog {
  const write = (level: 'info' | 'warn' | 'error', data: Record<string, unknown>, message: string) => {
    process.stdout.write(`${JSON.stringify({ level, msg: message, time: nowIso(), ...data })}\n`);
  };
  return {
    info: (data, message) => write('info', logData(data), logMessage(message)),
    warn: (data, message) => write('warn', logData(data), logMessage(message)),
    error: (data, message) => write('error', logData(data), logMessage(message)),
  };
}

function logData(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : { detail: value ?? null };
}

function logMessage(value: unknown): string {
  return typeof value === 'string' ? value : String(value ?? '');
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  await main();
}
