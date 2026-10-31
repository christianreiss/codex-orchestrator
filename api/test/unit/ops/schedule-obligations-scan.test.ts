import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { dependencyRevision, scheduleObligations } from '../../../src/ops/schedule-obligations.js';
import type { OwnerWorkObligation } from '../../../src/ops/owner-worker.js';
import { EntityView, OwnerStateSnapshot } from '../../../src/control-plane/state/store.js';
import type { StateSeed } from '../../../src/control-plane/state/catalog.js';
import { SCHEDULE_TARGET_GRACE_SECONDS } from '../../../src/services/schedules/staleness.js';
import { SCHEDULE_TABLES } from '../../../src/ops/schedule-obligations.js';

const now = '2026-10-31T20:00:00.000Z';
const active = new Set(['waiting', 'queued', 'leased', 'accepted', 'recovering', 'capacity_wait']);

/** The pre-optimisation algorithm: rescans the run and watchdog tables once per schedule. */
function oracle(snapshot: OwnerStateSnapshot, presenceRevision = ''): OwnerWorkObligation[] {
  const revision = `${dependencyRevision(snapshot, SCHEDULE_TABLES)}:${presenceRevision}`;
  const result: OwnerWorkObligation[] = [];
  const add = (key: string, value: string | null | undefined, delay = 0) => {
    const dueAt = value ? Date.parse(value) + delay : NaN;
    if (Number.isFinite(dueAt)) result.push({ key, dueAt, revision });
  };
  for (const schedule of snapshot.table('agentSchedules').all()) {
    if (schedule.deletedAt) continue;
    const runs = snapshot
      .table('agentScheduleRuns')
      .all()
      .filter((run) => run.scheduleId === schedule.id);
    const liveRuns = runs.filter((run) => active.has(run.status));
    if (schedule.enabled || liveRuns.length) result.push({ key: `input:${schedule.id}`, dueAt: 0, revision });
    if (schedule.enabled && !liveRuns.length) add(`due:${schedule.id}`, schedule.nextDueAt);
    for (const run of liveRuns) {
      if (['waiting', 'recovering', 'capacity_wait'].includes(run.status))
        add(`retry:${run.id}`, run.nextAttemptAt);
    }
    if (
      snapshot
        .table('agentWatchdogs')
        .all()
        .some((row) => row.scheduleId === schedule.id)
    )
      continue;
    const grace = SCHEDULE_TARGET_GRACE_SECONDS * 1000;
    if (schedule.kind === 'once' && schedule.nextDueAt === null && !liveRuns.length) {
      const last =
        runs
          .map((row) => row.updatedAt)
          .sort()
          .at(-1) ?? schedule.updatedAt;
      add(`retire:${schedule.id}`, last, grace);
    }
    const target = snapshot.addresses.get(schedule.targetAddressId);
    if (!schedule.enabled || (schedule.persistent && target && !target.archivedAt)) continue;
    const session = target?.currentSessionId ? snapshot.sessions.get(target.currentSessionId) : undefined;
    const since = !target
      ? new Date(0).toISOString()
      : (target.archivedAt ??
        (session?.endedAt
          ? [session.endedAt, target.lastSeenAt].sort().at(-1)!
          : session
            ? null
            : target.lastSeenAt));
    add(`gone:${schedule.id}`, since, grace);
  }
  return result;
}

function seed(count: number): StateSeed {
  const schedules = [];
  const runs = [];
  const watchdogs = [];
  const statuses = ['accepted', 'waiting', 'recovering', 'capacity_wait', 'completed', 'failed'];
  for (let i = 0; i < count; i++) {
    const id = `s${i}`;
    schedules.push({
      id,
      enabled: i % 3 === 0 ? 0 : 1,
      deletedAt: i % 11 === 0 ? now : null,
      kind: i % 4 === 0 ? 'once' : 'cron',
      persistent: i % 2,
      nextDueAt: i % 5 === 0 ? null : '2026-11-01T00:00:00.000Z',
      targetAddressId: `a${i}`,
      version: 1,
      updatedAt: now,
    });
    for (let r = 0; r < i % 4; r++)
      runs.push({
        id: `${id}-r${r}`,
        scheduleId: id,
        targetAddressId: `a${i}`,
        messageId: `m${i}-${r}`,
        status: statuses[(i + r) % statuses.length],
        persistent: 1,
        nextAttemptAt: '2026-10-31T21:00:00.000Z',
        createdAt: now,
        updatedAt: `2026-10-31T19:0${r}:00.000Z`,
      });
    if (i % 6 === 0)
      watchdogs.push({ id: `w${i}`, scheduleId: id, status: 'watching', deadlineAt: now, updatedAt: now });
  }
  return { agentSchedules: schedules, agentScheduleRuns: runs, agentWatchdogs: watchdogs } as unknown as StateSeed;
}

const snapshotOf = (count: number) =>
  new OwnerStateSnapshot({ epoch: randomUUID(), sequence: 0n }, seed(count));

describe('scheduleObligations table scans', () => {
  it('returns exactly what the per-schedule rescanning algorithm returned', () => {
    const snapshot = snapshotOf(120);
    const actual = scheduleObligations(snapshot, '7');
    expect(actual.length).toBeGreaterThan(100);
    expect(actual).toEqual(oracle(snapshot, '7'));
  });
  it('reads each table once however many schedules exist', () => {
    const snapshot = snapshotOf(150);
    const all = vi.spyOn(EntityView.prototype, 'all');
    try {
      scheduleObligations(snapshot);
      const small = all.mock.calls.length;
      all.mockClear();
      scheduleObligations(snapshotOf(15));
      expect(small).toBeLessThanOrEqual(3);
      expect(all.mock.calls.length).toBeLessThanOrEqual(3);
    } finally {
      all.mockRestore();
    }
  });
});

describe('EntityView.all', () => {
  it('returns one frozen array per immutable view', () => {
    const snapshot = snapshotOf(5);
    const view = snapshot.table('agentSchedules');
    const first = view.all();
    expect(first).toHaveLength(5);
    expect(Object.isFrozen(first)).toBe(true);
    expect(view.all()).toBe(first);
    // A different (replaced) view never observes another view's cache.
    const replaced = new OwnerStateSnapshot(
      { ...snapshot.revision, sequence: 1n },
      { agentSchedules: [] } as unknown as StateSeed,
      snapshot,
      new Set(['agentSchedules']),
    );
    expect(replaced.table('agentSchedules').all()).toHaveLength(0);
    expect(view.all()).toBe(first);
  });
});
