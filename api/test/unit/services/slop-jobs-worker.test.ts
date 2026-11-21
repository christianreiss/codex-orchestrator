import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RouteContext } from '../../../src/routes/index.js';
import { SlopJobsService, startSlopJobsWorker } from '../../../src/services/slop-jobs.js';
import { wsPublisher } from '../../../src/ws/publisher.js';
import { loadTestEnv, testKeyring } from '../../helpers/test-keyring.js';

function start() {
  let close = async () => {};
  startSlopJobsWorker({
    log: { error: vi.fn() },
    addHook: (_event, hook) => { close = hook; },
  }, { db: {}, env: loadTestEnv(), keyring: testKeyring() } as RouteContext);
  return () => close();
}

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe('Slop worker deadlines', () => {
  it('sleeps with an empty durable queue and wakes for new work and expiry', async () => {
    vi.useFakeTimers();
    const sweep = vi.spyOn(SlopJobsService.prototype, 'sweep').mockResolvedValue(null);
    const close = start();
    try {
      await vi.advanceTimersByTimeAsync(600_000);
      expect(sweep).toHaveBeenCalledTimes(1);
      sweep.mockResolvedValueOnce(Date.now() + 86_400_000);
      wsPublisher.publish('project.slop.changed', { action: 'created' });
      await vi.advanceTimersByTimeAsync(0);
      expect(sweep).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(86_399_999);
      expect(sweep).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(1);
      expect(sweep).toHaveBeenCalledTimes(3);
    } finally { await close(); }
  });

  it('reconciles an arrival during recovery without concurrent sweeps or a lost wake', async () => {
    vi.useFakeTimers();
    let finish!: (next: number | null) => void;
    const sweep = vi.spyOn(SlopJobsService.prototype, 'sweep').mockResolvedValue(null)
      .mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const close = start();
    try {
      wsPublisher.publish('project.slop.changed', { action: 'run_started' });
      wsPublisher.publish('project.deleted', { slug: 'fixture' });
      expect(sweep).toHaveBeenCalledTimes(1);
      finish(null);
      await vi.advanceTimersByTimeAsync(1);
      expect(sweep).toHaveBeenCalledTimes(2);
    } finally { await close(); }
    wsPublisher.publish('project.slop.changed', { action: 'created' });
    await vi.advanceTimersByTimeAsync(1);
    expect(sweep).toHaveBeenCalledTimes(2);
  });
});
