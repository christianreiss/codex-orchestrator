import { describe, it, expect, vi } from 'vitest';
import {
  RetentionDeadlineIndex,
  RETENTION_FAMILIES,
} from '../../../src/services/server-retention/deadlines.js';

describe('cold retention deadline index', () => {
  it('requires complete hydration and schedules nothing for empty history', async () => {
    const index = new RetentionDeadlineIndex();
    expect(() => index.obligations()).toThrow('hydrate');
    const read = vi.fn(async () => ({ past: false, next: null }));
    await index.hydrate(read, 1000);
    expect(read).toHaveBeenCalledTimes(RETENTION_FAMILIES.length);
    expect(index.obligations()).toEqual([]);
  });
  it('does not let a guarded past row hide a future eligible deadline', async () => {
    const index = new RetentionDeadlineIndex();
    await index.hydrate(
      async (family) => (family === 'rooms' ? { past: true, next: 5000 } : { past: false, next: null }),
      1000,
    );
    expect(index.obligations()).toEqual([{ key: 'history:rooms', dueAt: 0, revision: '1' }]);
    index.publishSweep('rooms', { past: true, next: 5000 }, 0);
    expect(index.obligations()[0]?.dueAt).toBe(5000);
    index.publishSweep('rooms', { past: true, next: null }, 0);
    expect(index.obligations()).toEqual([]);
    index.invalidate(['rooms']);
    expect(index.obligations()[0]?.dueAt).toBe(0);
  });
  it('drains bounded batches then sleeps, and wakes on a committed cold append', async () => {
    const index = new RetentionDeadlineIndex();
    await index.hydrate(async () => ({ past: false, next: null }), 1000);
    const wake = vi.fn();
    const unsubscribe = index.subscribe(wake);
    index.stage('conversations', 900, 1000);
    index.publishSweep('conversations', { past: true, next: 8000 }, 100);
    expect(index.obligations()[0]?.dueAt).toBe(0);
    index.publishSweep('conversations', { past: false, next: 8000 }, 7);
    expect(index.obligations()[0]?.dueAt).toBe(8000);
    index.stage('conversations', 4000, 1000);
    expect(index.obligations()[0]?.dueAt).toBe(4000);
    expect(wake).toHaveBeenCalledTimes(4);
    unsubscribe();
    index.stage('conversations', 3000, 1000);
    expect(wake).toHaveBeenCalledTimes(4);
  });
  it('does not publish a partially hydrated index after a failed boot read', async () => {
    const index = new RetentionDeadlineIndex();
    await expect(
      index.hydrate(async (family) => {
        if (family === 'rooms') throw new Error('offline');
        return { past: true, next: null };
      }),
    ).rejects.toThrow('offline');
    expect(() => index.obligations()).toThrow('hydrate');
  });
});
