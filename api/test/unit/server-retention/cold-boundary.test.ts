import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MySqlDialect } from 'drizzle-orm/mysql-core';
import type { SQL } from 'drizzle-orm';
import type { PersistenceTransaction } from '../../../src/control-plane/persistence.js';
import type { OwnerMutationContext, OwnerRuntime } from '../../../src/control-plane/state/runtime.js';
import { OwnerStateSnapshot, OwnerStateStore } from '../../../src/control-plane/state/store.js';
import { DeadlineQueue } from '../../../src/control-plane/deadlines.js';
import { createOwnerWorker } from '../../../src/ops/owner-worker.js';
import { coldClock, purgeCold } from '../../../src/services/server-retention/cold.js';
import { RetentionDeadlineIndex } from '../../../src/services/server-retention/deadlines.js';
import { DEFAULT_SERVER_RETENTION } from '../../../src/services/server-retention/policy.js';

const policy = { ...DEFAULT_SERVER_RETENTION, armed: true };
const retentionMs = policy.audit_days * 86_400_000;
const dialect = new MySqlDialect();
afterEach(() => vi.useRealTimers());

/** Preserve SQL's indexed VARCHAR comparisons in the fake: timestamp parsing
 * here would hide the real boundary mismatch. Deletion authority stays intact. */
function logSql(at: string) {
  let rows = [{ id: 1, at }];
  const queries: string[] = [];
  const execute = vi.fn(async (statement: SQL) => {
    const query = dialect.sqlToQuery(statement);
    queries.push(query.sql);
    if (query.sql.startsWith('DELETE FROM `logs`')) {
      rows = rows.filter((row) => !query.params.includes(row.id));
      return [{ affectedRows: 1 }];
    }
    if (query.sql.startsWith('SELECT MAX(created_at)')) return [[{ at: rows[0]?.at ?? null }]];
    const cutoff = query.params[0] as string;
    const selected = rows
      .filter((row) => (query.sql.includes('<=?') ? row.at <= cutoff : row.at > cutoff))
      .sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
    return [selected.slice(0, query.sql.includes('FOR UPDATE') ? 100 : 1)];
  });
  return { tx: { execute } as unknown as PersistenceTransaction, queries, rows: () => rows };
}
function mutationContext(state: OwnerStateStore): OwnerMutationContext {
  return {
    snapshot: state.snapshot(),
    draft: state.begin(),
    revision: state.revision(),
    write() {
      throw new Error('Unexpected staged write');
    },
    effect() {
      throw new Error('Unexpected effect');
    },
  };
}

describe('indexed cold retention timestamp boundaries', () => {
  it.each([
    ['2026-10-11T12:00:00Z', 1000],
    ['2026-10-11T12:00:00.1Z', 900],
    ['2026-10-11T12:00:00.12Z', 880],
    ['2026-10-11T12:00:00.123Z', 0],
    ['2026-10-11T12:00:00.123456Z', 877],
    ['2026-10-11T12:00:00.1+00:00', 900],
    ['2026-10-11T12:00:00.123456+00:00', 877],
    ['2026-10-11T12:00:00.999Z', 0],
    ['2026-10-11T12:00:59Z', 1000],
    ['2026-10-11T23:59:59.99Z', 10],
    ['2026-10-11T23:59:59Z', 1000],
    ['2026-10-11T12:00:00+00:00', 1000],
    ['2026-10-11T12:00:00.12+00:00', 880],
    ['2026-10-11T12:00:00.123+00:00', 877],
  ])('schedules %s only at a boundary the existing SQL can select', async (at, boundaryDelay) => {
    const due = Date.parse(at) + retentionMs;
    const fixture = logSql(at);
    const clock = await coldClock(fixture.tx, 'auditlogs', due - 1, policy);
    expect(clock).toEqual({ past: false, next: due + boundaryDelay });
    expect(fixture.queries.every((query) => !/CAST\(|STR_TO_DATE\(/.test(query))).toBe(true);
    const state = new OwnerStateStore(new OwnerStateSnapshot({ epoch: randomUUID(), sequence: 0n }));
    expect(await purgeCold(mutationContext(state), fixture.tx, 'auditlogs', policy, due - 1)).toBe(0);
    expect(fixture.rows()).toHaveLength(1);
    expect(await purgeCold(mutationContext(state), fixture.tx, 'auditlogs', policy, clock.next!)).toBe(1);
    expect(fixture.rows()).toEqual([]);
  });
  it('never rearms an already-due future text candidate as an immediate empty SQL obligation', async () => {
    const at = '2026-10-11T12:00:00Z',
      due = Date.parse(at) + retentionMs;
    const fixture = logSql(at);
    for (const now of [due, due + 1, due + 500, due + 999]) {
      const clock = await coldClock(fixture.tx, 'auditlogs', now, policy);
      expect(clock.past).toBe(false);
      expect(clock.next).toBe(due + 1000);
      expect(clock.next!).toBeGreaterThan(now);
    }
    expect(await coldClock(fixture.tx, 'auditlogs', due + 1000, policy)).toEqual({ past: true, next: null });
  });
  it('keeps protected past history and earlier independent families ahead of the corrected deadline', async () => {
    vi.useFakeTimers();
    const at = '2026-10-11T12:00:00Z',
      due = Date.parse(at) + retentionMs;
    vi.setSystemTime(due - 1);
    const fixture = logSql(at),
      index = new RetentionDeadlineIndex();
    await index.hydrate(async (family) =>
      family === 'auditlogs'
        ? coldClock(fixture.tx, family, Date.now(), policy)
        : family === 'rooms'
          ? { past: true, next: due + 500 }
          : { past: false, next: null },
    );
    index.publishSweep('rooms', { past: true, next: due + 500 }, 0);
    index.stage('adminaudit', due + 250);
    expect(
      index
        .obligations()
        .sort((a, b) => a.dueAt - b.dueAt)
        .map((row) => [row.key, row.dueAt]),
    ).toEqual([
      ['history:adminaudit', due + 250],
      ['history:rooms', due + 500],
      ['history:auditlogs', due + 1000],
    ]);
    index.publishSweep('adminaudit', { past: false, next: null }, 0);
    index.publishSweep('rooms', { past: true, next: null }, 0);
    index.invalidate(['rooms']);
    expect(index.obligations().find((row) => row.key === 'history:rooms')?.dueAt).toBe(0);
    expect(index.obligations().find((row) => row.key === 'history:auditlogs')?.dueAt).toBe(due + 1000);
    expect(fixture.queries).toHaveLength(2);
  });

  it('runs one real batch across a whole-second boundary, without empty SQL polling', async () => {
    vi.useFakeTimers();
    const at = '2026-10-11T12:00:00Z',
      due = Date.parse(at) + retentionMs;
    vi.setSystemTime(due - 1);
    const fixture = logSql(at);
    const state = new OwnerStateStore(new OwnerStateSnapshot({ epoch: randomUUID(), sequence: 0n }));
    const index = new RetentionDeadlineIndex();
    await index.hydrate(async (family) =>
      family === 'auditlogs'
        ? coldClock(fixture.tx, family, Date.now(), policy)
        : { past: false, next: null },
    );
    const errors = vi.fn(),
      deadlines = new DeadlineQueue(errors);
    const runtime = { state, deadlines, assertOwner() {}, execute: vi.fn() } as unknown as OwnerRuntime;
    let passes = 0,
      empty = 0,
      deleted = 0;
    const worker = createOwnerWorker(runtime, {
      name: 'cold-boundary-regression',
      tables: [],
      select: () => index.obligations(),
      subscribe: (wake) => index.subscribe(wake),
      async run() {
        passes++;
        const changed = await purgeCold(mutationContext(state), fixture.tx, 'auditlogs', policy, Date.now());
        if (changed === 0) empty++;
        else deleted += changed;
        const next = await coldClock(fixture.tx, 'auditlogs', Date.now(), policy);
        // Bound the failing baseline rather than exhausting fake-timer limits.
        index.publishSweep('auditlogs', passes >= 3 ? { past: false, next: null } : next, changed);
      },
      error: errors,
    });
    try {
      await vi.advanceTimersByTimeAsync(2001);
      expect({ passes, empty, deleted }).toEqual({ passes: 1, empty: 0, deleted: 1 });
      expect(index.obligations()).toEqual([]);
      const queries = fixture.queries.length;
      await vi.advanceTimersByTimeAsync(180_000);
      expect(fixture.queries.length).toBe(queries);
      expect(errors).not.toHaveBeenCalled();
    } finally {
      await worker.close();
      deadlines.close();
    }
  });
});
