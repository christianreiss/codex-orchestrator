/**
 * Direct coverage for the admin memories firehose. `adminSearch` pages through
 * the table by hand because tag containment is filtered in JS rather than SQL,
 * and `test/helpers/db-fake.ts` implements no `.offset()`, so the drizzle chain
 * is stubbed locally here — that is what makes the requested `limit`/`offset`
 * pairs, and therefore the loop's progression, assertable.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { Param, SQL } from 'drizzle-orm';
import { mcpMemories } from '../../../src/db/schema.js';
import { MemoriesService } from '../../../src/services/memories.js';
import { NotFoundError, ValidationError } from '../../../src/http/errors.js';
import type { Database } from '../../../src/db/client.js';
import { wsPublisher } from '../../../src/ws/publisher.js';

type MemoryRow = typeof mcpMemories.$inferSelect;
type Fields = Record<string, unknown>;

interface Page {
  limit: number;
  offset: number;
}

interface MemoriesDb {
  db: Database;
  rows: MemoryRow[];
  /** Every `(limit, offset)` the paging loop asked for, in order. */
  pages: Page[];
  /** Bound values of each search `where`, in order. */
  wheres: unknown[][];
  /** Ids passed to `delete(...).where(...)`. */
  deletes: unknown[];
}

/**
 * In-memory `mcp_memories` covering just the two chains the service uses:
 * `select().from().where().orderBy().limit().offset()` for the search loop and
 * `select(fields).from().where().limit()` / `delete().where()` for the hard
 * delete. The search read pages over `rows` as seeded — the conditions are only
 * recorded, since SQL-side filtering is not what this service owns.
 */
function createMemoriesDb(rows: MemoryRow[] = []): MemoriesDb {
  const db = {
    select(fields?: Fields) {
      return {
        from: (_table: unknown) => ({
          where: (condition: unknown) => ({
            orderBy: (..._order: unknown[]) => ({
              limit: (limit: number) => ({
                offset: async (offset: number) => {
                  stub.pages.push({ limit, offset });
                  stub.wheres.push(boundValues(condition));
                  return stub.rows.slice(offset, offset + limit).map((row) => project(row, fields));
                },
              }),
            }),
            limit: async (limit: number) => {
              const [id] = boundValues(condition);
              return stub.rows
                .filter((row) => row.id === id)
                .slice(0, limit)
                .map((row) => project(row, fields));
            },
          }),
        }),
      };
    },
    delete(_table: unknown) {
      return {
        where: async (condition: unknown) => {
          const [id] = boundValues(condition);
          stub.deletes.push(id);
          stub.rows = stub.rows.filter((row) => row.id !== id);
        },
      };
    },
  };

  const stub: MemoriesDb = {
    db: db as unknown as Database,
    rows,
    pages: [],
    wheres: [],
    deletes: [],
  };
  return stub;
}

/**
 * Values bound into a drizzle condition, in order: `eq()` binds a `Param`,
 * while `like()` inlines its pattern as a raw string chunk.
 */
function boundValues(condition: unknown, out: unknown[] = []): unknown[] {
  if (condition instanceof Param) out.push(condition.value);
  else if (condition instanceof SQL) for (const chunk of condition.queryChunks) boundValues(chunk, out);
  else if (typeof condition === 'string') out.push(condition);
  return out;
}

/**
 * `adminDelete` projects `{ id, hostId, memoryKey }` under aliases identical to
 * the row keys drizzle returns, so the alias alone locates the value.
 */
function project(row: MemoryRow, fields: Fields | undefined): Record<string, unknown> {
  if (!fields) return { ...row };
  const out: Record<string, unknown> = {};
  for (const alias of Object.keys(fields)) out[alias] = row[alias as keyof MemoryRow];
  return out;
}

function makeRow(overrides: Partial<MemoryRow> & { id: number }): MemoryRow {
  return {
    hostId: 1,
    memoryKey: `key-${overrides.id}`,
    content: 'content',
    metadata: null,
    tags: null,
    tagsText: null,
    createdAt: '2026-07-01T09:00:00Z',
    updatedAt: '2026-07-01T10:00:00Z',
    deletedAt: null,
    summary: null,
    engine: null,
    ...overrides,
  };
}

/** `count` rows with ids 1..count, tagged at the given zero-based indexes. */
function seedRows(count: number, tagsByIndex: Record<number, unknown> = {}): MemoryRow[] {
  return Array.from({ length: count }, (_v, i) => makeRow({ id: i + 1, tags: tagsByIndex[i] ?? null }));
}

function makeService(rows: MemoryRow[] = []): { stub: MemoriesDb; service: MemoriesService } {
  const stub = createMemoriesDb(rows);
  return { stub, service: new MemoriesService(stub.db) };
}

/** Resolves to the rejection reason so its `param`/`code` can be asserted. */
function rejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => null,
    (err: unknown) => err,
  );
}

let events: Array<{ type: string; payload: unknown }> = [];

beforeEach((ctx) => {
  events = [];
  const unsubscribe = wsPublisher.subscribe((e) => events.push({ type: e.type, payload: e.payload }));
  ctx.onTestFinished(unsubscribe);
});

const memoryEvents = () => events.filter((e) => e.type.startsWith('memory.'));

describe('adminSearch query', () => {
  it('trims the query', async () => {
    const { service } = makeService();
    await expect(service.adminSearch({ query: '  deploy notes  ' })).resolves.toMatchObject({
      status: 'ok',
      query: 'deploy notes',
    });
  });

  it('accepts q as an alias and trims it', async () => {
    const { service } = makeService();
    await expect(service.adminSearch({ q: '\tdeploy\n' })).resolves.toMatchObject({ query: 'deploy' });
  });

  it('prefers query over q when both are strings', async () => {
    const { service } = makeService();
    await expect(service.adminSearch({ query: 'first', q: 'second' })).resolves.toMatchObject({ query: 'first' });
  });

  it('falls back to q when query is not a string', async () => {
    const { service } = makeService();
    await expect(service.adminSearch({ query: 42, q: 'fallback' })).resolves.toMatchObject({ query: 'fallback' });
  });

  it('is an empty query when neither is a string', async () => {
    const { service } = makeService();
    await expect(service.adminSearch({ query: null, q: { nope: true } })).resolves.toMatchObject({ query: '' });
  });
});

describe('adminSearch limit clamp', () => {
  const cases: Array<{ label: string; limit: unknown; expected: number }> = [
    { label: '0', limit: 0, expected: 1 },
    { label: '-5', limit: -5, expected: 1 },
    { label: '1000', limit: 1000, expected: 200 },
    { label: 'the string "25"', limit: '25', expected: 25 },
    { label: 'the fractional 7.9', limit: 7.9, expected: 7 },
    { label: 'the fractional 1.5', limit: 1.5, expected: 1 },
    { label: 'the string "12.7"', limit: '12.7', expected: 12 },
    { label: 'NaN', limit: NaN, expected: 50 },
    { label: 'a non-numeric string', limit: 'abc', expected: 50 },
    { label: 'Infinity', limit: Infinity, expected: 50 },
    { label: 'null', limit: null, expected: 50 },
    { label: 'undefined', limit: undefined, expected: 50 },
  ];

  it.each(cases)('clamps $label to $expected', async ({ limit, expected }) => {
    const { stub, service } = makeService();
    const result = await service.adminSearch({ limit });
    expect(result.limit).toBe(expected);
    // Without tags the batch size is the limit itself, so the fetch pins it too.
    expect(stub.pages).toEqual([{ limit: expected, offset: 0 }]);
  });

  it('defaults to 50 when limit is absent', async () => {
    const { stub, service } = makeService();
    await expect(service.adminSearch({})).resolves.toMatchObject({ limit: 50 });
    expect(stub.pages).toEqual([{ limit: 50, offset: 0 }]);
  });
});

describe('adminSearch host_id', () => {
  it.each([
    { label: 'an empty string', hostId: '' },
    { label: 'null', hostId: null },
    { label: 'undefined', hostId: undefined },
  ])('treats $label as no host filter', async ({ hostId }) => {
    const { stub, service } = makeService();
    const result = await service.adminSearch({ host_id: hostId });
    expect(result.host_id).toBeNull();
    expect(stub.wheres).toEqual([[]]);
  });

  it.each([
    { label: '0', hostId: 0 },
    { label: '-1', hostId: -1 },
    { label: '1.5', hostId: 1.5 },
    { label: 'a non-numeric string', hostId: 'host-a' },
    { label: 'an object', hostId: {} },
  ])('rejects $label with a host_id ValidationError', async ({ hostId }) => {
    const { stub, service } = makeService();
    const error = await rejection(service.adminSearch({ host_id: hostId }));
    expect(error).toBeInstanceOf(ValidationError);
    const validation = error as ValidationError;
    expect(validation.param).toBe('host_id');
    expect(validation.status).toBe(422);
    expect(validation.message).toBe('host_id must be a positive integer');
    expect(stub.pages).toEqual([]);
  });

  it.each([
    { label: 'a number', hostId: 7 },
    { label: 'a numeric string', hostId: '7' },
  ])('binds $label host filter', async ({ hostId }) => {
    const { stub, service } = makeService();
    const result = await service.adminSearch({ host_id: hostId });
    expect(result.host_id).toBe(7);
    expect(stub.wheres).toEqual([[7]]);
  });
});

describe('adminSearch LIKE pattern', () => {
  it('escapes % and _ in the query', async () => {
    const { stub, service } = makeService();
    await service.adminSearch({ query: '50%_off' });
    // key, content and tags_text each get the same escaped pattern.
    expect(stub.wheres).toEqual([['%50\\%\\_off%', '%50\\%\\_off%', '%50\\%\\_off%']]);
  });

  it('binds the pattern after the host filter', async () => {
    const { stub, service } = makeService();
    await service.adminSearch({ query: 'a_b', host_id: 3 });
    expect(stub.wheres).toEqual([[3, '%a\\_b%', '%a\\_b%', '%a\\_b%']]);
  });

  it('binds nothing when the query is blank', async () => {
    const { stub, service } = makeService();
    await service.adminSearch({ query: '   ' });
    expect(stub.wheres).toEqual([[]]);
  });
});

describe('adminSearch tag normalization', () => {
  const rows = () => [
    makeRow({ id: 1, tags: ['ops'] }),
    makeRow({ id: 2, tags: ['ops', 'prod'] }),
    makeRow({ id: 3, tags: ['prod'] }),
  ];

  it('accepts an array of tags', async () => {
    const { stub, service } = makeService(rows());
    const result = await service.adminSearch({ tags: ['ops', 'prod'], limit: 10 });
    expect(result.matches.map((m) => m.id)).toEqual([2]);
    expect(stub.pages).toEqual([{ limit: 30, offset: 0 }]);
  });

  it('accepts a comma separated string', async () => {
    const { service } = makeService(rows());
    const result = await service.adminSearch({ tags: 'ops,prod', limit: 10 });
    expect(result.matches.map((m) => m.id)).toEqual([2]);
  });

  it('accepts a space separated string', async () => {
    const { service } = makeService(rows());
    const result = await service.adminSearch({ tags: 'ops prod', limit: 10 });
    expect(result.matches.map((m) => m.id)).toEqual([2]);
  });

  it('drops blank entries and trims the rest', async () => {
    const { service } = makeService(rows());
    const result = await service.adminSearch({ tags: [' ops ', '', '   '], limit: 10 });
    expect(result.matches.map((m) => m.id)).toEqual([1, 2]);
  });

  it('ignores separators around the tags of a string', async () => {
    const { service } = makeService(rows());
    const result = await service.adminSearch({ tags: ' , ops , ', limit: 10 });
    expect(result.matches.map((m) => m.id)).toEqual([1, 2]);
  });

  it.each([
    { label: 'a blank string', tags: '   ' },
    { label: 'an all-blank array', tags: ['', '  '] },
    { label: 'an array of non-strings', tags: [1, null] },
    { label: 'a number', tags: 42 },
    { label: 'null', tags: null },
    { label: 'undefined', tags: undefined },
  ])('applies no tag filter for $label', async ({ tags }) => {
    const { stub, service } = makeService(rows());
    const result = await service.adminSearch({ tags, limit: 10 });
    expect(result.matches.map((m) => m.id)).toEqual([1, 2, 3]);
    // No tag filter means no over-fetch: the batch size stays at the limit.
    expect(stub.pages).toEqual([{ limit: 10, offset: 0 }]);
  });
});

describe('adminSearch batched paging', () => {
  it('over-fetches 3x the limit and advances offset until it has `limit` matches', async () => {
    const { stub, service } = makeService(
      seedRows(20, {
        2: ['alpha'],
        4: ['beta'],
        6: ['ALPHA', 'Beta', 'extra'],
        13: ['alpha', 'BETA'],
        17: ['alpha', 'beta'],
      }),
    );

    const result = await service.adminSearch({ tags: ['Alpha', 'BETA'], limit: 2 });

    expect(stub.pages).toEqual([
      { limit: 6, offset: 0 },
      { limit: 6, offset: 6 },
      { limit: 6, offset: 12 },
    ]);
    expect(result.count).toBe(2);
    expect(result.limit).toBe(2);
    expect(result.matches.map((m) => m.id)).toEqual([7, 14]);
  });

  it('requires every search tag, not just one', async () => {
    const { service } = makeService(
      seedRows(6, { 0: ['alpha'], 1: ['beta'], 2: ['alpha', 'beta'], 3: ['alpha', 'beta', 'gamma'] }),
    );
    const result = await service.adminSearch({ tags: ['alpha', 'beta'], limit: 10 });
    expect(result.matches.map((m) => m.id)).toEqual([3, 4]);
  });

  it('skips rows whose tags column is not an array', async () => {
    const { service } = makeService(seedRows(4, { 0: 'ops', 1: { ops: true }, 2: ['ops'] }));
    const result = await service.adminSearch({ tags: 'ops', limit: 10 });
    expect(result.matches.map((m) => m.id)).toEqual([3]);
  });

  it('stops on a short final page', async () => {
    const { stub, service } = makeService(seedRows(20, { 17: ['x'] }));

    const result = await service.adminSearch({ tags: ['x'], limit: 5 });

    expect(stub.pages).toEqual([
      { limit: 15, offset: 0 },
      { limit: 15, offset: 15 },
    ]);
    expect(result.matches.map((m) => m.id)).toEqual([18]);
  });

  it('stops on the empty page after an exactly full one', async () => {
    const { stub, service } = makeService(seedRows(6, { 5: ['x'] }));

    const result = await service.adminSearch({ tags: ['x'], limit: 2 });

    expect(stub.pages).toEqual([
      { limit: 6, offset: 0 },
      { limit: 6, offset: 6 },
    ]);
    expect(result.count).toBe(1);
  });

  it('fetches a single page once the limit is reached without tags', async () => {
    const { stub, service } = makeService(seedRows(10));
    const result = await service.adminSearch({ limit: 3 });
    expect(stub.pages).toEqual([{ limit: 3, offset: 0 }]);
    expect(result.matches.map((m) => m.id)).toEqual([1, 2, 3]);
  });

  it('fetches a single page when the table is smaller than the limit', async () => {
    const { stub, service } = makeService(seedRows(2));
    const result = await service.adminSearch({ limit: 5 });
    expect(stub.pages).toEqual([{ limit: 5, offset: 0 }]);
    expect(result.count).toBe(2);
  });

  it('maps rows onto the admin view', async () => {
    const { service } = makeService([
      makeRow({
        id: 9,
        hostId: 4,
        memoryKey: 'deploy',
        content: 'body',
        metadata: { source: 'mcp' },
        tags: ['ops', 5, null],
        tagsText: 'ops',
        summary: 'a summary',
        engine: 'codex',
        createdAt: '2026-07-01T09:00:00Z',
        updatedAt: '2026-07-02T11:00:00Z',
        deletedAt: null,
      }),
    ]);

    const result = await service.adminSearch({});

    expect(result.matches).toEqual([
      {
        id: 9,
        host_id: 4,
        memory_key: 'deploy',
        content: 'body',
        metadata: { source: 'mcp' },
        tags: ['ops'],
        summary: 'a summary',
        engine: 'codex',
        created_at: '2026-07-01T09:00:00Z',
        updated_at: '2026-07-02T11:00:00Z',
        deleted_at: null,
      },
    ]);
  });
});

describe('adminDelete', () => {
  it.each([0, -1, 1.5, NaN])('rejects id %p with a ValidationError', async (id) => {
    const { stub, service } = makeService([makeRow({ id: 1 })]);
    const error = await rejection(service.adminDelete(id));
    expect(error).toBeInstanceOf(ValidationError);
    expect((error as ValidationError).param).toBe('id');
    expect(stub.deletes).toEqual([]);
    expect(memoryEvents()).toEqual([]);
  });

  it('throws memory_not_found for a missing row', async () => {
    const { stub, service } = makeService([makeRow({ id: 1 })]);
    const error = await rejection(service.adminDelete(2));
    expect(error).toBeInstanceOf(NotFoundError);
    const notFound = error as NotFoundError;
    expect(notFound.code).toBe('memory_not_found');
    expect(notFound.status).toBe(404);
    expect(stub.deletes).toEqual([]);
    expect(stub.rows).toHaveLength(1);
    expect(memoryEvents()).toEqual([]);
  });

  it('hard deletes the row and publishes both events', async () => {
    const { stub, service } = makeService([
      makeRow({ id: 1, hostId: 3, memoryKey: 'keep' }),
      makeRow({ id: 2, hostId: 8, memoryKey: 'deploy-notes' }),
    ]);

    await expect(service.adminDelete(2)).resolves.toEqual({ deleted: 2 });

    // A hard delete, not a soft one: the row is gone so the unique slot frees up.
    expect(stub.deletes).toEqual([2]);
    expect(stub.rows.map((row) => row.id)).toEqual([1]);
    expect(memoryEvents()).toEqual([
      { type: 'memory.deleted', payload: { id: 2, host_id: 8, memory_key: 'deploy-notes' } },
      { type: 'memory.changed', payload: { id: 2, host_id: 8 } },
    ]);
  });
});
