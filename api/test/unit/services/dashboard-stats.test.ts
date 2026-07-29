/**
 * DashboardStatsService over a recording fake: the 1..500 clamp `recentLogs`
 * puts on its limit, the descending `created_at` order both log reads rely on,
 * `latestLog()` on an empty table, and the day-based snapshot cutoff string.
 * The fake applies the recorded order/limit/cutoff to seeded rows, so none of
 * this needs a database.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Database } from '../../../src/db/client.js';
import { dashboardGraphQuotaSnapshots, logs } from '../../../src/db/schema.js';
import { DashboardStatsService } from '../../../src/services/dashboard-stats.js';

type Row = Record<string, unknown>;

interface Query {
  table: unknown;
  order: string;
  limit: number | null;
  cutoff: unknown;
}

const NOW = '2026-07-20T10:14:37.512Z';
/** No millis, no offset -- the format `fetched_at` is written in. */
const FLOORED_ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

const LOG_ROWS: Row[] = [
  { id: 1, action: 'agents.retrieve', createdAt: '2026-07-20T08:00:00Z' },
  { id: 2, action: 'host.sync', createdAt: '2026-07-20T10:00:00Z' },
  { id: 3, action: 'bootstrap', createdAt: '2026-07-19T23:00:00Z' },
  { id: 4, action: 'agents.retrieve', createdAt: '2026-07-20T09:00:00Z' },
];

function createDb(tables: Map<unknown, Row[]>): { db: Database; queries: Query[] } {
  const queries: Query[] = [];
  const db = {
    select() {
      return {
        from(table: unknown) {
          const query: Query = { table, order: '', limit: null, cutoff: undefined };
          queries.push(query);
          let rows = (tables.get(table) ?? []).slice();
          const chain = {
            where(condition: unknown) {
              const [cutoff] = boundValues(condition);
              const key = column(renderSql(condition));
              query.cutoff = cutoff;
              rows = rows.filter((row) => String(row[key]) >= String(cutoff));
              return chain;
            },
            orderBy(...args: unknown[]) {
              query.order = args.map(renderSql).join(', ');
              rows = sortRows(rows, query.order);
              return chain;
            },
            limit(n: number) {
              query.limit = n;
              rows = rows.slice(0, n);
              return chain;
            },
            then(resolve: (rows: Row[]) => unknown, reject: (err: unknown) => unknown) {
              return Promise.resolve(rows).then(resolve, reject);
            },
          };
          return chain;
        },
      };
    },
  };
  return { db: db as unknown as Database, queries };
}

/** `created_at desc` / `fetched_at` -> rows sorted by that column. */
function sortRows(rows: Row[], order: string): Row[] {
  const [name, direction] = order.split(' ');
  if (!name) return rows;
  const key = column(name);
  const sign = direction === 'desc' ? -1 : 1;
  return rows.slice().sort((a, b) => sign * String(a[key] ?? '').localeCompare(String(b[key] ?? '')));
}

/** The predicate/order SQL names db columns; the seeded rows use TS keys. */
function column(sqlText: string): string {
  const name = sqlText.match(/[a-z_]+/)?.[0] ?? '';
  return name.replace(/_([a-z])/g, (_match, letter: string) => letter.toUpperCase());
}

function renderSql(node: unknown): string {
  return tokens(node)
    .map((token) => (typeof token === 'string' ? token : 'name' in token ? token.name : '?'))
    .join('')
    .trim();
}

function boundValues(node: unknown): unknown[] {
  return tokens(node).flatMap((token) => (typeof token === 'string' || 'name' in token ? [] : [token.value]));
}

type Token = string | { name: string } | { value: unknown };

/** Flatten a Drizzle SQL tree into literal text, column names and bound values. */
function tokens(node: unknown, out: Token[] = []): Token[] {
  if (node === null || node === undefined) return out;
  if (typeof node !== 'object') {
    out.push({ value: node });
    return out;
  }
  const ctor = (node as { constructor?: { name?: string } }).constructor?.name;
  if (ctor === 'StringChunk') {
    const raw = (node as { value?: unknown }).value;
    out.push(Array.isArray(raw) ? raw.join('') : String(raw));
    return out;
  }
  if (ctor === 'Param') {
    out.push({ value: (node as { value: unknown }).value });
    return out;
  }
  const chunks = (node as { queryChunks?: unknown[] }).queryChunks;
  if (Array.isArray(chunks)) {
    for (const chunk of chunks) tokens(chunk, out);
    return out;
  }
  const name = (node as { name?: unknown }).name;
  if (typeof name === 'string' && 'table' in node) out.push({ name });
  return out;
}

describe('DashboardStatsService', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('recentLogs', () => {
    it.each([
      { limit: 0, expected: 1 },
      { limit: 1, expected: 1 },
      { limit: 50, expected: 50 },
      { limit: 501, expected: 500 },
    ])('clamps a limit of $limit to $expected', async ({ limit, expected }) => {
      const { db, queries } = createDb(new Map([[logs, LOG_ROWS]]));
      await new DashboardStatsService(db).recentLogs(limit);
      expect(queries[0]?.limit).toBe(expected);
    });

    it('defaults to 50 rows', async () => {
      const { db, queries } = createDb(new Map([[logs, LOG_ROWS]]));
      await new DashboardStatsService(db).recentLogs();
      expect(queries[0]?.limit).toBe(50);
      expect(queries[0]?.table).toBe(logs);
    });

    it('returns the newest rows first', async () => {
      const { db, queries } = createDb(new Map([[logs, LOG_ROWS]]));
      const rows = await new DashboardStatsService(db).recentLogs(3);

      expect(queries[0]?.order).toBe('created_at desc');
      expect(rows.map((row) => row.createdAt)).toEqual([
        '2026-07-20T10:00:00Z',
        '2026-07-20T09:00:00Z',
        '2026-07-20T08:00:00Z',
      ]);
    });
  });

  describe('latestLog', () => {
    it('returns null when the table is empty', async () => {
      const { db, queries } = createDb(new Map([[logs, []]]));
      expect(await new DashboardStatsService(db).latestLog()).toBeNull();
      expect(queries[0]?.limit).toBe(1);
    });

    it('returns the newest row', async () => {
      const { db, queries } = createDb(new Map([[logs, LOG_ROWS]]));
      const row = await new DashboardStatsService(db).latestLog();

      expect(queries[0]?.order).toBe('created_at desc');
      expect(row?.id).toBe(2);
    });
  });

  describe('quotaSnapshots', () => {
    it.each([
      { days: 30, cutoff: '2026-06-20T10:14:37Z' },
      { days: 1, cutoff: '2026-07-19T10:14:37Z' },
      { days: 0, cutoff: '2026-07-20T10:14:37Z' },
    ])('cuts off $days day(s) back at $cutoff', async ({ days, cutoff }) => {
      const { db, queries } = createDb(new Map([[dashboardGraphQuotaSnapshots, []]]));
      await new DashboardStatsService(db).quotaSnapshots(days);

      expect(queries[0]?.cutoff).toBe(cutoff);
      expect(queries[0]?.cutoff).toMatch(FLOORED_ISO);
    });

    it('defaults to a 30-day window and returns oldest-first snapshots', async () => {
      const { db, queries } = createDb(
        new Map([
          [
            dashboardGraphQuotaSnapshots,
            [
              { id: 1, fetchedAt: '2026-07-20T09:00:00Z' },
              { id: 2, fetchedAt: '2026-05-01T09:00:00Z' },
              { id: 3, fetchedAt: '2026-06-20T10:14:37Z' },
            ],
          ],
        ]),
      );
      const rows = await new DashboardStatsService(db).quotaSnapshots();

      expect(queries[0]?.cutoff).toBe('2026-06-20T10:14:37Z');
      expect(queries[0]?.order).toBe('fetched_at');
      // The May snapshot is outside the window; the one exactly on the cutoff stays.
      expect(rows.map((row) => row.id)).toEqual([3, 1]);
    });
  });
});
