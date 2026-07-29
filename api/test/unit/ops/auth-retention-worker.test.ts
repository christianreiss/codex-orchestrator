import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Database } from '../../../src/db/client.js';

/**
 * The daily prune scheduler, with the deletion itself stubbed out — the SQL is
 * `test/db/*` territory. What only lives here is the drain loop: a full batch
 * means the last `pruneSupersededAuth` call hit its row cap and more history is
 * waiting, so the worker has to keep asking until a short batch says the table
 * is clean. The stub returns exactly `AUTH_PRUNE_BATCH_LIMIT` rather than a
 * hand-picked 500, so lowering the constant cannot silently reduce the drain to
 * a single batch.
 */

const retention = vi.hoisted(() => ({
  pruneSupersededAuth: vi.fn<(db: Database, now?: string, limit?: number) => Promise<number>>(),
}));

vi.mock('../../../src/services/auth-generation-retention.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/services/auth-generation-retention.js')>()),
  pruneSupersededAuth: retention.pruneSupersededAuth,
}));

import { startAuthRetentionWorker } from '../../../src/ops/auth-retention-worker.js';
import { AUTH_PRUNE_BATCH_LIMIT } from '../../../src/services/auth-generation-retention.js';

// Mirrors the worker's own (unexported) cadence: a 5s settling delay after
// boot, then once a day.
const FIRST_RUN_MS = 5_000;
const RETENTION_INTERVAL_MS = 24 * 60 * 60 * 1000;

const prune = retention.pruneSupersededAuth;
const db = {} as Database;

interface Worker {
  info: ReturnType<typeof vi.fn>;
  warn: ReturnType<typeof vi.fn>;
  /** Runs the registered `onClose` hooks, as Fastify's shutdown would. */
  close: () => Promise<void>;
}

function startWorker(): Worker {
  const info = vi.fn();
  const warn = vi.fn();
  const closers: Array<() => Promise<void>> = [];
  const app = {
    log: { info, warn },
    addHook: (name: string, handler: () => Promise<void>) => {
      if (name === 'onClose') closers.push(handler);
    },
  } as unknown as FastifyInstance;
  startAuthRetentionWorker(app, db);
  return {
    info,
    warn,
    close: async () => {
      for (const closer of closers) await closer();
    },
  };
}

/** A prune call the test decides the outcome of, to hold a run open. */
function pending(): { promise: Promise<number>; settle: (removed: number) => void } {
  let settle!: (removed: number) => void;
  const promise = new Promise<number>((resolve) => {
    settle = resolve;
  });
  return { promise, settle };
}

beforeEach(() => {
  vi.useFakeTimers();
  prune.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('auth retention worker', () => {
  it('keeps pruning while batches come back full and logs the drained total', async () => {
    prune.mockResolvedValueOnce(AUTH_PRUNE_BATCH_LIMIT).mockResolvedValueOnce(7);
    const worker = startWorker();

    // Nothing runs during boot; the first tick is deliberately delayed.
    await vi.advanceTimersByTimeAsync(FIRST_RUN_MS - 1);
    expect(prune).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);

    expect(prune).toHaveBeenCalledTimes(2);
    expect(prune).toHaveBeenCalledWith(db);
    // One line per drain, not one per batch: the total is what an operator reads.
    expect(worker.info).toHaveBeenCalledTimes(1);
    expect(worker.info).toHaveBeenCalledWith(
      { removed: AUTH_PRUNE_BATCH_LIMIT + 7 },
      'superseded auth history pruned',
    );
  });

  it('stays silent when the first batch already comes back short', async () => {
    prune.mockResolvedValue(0);
    const worker = startWorker();

    await vi.advanceTimersByTimeAsync(FIRST_RUN_MS);

    expect(prune).toHaveBeenCalledTimes(1);
    expect(worker.info).not.toHaveBeenCalled();
  });

  it('warns on a failing prune and is still armed for the next day', async () => {
    const failure = new Error('deadlock while deleting auth payloads');
    prune.mockRejectedValueOnce(failure).mockResolvedValue(0);
    const worker = startWorker();

    await vi.advanceTimersByTimeAsync(FIRST_RUN_MS);

    expect(worker.warn).toHaveBeenCalledWith({ err: failure }, 'auth retention worker failed');
    expect(worker.info).not.toHaveBeenCalled();

    // The rejection must not leave the re-entrancy guard latched shut.
    await vi.advanceTimersByTimeAsync(RETENTION_INTERVAL_MS);
    expect(prune).toHaveBeenCalledTimes(2);
  });

  it('does not start a second run on top of one still in flight', async () => {
    const inFlight = pending();
    prune.mockReturnValueOnce(inFlight.promise).mockResolvedValue(0);
    const worker = startWorker();

    await vi.advanceTimersByTimeAsync(FIRST_RUN_MS);
    expect(prune).toHaveBeenCalledTimes(1);

    // A long prune outliving its interval must not stack a second drain loop
    // on the same rows.
    await vi.advanceTimersByTimeAsync(RETENTION_INTERVAL_MS);
    expect(prune).toHaveBeenCalledTimes(1);

    inFlight.settle(0);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(RETENTION_INTERVAL_MS);
    expect(prune).toHaveBeenCalledTimes(2);
    expect(worker.info).not.toHaveBeenCalled();
  });

  it('stops pruning once the server closes', async () => {
    prune.mockResolvedValue(0);
    const worker = startWorker();

    await worker.close();

    await vi.advanceTimersByTimeAsync(FIRST_RUN_MS + RETENTION_INTERVAL_MS * 2);
    expect(prune).not.toHaveBeenCalled();
  });
});
