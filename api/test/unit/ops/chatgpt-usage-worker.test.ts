import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_CHATGPT_USAGE_CRON_INTERVAL_SECONDS,
  createChatGptUsageWorkerLifecycle,
  resolveChatGptUsageWorkerIntervalSeconds,
  runChatGptUsageWorkerTick,
} from '../../../src/ops/chatgpt-usage-worker.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('chatgpt usage worker tick', () => {
  it('defaults to a 15-minute cadence, safely below the wrapper stale threshold', () => {
    expect(resolveChatGptUsageWorkerIntervalSeconds(undefined)).toBe(
      DEFAULT_CHATGPT_USAGE_CRON_INTERVAL_SECONDS,
    );
    expect(DEFAULT_CHATGPT_USAGE_CRON_INTERVAL_SECONDS).toBe(15 * 60);
  });

  it('records a heartbeat only for a usable provider snapshot', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'codex-quota-worker-'));
    tempDirs.push(dir);
    const healthPath = join(dir, 'health.json');
    const info = vi.fn();

    await runChatGptUsageWorkerTick({
      usage: {
        fetchLatest: async () => ({
          status: 'ok',
          snapshot: { status: 'ok', fetched_at: '2026-07-17T08:00:00Z' },
          cached: false,
          next_eligible_at: '2026-07-17T08:05:00Z',
        }),
      },
      healthPath,
      log: { info, warn: vi.fn(), error: vi.fn() },
      now: () => '2026-07-17T08:00:01Z',
    });

    await expect(readFile(healthPath, 'utf8')).resolves.toBe(
      '{"checked_at":"2026-07-17T08:00:01Z","fetched_at":"2026-07-17T08:00:00Z","next_eligible_at":"2026-07-17T08:05:00Z"}\n',
    );
    expect(info).toHaveBeenCalledWith(expect.objectContaining({ cached: false }), 'chatgpt usage refresh succeeded');
  });

  it('does not mark an error snapshot healthy', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'codex-quota-worker-'));
    tempDirs.push(dir);
    const healthPath = join(dir, 'health.json');
    const warn = vi.fn();

    await runChatGptUsageWorkerTick({
      usage: {
        fetchLatest: async () => ({
          status: 'ok',
          snapshot: { status: 'error', fetched_at: '2026-07-17T08:00:00Z' },
          cached: true,
          next_eligible_at: '2026-07-17T08:05:00Z',
          error: 'HTTP 401',
        }),
      },
      healthPath,
      log: { info: vi.fn(), warn, error: vi.fn() },
    });

    await expect(readFile(healthPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ snapshot_status: 'error', error: 'HTTP 401' }),
      'chatgpt usage refresh failed',
    );
  });

  it('does not mark a failed refresh healthy merely because the cached observation is usable', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'codex-quota-worker-'));
    tempDirs.push(dir);
    const healthPath = join(dir, 'health.json');
    await runChatGptUsageWorkerTick({
      usage: { fetchLatest: async () => ({
        status: 'error', snapshot: { status: 'ok', fetched_at: '2026-10-11T08:00:00Z' },
        cached: true, next_eligible_at: '2026-10-11T08:05:00Z', error: 'request timed out',
      }) },
      healthPath, log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });
    await expect(readFile(healthPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('polls nothing while Codex is switched off fleet-wide, and stays healthy', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'codex-quota-worker-'));
    tempDirs.push(dir);
    const healthPath = join(dir, 'health.json');
    const fetchLatest = vi.fn();
    const info = vi.fn();

    const result = await runChatGptUsageWorkerTick({
      usage: { fetchLatest },
      healthPath,
      log: { info, warn: vi.fn(), error: vi.fn() },
      now: () => '2026-10-03T08:00:00Z',
      codexEnabled: async () => false,
    });

    expect(fetchLatest).not.toHaveBeenCalled();
    expect(result).toMatchObject({ status: 'unavailable', error: 'engine_disabled' });
    // Deliberately off is not a failing container.
    expect(JSON.parse(await readFile(healthPath, 'utf8'))).toMatchObject({
      checked_at: '2026-10-03T08:00:00Z',
      suspended: 'codex_engine_disabled',
    });
    expect(info).toHaveBeenCalledWith({ reason: 'engine_disabled' }, expect.stringContaining('suspended'));
  });
});


describe('ChatGPT worker shutdown', () => {
  it('cancels the initial tick and waits for its cleanup before closing the pool once', async () => {
    let finish!: () => void;
    let signal!: AbortSignal;
    const close = vi.fn(async () => undefined);
    const tick = vi.fn(async (incoming: AbortSignal) => {
      signal = incoming;
      await new Promise<void>((resolve) => { finish = resolve; });
    });
    const worker = createChatGptUsageWorkerLifecycle({
      tick, close, intervalMs: 30_000, log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });
    const initial = worker.start();
    await Promise.resolve();
    const stopped = worker.stop();
    expect(signal.aborted).toBe(true);
    expect(worker.stop()).toBe(stopped);
    await worker.start();
    expect(close).not.toHaveBeenCalled();
    expect(tick).toHaveBeenCalledTimes(1);
    finish();
    await Promise.all([stopped, initial]);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('never starts a tick when a signal arrives before startup', async () => {
    const tick = vi.fn();
    const close = vi.fn(async () => undefined);
    const worker = createChatGptUsageWorkerLifecycle({
      tick, close, intervalMs: 30_000, log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });
    await worker.stop();
    await worker.start();
    expect(tick).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledTimes(1);
  });
});
