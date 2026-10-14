import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDbFake } from '../../helpers/db-fake.js';
import { hosts as hostsTable, logs as logsTable, versions as versionsTable } from '../../../src/db/schema.js';
import { wsPublisher } from '../../../src/ws/publisher.js';
import { CommunicatorRegistry } from '../../../src/services/topology/communicator-registry.js';
import {
  CHURN_HALT_THRESHOLD,
  ROLLOUT_ADVANCED_EVENT,
  WRAPPER_ROLLOUT_KEY,
  churningHosts,
  computeAdmitted,
  confirmedHostIds,
  evaluateRollout,
  haltRollout,
  loadWrapperRollout,
  parseRolloutStages,
  promoteRollout,
  resetWrapperRolloutCache,
  resolveHostWrapperTarget,
  resumeRollout,
  setHostWrapperCanary,
  startRolloutOnPublish,
  type RolloutHost,
  type RolloutSettings,
  type WrapperRolloutState,
} from '../../../src/services/wrapper-rollout.js';

function state(overrides: Partial<WrapperRolloutState> = {}): WrapperRolloutState {
  return {
    id: 'rollout-1',
    target_version: '0.9.81',
    from_version: '0.9.80',
    stages: parseRolloutStages('canary,10,50,100'),
    stage_index: 0,
    stage_started_at: '2026-10-14T10:00:00.000Z',
    soak_minutes: 30,
    status: 'active',
    halted_reason: null,
    admitted_host_ids: [1],
    started_at: '2026-10-14T10:00:00.000Z',
    updated_at: '2026-10-14T10:00:00.000Z',
    history: [],
    ...overrides,
  };
}

const settings: RolloutSettings = { enabled: true, stages: parseRolloutStages('canary,10,50,100'), soakMinutes: 30 };

describe('resolveHostWrapperTarget', () => {
  it('holds an unadmitted host at the previous version', () => {
    expect(resolveHostWrapperTarget(state(), 2, '0.9.81')).toBe('0.9.80');
  });
  it('releases admitted hosts and hosts already on the target', () => {
    expect(resolveHostWrapperTarget(state(), 1, '0.9.81')).toBe('0.9.81');
    expect(resolveHostWrapperTarget(state(), 2, '0.9.81', '0.9.81')).toBe('0.9.81');
    expect(resolveHostWrapperTarget(state(), 2, '0.9.81', 'v0.9.82')).toBe('0.9.81');
  });
  it('keeps gating while halted', () => {
    expect(resolveHostWrapperTarget(state({ status: 'halted' }), 2, '0.9.81')).toBe('0.9.80');
  });
  it('never gates without a live rollout for exactly the fleet version', () => {
    expect(resolveHostWrapperTarget(null, 2, '0.9.81')).toBe('0.9.81');
    expect(resolveHostWrapperTarget(state({ status: 'complete' }), 2, '0.9.81')).toBe('0.9.81');
    expect(resolveHostWrapperTarget(state({ status: 'cancelled' }), 2, '0.9.81')).toBe('0.9.81');
    expect(resolveHostWrapperTarget(state(), 2, '0.9.82')).toBe('0.9.82');
    expect(resolveHostWrapperTarget(state(), 2, '2026.09.01-legacy')).toBe('2026.09.01-legacy');
  });
});

describe('parseRolloutStages', () => {
  it('parses canary and rising percentages and always ends at 100', () => {
    expect(parseRolloutStages('canary,25')).toEqual([
      { kind: 'canary' },
      { kind: 'percent', percent: 25 },
      { kind: 'percent', percent: 100 },
    ]);
  });
  it('rejects falling percentages and a late canary', () => {
    expect(() => parseRolloutStages('50,10')).toThrow();
    expect(() => parseRolloutStages('10,canary')).toThrow();
  });
});

describe('computeAdmitted', () => {
  const hosts: RolloutHost[] = [
    { id: 1, canary: true, excluded: false, running: null },
    { id: 2, canary: false, excluded: false, running: null },
    { id: 3, canary: false, excluded: false, running: null },
    { id: 4, canary: false, excluded: false, running: null },
    { id: 5, canary: false, excluded: true, running: null },
  ];
  it('admits only canaries at the canary stage', () => {
    expect(computeAdmitted(state({ admitted_host_ids: [] }), hosts, 0)).toEqual([1]);
  });
  it('moves at least one regular host per wave, stable per rollout, never an excluded one', () => {
    const tenPercent = computeAdmitted(state({ admitted_host_ids: [1] }), hosts, 1);
    expect(tenPercent).toHaveLength(2);
    expect(tenPercent).toContain(1);
    expect(computeAdmitted(state({ admitted_host_ids: [1] }), hosts, 1)).toEqual(tenPercent);
    const all = computeAdmitted(state({ admitted_host_ids: tenPercent }), hosts, 3);
    expect(all).toEqual([1, 2, 3, 4]);
  });
  it('never drops an admitted host', () => {
    expect(computeAdmitted(state({ admitted_host_ids: [9] }), hosts, 0)).toEqual([1, 9]);
  });
});

describe('confirmedHostIds and churningHosts', () => {
  it('confirms admitted hosts by report or live communicator', () => {
    const hosts: RolloutHost[] = [
      { id: 1, canary: true, excluded: false, running: '0.9.81' },
      { id: 2, canary: false, excluded: false, running: '0.9.81' },
    ];
    expect(confirmedHostIds(state({ admitted_host_ids: [1] }), hosts, [])).toEqual([1]);
    expect(confirmedHostIds(state({ admitted_host_ids: [3] }), [], [{ host_id: 3, version: '0.9.81' }])).toEqual([3]);
  });
  it('counts only self-closed target-version owners since the stage began', () => {
    const t = (over: Partial<{ reason: string; version: string; ended_at: string }> = {}) => ({
      host_id: 1,
      username: 'chris',
      version: '0.9.81',
      ended_at: '2026-10-14T10:05:00.000Z',
      reason: 'peer_closed',
      ...over,
    });
    const few = Array.from({ length: CHURN_HALT_THRESHOLD - 1 }, () => t());
    expect(churningHosts(state(), few)).toEqual([]);
    expect(churningHosts(state(), [...few, t()])).toEqual([1]);
    expect(churningHosts(state(), [...few, t({ reason: 'admin_terminate' })])).toEqual([]);
    expect(churningHosts(state(), [...few, t({ version: '0.9.80' })])).toEqual([]);
    expect(churningHosts(state(), [...few, t({ ended_at: '2026-10-14T09:00:00.000Z' })])).toEqual([]);
  });
});

describe('rollout lifecycle', () => {
  let db: ReturnType<typeof createDbFake>;
  const published: string[] = [];
  let unsubscribe: () => void;

  beforeEach(() => {
    resetWrapperRolloutCache();
    db = createDbFake();
    db.tables.set(hostsTable, [
      { id: 1, wrapperCanary: 1, autoUpdateOverride: null, wrapperVersion: '0.9.80', claudeWrapperVersion: null, grokWrapperVersion: null },
      { id: 2, wrapperCanary: 0, autoUpdateOverride: null, wrapperVersion: '0.9.80', claudeWrapperVersion: null, grokWrapperVersion: null },
      { id: 3, wrapperCanary: 0, autoUpdateOverride: null, wrapperVersion: '0.9.80', claudeWrapperVersion: null, grokWrapperVersion: null },
    ]);
    db.tables.set(versionsTable, []);
    db.tables.set(logsTable, []);
    published.length = 0;
    unsubscribe = wsPublisher.subscribe((e) => published.push(e.type));
  });
  afterEach(() => {
    unsubscribe();
    vi.useRealTimers();
  });

  const fresh = async () => {
    resetWrapperRolloutCache();
    return (await loadWrapperRollout(db as never))!;
  };

  it('does nothing while the flag is off', async () => {
    await startRolloutOnPublish(db as never, { ...settings, enabled: false }, '0.9.80', '0.9.81');
    expect(await fresh()).toBeNull();
  });

  it('starts at canary, waits for soak and a confirmed host, then advances and publishes', async () => {
    const started = await startRolloutOnPublish(db as never, settings, '0.9.80', '0.9.81');
    expect(started).toMatchObject({ status: 'active', stage_index: 0, admitted_host_ids: [1], from_version: '0.9.80' });
    expect(published).toContain(ROLLOUT_ADVANCED_EVENT);
    expect(db.tables.get(versionsTable)!.filter((r) => r.name === WRAPPER_ROLLOUT_KEY)).toHaveLength(1);

    // Idempotent on the same target.
    expect((await startRolloutOnPublish(db as never, settings, '0.9.80', '0.9.81'))!.id).toBe(started!.id);

    const registry = new CommunicatorRegistry();
    const soakStart = Date.parse(started!.stage_started_at);
    expect((await evaluateRollout(db as never, { now: soakStart + 60_000, registry })).advanced).toBe(false);
    // Soaked, but the canary still runs the old build: lag is not failure, just wait.
    expect((await evaluateRollout(db as never, { now: soakStart + 31 * 60_000, registry })).advanced).toBe(false);

    db.tables.get(hostsTable)![0]!.wrapperVersion = '0.9.81';
    published.length = 0;
    const result = await evaluateRollout(db as never, { now: soakStart + 31 * 60_000, registry });
    expect(result.advanced).toBe(true);
    const after = await fresh();
    expect(after.stage_index).toBe(1);
    expect(after.admitted_host_ids.length).toBe(2);
    expect(published).toContain(ROLLOUT_ADVANCED_EVENT);
  });

  it('needs a host from the current wave, not just the canary, before the next wave', async () => {
    const started = await startRolloutOnPublish(db as never, settings, '0.9.80', '0.9.81');
    const registry = new CommunicatorRegistry();
    db.tables.get(hostsTable)![0]!.wrapperVersion = '0.9.81';
    const t0 = Date.parse(started!.stage_started_at);
    expect((await evaluateRollout(db as never, { now: t0 + 31 * 60_000, registry })).advanced).toBe(true);
    const tenPercent = await fresh();
    expect(tenPercent.stage_host_ids).toHaveLength(1);
    const waveHost = tenPercent.stage_host_ids![0]!;
    const t1 = Date.parse(tenPercent.stage_started_at);
    // Soaked, canary still fine, but the wave's own host is stuck on the old build.
    expect((await evaluateRollout(db as never, { now: t1 + 31 * 60_000, registry })).advanced).toBe(false);
    db.tables.get(hostsTable)!.find((h) => h.id === waveHost)!.wrapperVersion = '0.9.81';
    expect((await evaluateRollout(db as never, { now: t1 + 31 * 60_000, registry })).advanced).toBe(true);
  });

  it('halts, refuses to advance while halted, resumes with a fresh soak', async () => {
    await startRolloutOnPublish(db as never, settings, '0.9.80', '0.9.81');
    await haltRollout(db as never, 'ops', 'looks wrong');
    db.tables.get(hostsTable)![0]!.wrapperVersion = '0.9.81';
    expect((await evaluateRollout(db as never, { now: Date.now() + 3_600_000, registry: new CommunicatorRegistry() })).advanced).toBe(false);
    expect((await fresh()).status).toBe('halted');
    const resumed = await resumeRollout(db as never, 'ops');
    expect(resumed.status).toBe('active');
    expect(resumed.halted_reason).toBeNull();
  });

  it('auto-halts on new-version owner churn', async () => {
    await startRolloutOnPublish(db as never, settings, '0.9.80', '0.9.81');
    const registry = new CommunicatorRegistry();
    for (let i = 0; i < CHURN_HALT_THRESHOLD; i++) {
      const id = `00000000-0000-4000-8000-00000000000${i}`;
      registry.register(
        { id, host_id: 1, username: 'chris', version: '0.9.81', connected_at: new Date().toISOString(), sessions: 0, requests: 0, synced_at: null },
        { close() {}, remoteAddress: null },
      );
      registry.unregister(id);
    }
    const result = await evaluateRollout(db as never, { registry });
    expect(result.halted).toBe(true);
    expect((await fresh()).halted_reason).toMatch(/host 1/);
  });

  it('promotes through every stage to complete', async () => {
    await startRolloutOnPublish(db as never, settings, '0.9.80', '0.9.81');
    for (let i = 0; i < settings.stages.length; i++) await promoteRollout(db as never, 'ops');
    const done = await fresh();
    expect(done.status).toBe('complete');
    expect(resolveHostWrapperTarget(done, 3, '0.9.81')).toBe('0.9.81');
  });

  it('supersedes with a newer release from the same floor and cancels on a downgrade', async () => {
    const first = await startRolloutOnPublish(db as never, settings, '0.9.80', '0.9.81');
    const second = await startRolloutOnPublish(db as never, settings, '0.9.81', '0.9.82');
    expect(second!.id).not.toBe(first!.id);
    expect(second).toMatchObject({ from_version: '0.9.80', target_version: '0.9.82', stage_index: 0 });
    const cancelled = await startRolloutOnPublish(db as never, settings, '0.9.82', '0.9.80');
    expect(cancelled!.status).toBe('cancelled');
  });

  it('admits a new canary into a running rollout at once', async () => {
    await startRolloutOnPublish(db as never, settings, '0.9.80', '0.9.81');
    expect(await setHostWrapperCanary(db as never, 3, true, 'ops')).toBe(true);
    expect((await fresh()).admitted_host_ids).toEqual([1, 3]);
  });
});
