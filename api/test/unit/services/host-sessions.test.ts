/** Query-boundary checks; actual aggregate correctness lives in the MySQL suite. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SQL } from 'drizzle-orm';
import { MySqlDialect } from 'drizzle-orm/mysql-core';
import type { Database } from '../../../src/db/client.js';
import { HostSessionsService } from '../../../src/services/host-sessions.js';

function createDb(rows: Array<Record<string, unknown>> = []) {
  const execute = vi.fn(async (_query: SQL) => [rows, []]);
  return { db: { execute } as unknown as Database, execute };
}

describe('HostSessionsService.fleetCounts', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it.each([
    ['2026-07-20T10:14:37.512Z', '2026-07-20T09:44:37Z', '2026-07-20T00:00:00Z', '2026-07-01T00:00:00Z'],
    ['2026-08-01T00:07:00.000Z', '2026-07-31T23:37:00Z', '2026-08-01T00:00:00Z', '2026-08-01T00:00:00Z'],
    ['2026-07-20T00:10:00.000Z', '2026-07-19T23:40:00Z', '2026-07-20T00:00:00Z', '2026-07-01T00:00:00Z'],
  ])('binds all UTC cutoffs in one database statement at %s', async (at, recent, today, month) => {
    const { db, execute } = createDb();
    await new HostSessionsService(db).fleetCounts(new Date(at));
    expect(execute).toHaveBeenCalledTimes(1);
    const query = new MySqlDialect().sqlToQuery(execute.mock.calls[0]![0]);
    expect(query.params).toEqual([
      'agents.retrieve',
      recent,
      'agents.retrieve',
      today,
      'agents.retrieve',
      month,
    ]);
    expect(query.sql.match(/count\(distinct /gi)).toHaveLength(1);
    expect(query.sql.match(/count\(\*\)/gi)).toHaveLength(2);
    expect(query.sql).not.toContain(recent!);
  });

  it('defaults to the wall clock', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-09T12:00:00Z'));
    const { db, execute } = createDb();
    await new HostSessionsService(db).fleetCounts();
    expect(new MySqlDialect().sqlToQuery(execute.mock.calls[0]![0]).params).toEqual([
      'agents.retrieve',
      '2026-03-09T11:30:00Z',
      'agents.retrieve',
      '2026-03-09T00:00:00Z',
      'agents.retrieve',
      '2026-03-01T00:00:00Z',
    ]);
  });

  it('returns numeric zeros when the driver returns no row', async () => {
    expect(await new HostSessionsService(createDb().db).fleetCounts()).toEqual({
      now: 0,
      today: 0,
      month: 0,
    });
  });

  it('coerces each driver-supplied count independently', async () => {
    const { db } = createDb([{ recent: '3', today: '7', month: '29' }]);
    expect(await new HostSessionsService(db).fleetCounts()).toEqual({ now: 3, today: 7, month: 29 });
  });
});
