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
  // Drizzle-compatible verbs (loose typing)
  select(_fields?: unknown): unknown;
  insert(table: unknown): unknown;
  update(table: unknown): unknown;
  delete(table: unknown): unknown;
  transaction<T>(cb: (tx: DbFake) => Promise<T>): Promise<T>;
}

export function createDbFake(initial: Map<unknown, Row[]> = new Map()): DbFake {
  const tables: TableMap = initial;
  const fake: DbFake = {
    tables,
    inserts: [],
    updates: [],
    deletes: [],

    // This fake is single-threaded/in-memory, so a "transaction" is just
    // running the callback against the same fake -- there's no real
    // concurrency to isolate, only the API shape (tx.select/.insert/.update)
    // needs to match what the services under test call.
    transaction<T>(cb: (tx: DbFake) => Promise<T>): Promise<T> {
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
            inner.for = (_strength?: unknown) => inner;
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
          const nextId = existing.length + 1;
          for (const v of list) existing.push({ id: nextId, ...v });
          tables.set(table, existing);
          // Drizzle returns [{ insertId, affectedRows }, ...]
          const result = Promise.resolve([{ insertId: nextId, affectedRows: list.length }]);
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
          tables.set(table, []);
          return Promise.resolve([{ affectedRows: 1 }]);
        },
      };
    },
  };
  return fake;
}

function filterRows(rows: Row[], where: unknown): Row[] {
  const values = whereValues(where);
  if (values.length === 0) return rows;
  return rows.filter((row) => Object.values(row).some((value) => values.includes(value)));
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
