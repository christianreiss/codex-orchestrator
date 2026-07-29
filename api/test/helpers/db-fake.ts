/**
 * Tiny in-memory fake for Drizzle's typed query builder. Only supports the
 * subset of patterns the host-api routes use, returning fixed rows via test
 * setup. Tests construct rows and pass them in; insert/update/delete just
 * record the called values.
 *
 * Each .from(table) call returns a builder that pretends to be both an
 * awaitable Promise (for unfiltered selects via `await db.select().from(t)`)
 * and a chain (.where(...).limit(...) -> Promise) so the same fake works for
 * both styles.
 */

import { hosts, versions as versionsTable } from '../../src/db/schema.js';

type Row = Record<string, unknown>;
type TableMap = Map<unknown, Row[]>;

export interface DbFake {
  tables: TableMap;
  inserts: Array<{ table: unknown; values: Row | Row[] }>;
  updates: Array<{ table: unknown; set: Row; where: unknown }>;
  deletes: Array<{ table: unknown; where: unknown }>;
  locks: Array<{ table: unknown; where: unknown; strength: unknown }>;
  transactions: unknown[];
  // Drizzle-compatible verbs (loose typing)
  select(_fields?: unknown): unknown;
  insert(table: unknown): unknown;
  update(table: unknown): unknown;
  delete(table: unknown): unknown;
  transaction<T>(cb: (tx: DbFake) => Promise<T>, config?: unknown): Promise<T>;
}

export function createDbFake(initial: Map<unknown, Row[]> = new Map()): DbFake {
  const tables: TableMap = initial;
  // Per-table AUTO_INCREMENT counters. Deriving ids from the current row count
  // instead would hand every row of a batch insert the same id and would
  // reissue ids after a delete -- two states MySQL cannot reach, which matters
  // for services that batch-insert chunk rows and delete superseded ones.
  const nextIds = new Map<unknown, number>();

  function nextId(table: unknown, rows: Row[]): number {
    // The first allocation continues from the seeded row count and skips any id
    // a row already holds; after that the counter only climbs, so neither a
    // batch insert nor a delete can hand out an id twice.
    let id = nextIds.get(table) ?? rows.length + 1;
    while (rows.some((row) => row.id === id)) id += 1;
    nextIds.set(table, id + 1);
    return id;
  }

  const fake: DbFake = {
    tables,
    inserts: [],
    updates: [],
    deletes: [],
    locks: [],
    transactions: [],

    // This fake is single-threaded/in-memory, so a "transaction" is just
    // running the callback against the same fake -- there's no real
    // concurrency to isolate, only the API shape (tx.select/.insert/.update)
    // needs to match what the services under test call.
    transaction<T>(cb: (tx: DbFake) => Promise<T>, config?: unknown): Promise<T> {
      fake.transactions.push(config);
      return cb(fake);
    },

    select(_fields?: unknown) {
      return {
        from(table: unknown) {
          const rows = (tables.get(table) ?? []).slice();
          // Awaitable: returns ALL rows
          const builder: any = Promise.resolve(rows);
          builder.where = (_w: unknown) => {
            const filtered = filterRows(rows, _w);
            const inner: any = Promise.resolve(filtered);
            inner.limit = (_n: number) => Promise.resolve(filtered.slice(0, _n));
            inner.orderBy = (..._args: unknown[]) => {
              const o: any = Promise.resolve(filtered);
              o.limit = (_n: number) => Promise.resolve(filtered.slice(0, _n));
              return o;
            };
            // Row locking is a no-op here: the fake is single-threaded, so
            // `.for('update')` just resolves to the same filtered rows. Without
            // this, any service path going through recordEvent's SELECT ... FOR
            // UPDATE is untestable.
            inner.for = (_strength?: unknown) => {
              fake.locks.push({ table, where: _w, strength: _strength });
              return inner;
            };
            return inner;
          };
          builder.orderBy = (..._args: unknown[]) => {
            const o: any = Promise.resolve(rows);
            o.limit = (_n: number) => Promise.resolve(rows.slice(0, _n));
            return o;
          };
          builder.limit = (_n: number) => Promise.resolve(rows.slice(0, _n));
          return builder;
        },
      };
    },

    insert(table: unknown) {
      return {
        values: (vals: Row | Row[]) => {
          fake.inserts.push({ table, values: vals });
          const existing = tables.get(table) ?? [];
          const list = Array.isArray(vals) ? vals : [vals];
          let insertId: unknown;
          for (const v of list) {
            const id = v.id ?? nextId(table, existing);
            if (insertId === undefined) insertId = id;
            existing.push({ id, ...v });
          }
          tables.set(table, existing);
          // Drizzle returns [{ insertId, affectedRows }, ...]; like MySQL, the
          // insertId of a batch is the id of its first row.
          const result = Promise.resolve([{ insertId, affectedRows: list.length }]);
          // This fake has no unique-index enforcement, so `ON DUPLICATE KEY
          // UPDATE` just resolves like a plain insert -- good enough for
          // tests that only care about the call succeeding/returning.
          (result as any).onDuplicateKeyUpdate = (_opts: unknown) => result;
          return result;
        },
      };
    },

    update(table: unknown) {
      return {
        set: (vals: Row) => ({
          where: (w: unknown) => {
            fake.updates.push({ table, set: vals, where: w });
            const rows = tables.get(table) ?? [];
            const filtered = filterRows(rows, w);
            for (const r of filtered) Object.assign(r, vals);
            return Promise.resolve([{ affectedRows: filtered.length }]);
          },
        }),
      };
    },

    delete(table: unknown) {
      return {
        where: (w: unknown) => {
          fake.deletes.push({ table, where: w });
          const rows = tables.get(table) ?? [];
          const matched = filterRows(rows, w);
          const removed = new Set(matched);
          tables.set(
            table,
            rows.filter((row) => !removed.has(row)),
          );
          return Promise.resolve([{ affectedRows: matched.length }]);
        },
      };
    },
  };
  return fake;
}

function filterRows(rows: Row[], where: unknown): Row[] {
  const conditions = containsOr(where) ? [] : whereConditions(where);
  if (conditions.length > 0) {
    return rows.filter((row) =>
      conditions.every(({ column, value }) => {
        const actual = rowValue(row, column);
        return value === null ? actual === null || actual === undefined : actual === value;
      }),
    );
  }
  const values = whereValues(where);
  if (values.length === 0) return rows;
  return rows.filter((row) => Object.values(row).some((value) => values.includes(value)));
}

interface WhereCondition {
  column: string;
  value: unknown;
}

function whereConditions(where: unknown): WhereCondition[] {
  const out: WhereCondition[] = [];
  visitConditions(where, out, new WeakSet<object>());
  return out;
}

function visitConditions(value: unknown, out: WhereCondition[], seen: WeakSet<object>): void {
  if (!value || typeof value !== 'object' || seen.has(value)) return;
  seen.add(value);
  const chunks = (value as { queryChunks?: unknown[] }).queryChunks;
  if (!Array.isArray(chunks)) return;

  const column = chunks.find(isColumnChunk);
  const param = chunks.find(
    (chunk): chunk is { value: unknown } =>
      !!chunk && typeof chunk === 'object' && chunk.constructor?.name === 'Param' && 'value' in chunk,
  );
  const operator = chunks.map(stringChunkValue).join('').toLowerCase();
  if (column && param && /\s=\s/.test(operator)) {
    out.push({ column: column.name, value: param.value });
    return;
  }
  if (column && /\sis\s+null\b/.test(operator)) {
    out.push({ column: column.name, value: null });
    return;
  }
  for (const chunk of chunks) visitConditions(chunk, out, seen);
}

function containsOr(value: unknown, seen = new WeakSet<object>()): boolean {
  if (!value || typeof value !== 'object' || seen.has(value)) return false;
  seen.add(value);
  const chunks = (value as { queryChunks?: unknown[] }).queryChunks;
  if (!Array.isArray(chunks)) return false;
  return chunks.some((chunk) => /\sor\s/i.test(stringChunkValue(chunk)) || containsOr(chunk, seen));
}

function isColumnChunk(value: unknown): value is { name: string } {
  return (
    !!value &&
    typeof value === 'object' &&
    typeof (value as { name?: unknown }).name === 'string' &&
    'table' in value
  );
}

function stringChunkValue(value: unknown): string {
  if (!value || typeof value !== 'object' || value.constructor?.name !== 'StringChunk') return '';
  const raw = (value as { value?: unknown }).value;
  return Array.isArray(raw) ? raw.join('') : typeof raw === 'string' ? raw : '';
}

function rowValue(row: Row, column: string): unknown {
  if (column in row) return row[column];
  const camel = column.replace(/_([a-z])/g, (_match, letter: string) => letter.toUpperCase());
  return row[camel];
}

function whereValues(where: unknown): unknown[] {
  const out: unknown[] = [];
  visitWhere(where, out, new WeakSet<object>());
  return out;
}

function visitWhere(value: unknown, out: unknown[], seen: WeakSet<object>): void {
  if (!value || typeof value !== 'object') return;
  if (seen.has(value)) return;
  seen.add(value);
  const ctor = (value as { constructor?: { name?: string } }).constructor?.name;
  if (ctor === 'Param' && 'value' in value) {
    out.push((value as { value: unknown }).value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) visitWhere(item, out, seen);
    return;
  }
  for (const item of Object.values(value as Record<string, unknown>)) {
    visitWhere(item, out, seen);
  }
}

// Expose tables for convenient setup.
export { hosts, versionsTable };
