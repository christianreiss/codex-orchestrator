import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { OwnerStateSnapshot, OwnerStateStore } from '../../../src/control-plane/state/store.js';
import { DeadlineQueue } from '../../../src/control-plane/deadlines.js';
import type { OwnerRuntime } from '../../../src/control-plane/state/runtime.js';
import type { AuthVerificationTickDeps } from '../../../src/ops/auth-verification-worker.js';

const mocks = vi.hoisted(() => ({ runtime: undefined as unknown, tick: vi.fn() }));
vi.mock('../../../src/control-plane/state/runtime.js', async (original) => ({
  ...(await original<typeof import('../../../src/control-plane/state/runtime.js')>()),
  requireOwnerRuntime: () => mocks.runtime,
}));
vi.mock('../../../src/services/runner-client.js', () => ({ createRunnerClient: () => ({}) }));
vi.mock('../../../src/services/runner-validation.js', () => ({ createRunnerValidationService: () => ({}) }));
vi.mock('../../../src/services/canonical-auth-store.js', () => ({ createCanonicalAuthStoreService: () => ({}) }));
vi.mock('../../../src/services/agent-messaging.js', () => ({ AgentMessagingService: class {} }));
vi.mock('../../../src/ops/auth-verification-worker.js', async (original) => ({
  ...(await original<typeof import('../../../src/ops/auth-verification-worker.js')>()),
  runAuthVerificationWorkerTick: (deps: AuthVerificationTickDeps) => mocks.tick(deps),
}));
import { createOwnerProviderMaintenance } from '../../../src/ops/owner-provider-maintenance.js';
import { createOwnerWorker } from '../../../src/ops/owner-worker.js';
import type { RouteContext } from '../../../src/routes/index.js';
import type { FastifyInstance } from 'fastify';

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(1000); mocks.tick.mockReset(); });
afterEach(() => { vi.useRealTimers(); });

function fixture(afterRun?: () => void, probeAt?: number) {
  const state = new OwnerStateStore(new OwnerStateSnapshot({ epoch: randomUUID(), sequence: 0n }, {}));
  const error = vi.fn();
  const runtime = { state, deadlines: new DeadlineQueue(error), assertOwner: vi.fn() } as unknown as OwnerRuntime;
  mocks.runtime = runtime;
  const handlers = createOwnerProviderMaintenance({ log: {} } as FastifyInstance, {
    db: {}, keyring: {}, env: { AUTH_RUNNER_VERIFY_TTL_SECONDS: 1, AUTH_RUNNER_VERIFY_MAX_INTERVAL_SECONDS: 1 },
  } as unknown as RouteContext);
  let ran = false;
  const worker = createOwnerWorker(runtime, {
    name: 'auth-verification', tables: [],
    select: () => {
      if (ran) afterRun?.();
      return [{ key: 'input:codex', revision: 'unchanged-input', dueAt: 0 },
        ...(probeAt === undefined ? [] : [{ key: 'probe:codex', revision: 'unchanged-input', dueAt: probeAt }])];
    },
    run: async (work) => { const result = await handlers['auth-verification'](work); ran = true; return result; },
    error,
  });
  return { runtime, worker, error };
}

function attempt(deps: AuthVerificationTickDeps, at: number) {
  deps.scheduleMemory!.set('codex', { rowId: 1, digest: 'fixture', checkedAtAtAttempt: null, lastAttemptMs: at, attempts: 1 });
}

describe('owner auth verification retry deadlines', () => {
  it('keeps a valid retry future when completion rescan advances the clock', async () => {
    mocks.tick.mockImplementation(async (deps: AuthVerificationTickDeps) => { attempt(deps, Date.now() - 1000); });
    let delayed = false;
    const f = fixture(() => { if (!delayed) { delayed = true; vi.setSystemTime(Date.now() + 2); } });
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(mocks.tick).toHaveBeenCalledTimes(1);
      expect(f.error).not.toHaveBeenCalled();
      expect(f.runtime.deadlines.next()).toBeGreaterThan(Date.now());
    } finally { await f.worker.close(); }
  });

  it('bounds a skipped unchanged expired attempt instead of hot-looping or forgetting retries', async () => {
    let calls = 0;
    mocks.tick.mockImplementation(async (deps: AuthVerificationTickDeps) => {
      calls++;
      if (calls === 1) attempt(deps, Date.now());
    });
    const f = fixture();
    try {
      await vi.advanceTimersByTimeAsync(1001);
      expect(mocks.tick).toHaveBeenCalledTimes(2);
      expect(f.runtime.deadlines.next()).toBe(32001);
      await vi.advanceTimersByTimeAsync(29_999);
      expect(mocks.tick).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(1);
      expect(mocks.tick).toHaveBeenCalledTimes(3);
      expect(f.error).not.toHaveBeenCalled();
      expect(f.runtime.deadlines.next()).toBe(62001);
    } finally { await f.worker.close(); }
  });

  it('uses the existing bounded recovery delay if a real attempt outlives its backoff', async () => {
    mocks.tick.mockImplementation(async (deps: AuthVerificationTickDeps) => { attempt(deps, Date.now() - 2000); });
    const f = fixture();
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(f.error).not.toHaveBeenCalled();
      expect(f.runtime.deadlines.next()).toBe(Date.now() + 30_000);
      await vi.advanceTimersByTimeAsync(29_999);
      expect(mocks.tick).toHaveBeenCalledTimes(1);
    } finally { await f.worker.close(); }
  });

  it('keeps a persisted future probe ahead of the bounded stale-attempt retry', async () => {
    let calls = 0;
    mocks.tick.mockImplementation(async (deps: AuthVerificationTickDeps) => {
      calls++;
      if (calls === 1 || calls === 3) attempt(deps, Date.now());
    });
    const f = fixture(undefined, 4000);
    try {
      await vi.advanceTimersByTimeAsync(2999);
      expect(mocks.tick).toHaveBeenCalledTimes(2);
      expect(f.runtime.deadlines.next()).toBe(4000);
      await vi.advanceTimersByTimeAsync(1);
      expect(mocks.tick).toHaveBeenCalledTimes(3);
      expect(f.runtime.deadlines.next()).toBe(5001);
      expect(f.error).not.toHaveBeenCalled();
    } finally { await f.worker.close(); }
  });

});
