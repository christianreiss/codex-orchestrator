import { afterEach, describe, expect, it, vi } from 'vitest';
import { DeadlineQueue } from '../../../src/control-plane/deadlines.js';

afterEach(() => vi.useRealTimers());
describe('real obligation deadlines', () => {
  it('uses no timer for an idle fleet and one for any number of obligations', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const queue = new DeadlineQueue(vi.fn()),
      calls = vi.fn();
    expect(vi.getTimerCount()).toBe(0);
    for (let i = 0; i < 200; i++) queue.schedule(String(i), 700_000 + i, calls);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(600_000);
    expect(calls).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(100_200);
    expect(calls).toHaveBeenCalledTimes(200);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('replaces and cancels exact keys without stale execution', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const queue = new DeadlineQueue(vi.fn()),
      obsolete = vi.fn(),
      current = vi.fn();
    queue.schedule('same', 10, obsolete);
    queue.schedule('same', 20, current);
    queue.schedule('canceled', 5, obsolete);
    queue.cancel('canceled');
    await vi.advanceTimersByTimeAsync(15);
    expect(obsolete).not.toHaveBeenCalled();
    expect(current).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(5);
    expect(current).toHaveBeenCalledTimes(1);
    expect(queue.size()).toBe(0);
  });
  it('fires overdue work once and allows explicit retry without periodic scanning', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(100);
    const errors = vi.fn(),
      queue = new DeadlineQueue(errors),
      retry = vi.fn();
    queue.schedule('due', 50, async () => {
      queue.schedule('retry', 300, retry);
      throw new Error('retryable');
    });
    await vi.advanceTimersByTimeAsync(1);
    expect(errors).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(199);
    expect(retry).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
  it('handles clock correction and shutdown without executing a removed obligation', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const queue = new DeadlineQueue(vi.fn()),
      run = vi.fn();
    queue.schedule('expiry', 1000, run);
    vi.setSystemTime(2000);
    queue.clockChanged();
    await vi.advanceTimersByTimeAsync(0);
    expect(run).toHaveBeenCalledOnce();
    queue.schedule('later', 3000, run);
    queue.close();
    await vi.advanceTimersByTimeAsync(5000);
    expect(run).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
});
