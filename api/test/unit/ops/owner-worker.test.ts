import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createOwnerWorker } from '../../../src/ops/owner-worker.js';
import { DeadlineQueue } from '../../../src/control-plane/deadlines.js';
import { OwnerStateSnapshot, OwnerStateStore } from '../../../src/control-plane/state/store.js';
import type { OwnerRuntime } from '../../../src/control-plane/state/runtime.js';

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1000);
});
afterEach(() => {
  vi.useRealTimers();
});
function fixture() {
  const state = new OwnerStateStore(new OwnerStateSnapshot({ epoch: randomUUID(), sequence: 0n }, {}));
  const error = vi.fn();
  const deadlines = new DeadlineQueue(error);
  const runtime = { state, deadlines, assertOwner: vi.fn(), execute: vi.fn() } as unknown as OwnerRuntime;
  function write(value: string | null) {
    const draft = state.begin();
    if (value === null) draft.remove('versions', 'job');
    else draft.upsert('versions', { name: 'job', version: value, updatedAt: new Date().toISOString() });
    state.publish(draft.seal({ ...state.revision(), sequence: state.revision().sequence + 1n }));
  }
  const select = vi.fn((snapshot: OwnerStateSnapshot) => {
    const value = snapshot.setting('job');
    return value ? [{ key: 'job', revision: value, dueAt: Number(value) }] : [];
  });
  return { state, runtime, deadlines, error, write, select };
}

describe('owner-driven worker deadlines', () => {
  it('has no timer or work during ten quiet minutes, including future obligations', async () => {
    const f = fixture();
    const run = vi.fn();
    const worker = createOwnerWorker(f.runtime, {
      name: 'quiet',
      tables: ['versions'],
      select: f.select,
      run,
      error: f.error,
    });
    expect(vi.getTimerCount()).toBe(0);
    f.write(String(Date.now() + 1_200_000));
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(600_000);
    expect(run).not.toHaveBeenCalled();
    expect(f.error).not.toHaveBeenCalled();
    await worker.close();
    expect(vi.getTimerCount()).toBe(0);
  });
  it('does not rescan unchanged dependency views when another revision publishes', async () => {
    const f = fixture();
    const worker = createOwnerWorker(f.runtime, {
      name: 'views',
      tables: ['versions'],
      select: f.select,
      run: vi.fn(),
      error: f.error,
    });
    const draft = f.state.begin();
    f.state.publish(draft.seal({ ...f.state.revision(), sequence: 1n }));
    expect(f.select).toHaveBeenCalledTimes(1);
    await worker.close();
  });
  it('retains changed work arriving during an in-flight obligation', async () => {
    const f = fixture();
    let release!: () => void;
    const first = new Promise<void>((resolve) => {
      release = resolve;
    });
    const run = vi.fn(async () => {
      if (run.mock.calls.length === 1) await first;
      else f.write(null);
    });
    const worker = createOwnerWorker(f.runtime, {
      name: 'inflight',
      tables: ['versions'],
      select: f.select,
      run,
      error: f.error,
    });
    f.write('1000');
    await vi.advanceTimersByTimeAsync(0);
    expect(run).toHaveBeenCalledTimes(1);
    f.write('1001');
    await vi.advanceTimersByTimeAsync(1);
    release();
    await vi.advanceTimersByTimeAsync(1);
    expect(run).toHaveBeenCalledTimes(2);
    expect(f.error).not.toHaveBeenCalled();
    await worker.close();
  });
  it('fails visibly with bounded retry when a legacy writer leaves its obligation unchanged', async () => {
    const f = fixture();
    const run = vi.fn(async () => {});
    const worker = createOwnerWorker(f.runtime, {
      name: 'unmigrated',
      tables: ['versions'],
      select: f.select,
      run,
      error: f.error,
      retryMs: 5000,
    });
    f.write('1000');
    await vi.advanceTimersByTimeAsync(0);
    expect(run).toHaveBeenCalledTimes(1);
    expect(f.error).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(4999);
    expect(run).toHaveBeenCalledTimes(1);
    await worker.close();
    expect(vi.getTimerCount()).toBe(0);
  });
  it('parks an explicitly observed input until its revision changes, without losing a future deadline', async () => {
    const f = fixture();
    const run = vi.fn(async () => ({ observed: true as const }));
    const worker = createOwnerWorker(f.runtime, {
      name: 'observed',
      tables: ['versions'],
      select: (snapshot) =>
        snapshot.setting('job')
          ? [
              { key: 'input', revision: snapshot.setting('job')!, dueAt: 0 },
              { key: 'deadline', revision: snapshot.setting('job')!, dueAt: 2000 },
            ]
          : [],
      run,
      error: f.error,
    });
    f.write('a');
    await vi.advanceTimersByTimeAsync(0);
    expect(run).toHaveBeenCalledTimes(1);
    worker.wake();
    await vi.advanceTimersByTimeAsync(999);
    expect(run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(run).toHaveBeenCalledTimes(2);
    f.write('b');
    await vi.advanceTimersByTimeAsync(1);
    expect(run).toHaveBeenCalledTimes(4);
    expect(f.error).not.toHaveBeenCalled();
    await worker.close();
  });
});
