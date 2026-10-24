import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startAuthRetentionWorker } from '../../../src/ops/auth-retention-worker.js';
import { ownerWorkerFixture } from '../../helpers/owner-worker.js';
import type { StateSeed } from '../../../src/control-plane/state/catalog.js';

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(1_000_000); });
afterEach(() => { vi.useRealTimers(); });
describe('owner auth retention worker', () => {
  it('does no work or recurring timer with empty auth history', async () => {
    const f = await ownerWorkerFixture(); startAuthRetentionWorker(f.app, f.db);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(f.run).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0); await f.close();
  });
  it('drains successive bounded batches while due metadata remains', async () => {
    const rows = Array.from({ length: 507 }, (_, i) => ({ id: i + 1, accountId: null, supersededAt: new Date(100).toISOString(), purgeAfter: new Date(200).toISOString() }));
    const f = await ownerWorkerFixture({ authPayloads: rows } as unknown as StateSeed);
    f.run.mockImplementation(async operation => {
      expect(operation).toBe('auth-retention');
      const draft = f.state.begin();
      for (const row of draft.table('authPayloads').all().slice(0, 500)) draft.remove('authPayloads', row.id);
      f.state.publish(draft.seal({ ...f.state.revision(), sequence: f.state.revision().sequence + 1n }));
    });
    startAuthRetentionWorker(f.app, f.db); await vi.advanceTimersByTimeAsync(2);
    expect(f.run).toHaveBeenCalledTimes(2); expect(f.state.snapshot().table('authPayloads').size).toBe(0);
    expect(f.error).not.toHaveBeenCalled(); await f.close();
  });
  it('protects canonical and removed-account generations before scheduling', async () => {
    const due = { supersededAt: new Date(100).toISOString(), purgeAfter: new Date(200).toISOString() };
    const f = await ownerWorkerFixture({ authPayloads: [{ id: 1, accountId: null, ...due }, { id: 2, accountId: 7, ...due }], authCanonicalHeads: [{ engine: 'codex', payloadId: 1 }], providerAccounts: [{ id: 7, state: 'removed', payloadId: null }] } as unknown as StateSeed);
    startAuthRetentionWorker(f.app, f.db); await vi.advanceTimersByTimeAsync(600_000);
    expect(f.run).not.toHaveBeenCalled(); await f.close();
  });
});
