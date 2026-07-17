import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runChatGptUsageWorkerTick } from '../../../src/ops/chatgpt-usage-worker.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('chatgpt usage worker tick', () => {
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
});
