import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { drizzle } from 'drizzle-orm/mysql2';
import type { PoolConnection } from 'mysql2/promise';
import type { Database } from '../../../src/db/client.js';
import * as schema from '../../../src/db/schema.js';
import { HostSessionsService } from '../../../src/services/host-sessions.js';
import { getTestDb } from '../../helpers/test-db.js';

const handle = await getTestDb();

describe.skipIf(!handle)('fleet activity counts against MySQL', () => {
  let connection: PoolConnection;
  let db: Omit<Database, '$client'>;

  beforeEach(async () => {
    connection = await handle!.pool.getConnection();
    // Exercise the real baseline table inside a rolled-back transaction. A
    // MySQL TEMPORARY table cannot be read by three scalar subqueries at once.
    await connection.beginTransaction();
    await connection.query('DELETE FROM logs');
    db = drizzle(connection, { schema, mode: 'default' });
  });
  afterEach(async () => {
    await connection.rollback();
    connection.release();
  });
  afterAll(async () => {
    await handle?.pool.end();
  });

  it('counts prior-month recent hosts, null hosts and duplicate syncs correctly', async () => {
    await db.insert(schema.logs).values([
      { hostId: 1, action: 'agents.retrieve', createdAt: '2026-07-31T23:36:59Z', engine: 'codex' },
      { hostId: 2, action: 'agents.retrieve', createdAt: '2026-07-31T23:37:00Z', engine: 'codex' },
      { hostId: 2, action: 'agents.retrieve', createdAt: '2026-07-31T23:40:00Z', engine: 'claude' },
      { hostId: 3, action: 'agents.retrieve', createdAt: '2026-08-01T00:00:00Z', engine: 'grok' },
      { hostId: 3, action: 'agents.retrieve', createdAt: '2026-08-01T00:05:00Z', engine: 'codex' },
      { hostId: null, action: 'agents.retrieve', createdAt: '2026-08-01T00:06:00Z', engine: null },
      // Preserve the historical lower-bound-only predicate, including future rows.
      { hostId: 4, action: 'agents.retrieve', createdAt: '2026-08-01T00:08:00Z', engine: 'claude' },
      { hostId: 5, action: 'agents.retrieve.extra', createdAt: '2026-08-01T00:06:00Z', engine: 'grok' },
      { hostId: 6, action: 'auth.retrieve', createdAt: '2026-08-01T00:06:00Z', engine: 'codex' },
    ]);
    const service = new HostSessionsService(db);
    const at = new Date('2026-08-01T00:07:00.512Z');
    expect(await service.fleetCounts(at)).toEqual({ now: 3, today: 4, month: 4 });
    await db
      .insert(schema.logs)
      .values({ hostId: 7, action: 'agents.retrieve', createdAt: '2026-08-01T00:07:00Z' });
    expect(await service.fleetCounts(at)).toEqual({ now: 4, today: 5, month: 5 });
  });

  it.each([
    '2026-07-20T10:00:00.512Z',
    '2026-07-20T00:10:00.512Z',
    '2026-08-01T00:07:00.512Z',
    '2027-01-01T00:00:00.512Z',
    '2028-03-01T00:00:00.512Z',
    '2026-08-01T00:07:00.512+02:00',
  ])('matches the original three SQL counts at %s', async (timestamp) => {
    const now = new Date(timestamp);
    const cutoffs = [
      new Date(now.getTime() - 30 * 60 * 1000),
      new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())),
      new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)),
    ].map((d) => d.toISOString().replace(/\.\d{3}Z$/, 'Z'));
    const rows = cutoffs.flatMap((cutoff, boundary) =>
      [-1000, 0, 1000].flatMap((delta, i) => {
        const createdAt = new Date(Date.parse(cutoff) + delta).toISOString().replace('.000Z', 'Z');
        return [
          { hostId: boundary * 10 + i + 1, action: 'agents.retrieve', createdAt, engine: 'codex' },
          { hostId: boundary * 10 + i + 1, action: 'agents.retrieve', createdAt, engine: 'claude' },
          { hostId: null, action: 'agents.retrieve', createdAt, engine: 'grok' },
          { hostId: 999, action: 'auth.retrieve', createdAt, engine: 'codex' },
        ];
      }),
    );
    await db.insert(schema.logs).values(rows);
    const expected: number[] = [];
    for (const [i, cutoff] of cutoffs.entries()) {
      const [result] = await connection.query(
        `SELECT ${i === 0 ? 'COUNT(DISTINCT host_id)' : 'COUNT(*)'} AS c FROM logs WHERE action = ? AND created_at >= ?`,
        ['agents.retrieve', cutoff],
      );
      expected.push(Number((result as Array<{ c: number }>)[0]!.c));
    }
    expect(await new HostSessionsService(db).fleetCounts(now)).toEqual({
      now: expected[0],
      today: expected[1],
      month: expected[2],
    });
  });

  it('returns numeric zeros for empty activity', async () => {
    expect(await new HostSessionsService(db).fleetCounts(new Date('2026-10-13T12:00:00Z'))).toEqual({
      now: 0,
      today: 0,
      month: 0,
    });
  });
});
