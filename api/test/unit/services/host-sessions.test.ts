/**
 * HostSessionsService over a recording fake: the three cutoffs it derives from
 * the injected clock, the distinct-host aggregate only the `now` window uses,
 * the `agents.retrieve` filter, and the `?? 0` fallback when a count query
 * comes back empty. The fake decodes the generated predicate and counts the
 * seeded rows itself, so none of this needs a database.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Database } from '../../../src/db/client.js';
import { logs } from '../../../src/db/schema.js';
import { HostSessionsService } from '../../../src/services/host-sessions.js';

interface LogRow {
  hostId: number;
  action: string;
  createdAt: string;
}

interface CountQuery {
  table: unknown;
  /** The projected aggregate, e.g. `count(*)` or `count(distinct host_id)`. */
  aggregate: string;
  action: unknown;
  cutoff: unknown;
}

/** No millis, no offset -- the format `logs.created_at` is written in. */
const FLOORED_ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

function createDb(rows: LogRow[]): { db: Database; queries: CountQuery[] } {
  const queries: CountQuery[] = [];
  const db = {
    select(fields: Record<string, unknown>) {
      const [expr] = Object.values(fields);
      const aggregate = renderSql(expr);
      return {
        from(table: unknown) {
          return {
            where(condition: unknown) {
              const terms = comparisons(condition);
              const action = terms.find((t) => t.column === 'action' && t.operator === '=')?.value;
              const cutoff = terms.find((t) => t.column === 'created_at' && t.operator === '>=')?.value;
              queries.push({ table, aggregate, action, cutoff });
              const matched = rows.filter((row) => row.action === action && row.createdAt >= String(cutoff));
              const c = aggregate.includes('distinct')
                ? new Set(matched.map((row) => row.hostId)).size
                : matched.length;
              return Promise.resolve([{ c }]);
            },
          };
        },
      };
    },
  };
  return { db: db as unknown as Database, queries };
}

/** A db whose every count query resolves to the same result set. */
function fixedDb(result: Array<Record<string, unknown>>): Database {
  return {
    select: () => ({ from: () => ({ where: () => Promise.resolve(result) }) }),
  } as unknown as Database;
}

type Token =
  | { kind: 'text'; text: string }
  | { kind: 'column'; name: string }
  | { kind: 'value'; value: unknown };

/** Flatten a Drizzle SQL tree into columns, operators and bound values. */
function tokenize(node: unknown, out: Token[] = []): Token[] {
  if (node === null || node === undefined) return out;
  if (typeof node !== 'object') {
    out.push({ kind: 'value', value: node });
    return out;
  }
  const ctor = (node as { constructor?: { name?: string } }).constructor?.name;
  if (ctor === 'StringChunk') {
    const raw = (node as { value?: unknown }).value;
    out.push({ kind: 'text', text: Array.isArray(raw) ? raw.join('') : String(raw) });
    return out;
  }
  if (ctor === 'Param') {
    out.push({ kind: 'value', value: (node as { value: unknown }).value });
    return out;
  }
  const chunks = (node as { queryChunks?: unknown[] }).queryChunks;
  if (Array.isArray(chunks)) {
    for (const chunk of chunks) tokenize(chunk, out);
    return out;
  }
  const name = (node as { name?: unknown }).name;
  if (typeof name === 'string' && 'table' in node) out.push({ kind: 'column', name });
  return out;
}

function renderSql(node: unknown): string {
  return tokenize(node)
    .map((token) => (token.kind === 'text' ? token.text : token.kind === 'column' ? token.name : '?'))
    .join('');
}

interface Comparison {
  column: string;
  operator: string;
  value: unknown;
}

function comparisons(where: unknown): Comparison[] {
  const tokens = tokenize(where).filter((token) => token.kind !== 'text' || token.text.trim() !== '');
  const out: Comparison[] = [];
  for (let i = 0; i + 2 < tokens.length; i += 1) {
    const column = tokens[i];
    const operator = tokens[i + 1];
    const value = tokens[i + 2];
    if (column?.kind !== 'column' || operator?.kind !== 'text' || value?.kind !== 'value') continue;
    out.push({ column: column.name, operator: operator.text.trim(), value: value.value });
  }
  return out;
}

function cutoffs(queries: CountQuery[]): unknown[] {
  return queries.map((query) => query.cutoff);
}

describe('HostSessionsService.fleetCounts', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('derives the 30-minute, UTC-day and UTC-month cutoffs from the injected clock', async () => {
    const { db, queries } = createDb([]);
    await new HostSessionsService(db).fleetCounts(new Date('2026-07-20T10:14:37.512Z'));

    expect(cutoffs(queries)).toEqual([
      '2026-07-20T09:44:37Z',
      '2026-07-20T00:00:00Z',
      '2026-07-01T00:00:00Z',
    ]);
    for (const cutoff of cutoffs(queries)) expect(cutoff).toMatch(FLOORED_ISO);
    expect(queries.map((query) => query.table)).toEqual([logs, logs, logs]);
  });

  it('keeps the day and month cutoffs on the 1st of a month', async () => {
    const { db, queries } = createDb([]);
    await new HostSessionsService(db).fleetCounts(new Date('2026-08-01T00:07:00.000Z'));

    expect(cutoffs(queries)).toEqual([
      // The recent window reaches back into the previous month...
      '2026-07-31T23:37:00Z',
      // ...but today and the month both start at this midnight.
      '2026-08-01T00:00:00Z',
      '2026-08-01T00:00:00Z',
    ]);
  });

  it('walks the 30-minute window into the previous UTC day just after midnight', async () => {
    const { db, queries } = createDb([]);
    await new HostSessionsService(db).fleetCounts(new Date('2026-07-20T00:10:00.000Z'));

    expect(cutoffs(queries)).toEqual([
      '2026-07-19T23:40:00Z',
      '2026-07-20T00:00:00Z',
      '2026-07-01T00:00:00Z',
    ]);
  });

  it('falls back to the wall clock when no date is passed', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-09T12:00:00.000Z'));
    const { db, queries } = createDb([]);
    await new HostSessionsService(db).fleetCounts();

    expect(cutoffs(queries)).toEqual([
      '2026-03-09T11:30:00Z',
      '2026-03-09T00:00:00Z',
      '2026-03-01T00:00:00Z',
    ]);
  });

  it('counts distinct hosts for the now window and rows for today/month', async () => {
    const { db, queries } = createDb([
      { hostId: 1, action: 'agents.retrieve', createdAt: '2026-07-20T09:59:00Z' },
      { hostId: 1, action: 'agents.retrieve', createdAt: '2026-07-20T09:45:00Z' },
      // Exactly on the 30-minute cutoff: gte keeps it.
      { hostId: 2, action: 'agents.retrieve', createdAt: '2026-07-20T09:30:00Z' },
      { hostId: 3, action: 'agents.retrieve', createdAt: '2026-07-20T09:29:59Z' },
      { hostId: 4, action: 'agents.retrieve', createdAt: '2026-07-19T23:59:59Z' },
      { hostId: 5, action: 'agents.retrieve', createdAt: '2026-06-30T23:59:59Z' },
    ]);

    const counts = await new HostSessionsService(db).fleetCounts(new Date('2026-07-20T10:00:00.000Z'));

    // Two hosts in the window despite three rows; the day/month totals count rows.
    expect(counts).toEqual({ now: 2, today: 4, month: 5 });
    expect(queries.map((query) => query.aggregate)).toEqual([
      'count(distinct host_id)',
      'count(*)',
      'count(*)',
    ]);
  });

  it('matches only agents.retrieve rows', async () => {
    const { db, queries } = createDb([
      { hostId: 1, action: 'agents.retrieve', createdAt: '2026-07-20T09:50:00Z' },
      { hostId: 2, action: 'bootstrap', createdAt: '2026-07-20T09:50:00Z' },
      { hostId: 3, action: 'agents.retrieve.error', createdAt: '2026-07-20T09:50:00Z' },
      { hostId: 4, action: 'host.sync', createdAt: '2026-07-20T01:00:00Z' },
    ]);

    const counts = await new HostSessionsService(db).fleetCounts(new Date('2026-07-20T10:00:00.000Z'));

    expect(counts).toEqual({ now: 1, today: 1, month: 1 });
    expect(queries.map((query) => query.action)).toEqual([
      'agents.retrieve',
      'agents.retrieve',
      'agents.retrieve',
    ]);
  });

  it('reports zeros when the count queries return no row', async () => {
    const counts = await new HostSessionsService(fixedDb([])).fleetCounts(new Date());
    expect(counts).toEqual({ now: 0, today: 0, month: 0 });
  });

  it('coerces driver-supplied count strings to numbers', async () => {
    const counts = await new HostSessionsService(fixedDb([{ c: '7' }])).fleetCounts(new Date());
    expect(counts).toEqual({ now: 7, today: 7, month: 7 });
    expect(typeof counts.now).toBe('number');
  });
});
