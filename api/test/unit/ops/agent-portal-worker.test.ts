import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../../../src/env.js';
import type { Keyring } from '../../../src/security/keyring.js';
import { startAgentPortalWorker } from '../../../src/ops/agent-portal-worker.js';
import { ownerWorkerFixture } from '../../helpers/owner-worker.js';
import type { StateSeed } from '../../../src/control-plane/state/catalog.js';

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(1_000_000); });
afterEach(() => { vi.useRealTimers(); });
describe('owner portal retention', () => {
  it('does no empty sweep during ten quiet minutes', async () => {
    const f = await ownerWorkerFixture(); startAgentPortalWorker(f.app, f.db, {} as Env, {} as Keyring);
    await vi.advanceTimersByTimeAsync(600_000);
    expect(f.run).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0); await f.close();
  });
  it('retains a native lifecycle with an expired stored bridge while reconnecting', async () => {
    const f = await ownerWorkerFixture({ agentSessions: [{ id: 'native', endedAt: null, bridgeExpiresAt: new Date(0).toISOString(), receiver: null }] } as unknown as StateSeed);
    startAgentPortalWorker(f.app, f.db, {} as Env, {} as Keyring);
    await vi.advanceTimersByTimeAsync(600_000);
    expect(f.run).not.toHaveBeenCalled(); await f.close();
  });
  it('runs a known future history deadline without traffic and drains on shutdown', async () => {
    const f = await ownerWorkerFixture();
    f.retention.stage('rooms', Date.now() + 20_000);
    f.run.mockImplementation(async () => { f.retention.publishSweep('rooms', { past: false, next: null }, 1); });
    startAgentPortalWorker(f.app, f.db, {} as Env, {} as Keyring);
    await vi.advanceTimersByTimeAsync(19_999); expect(f.run).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1); expect(f.run).toHaveBeenCalledTimes(1);
    await f.close(); expect(vi.getTimerCount()).toBe(0);
  });
});
