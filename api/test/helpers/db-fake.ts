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
}

export function createDbFake(initial: Map<unknown, Row[]> = new Map()): DbFake {
  const tables: TableMap = initial;
  const fake: DbFake = {
    tables,
    inserts: [],
    updates: [],
    deletes: [],

    select(_fields?: unknown) {
      return {
        from(table: unknown) {
          const rows = (tables.get(table) ?? []).slice();
          // Awaitable: returns ALL rows
          const builder: any = Promise.resolve(rows);
          builder.where = (_w: unknown) => {
            const inner: any = Promise.resolve(rows);
            inner.limit = (_n: number) => Promise.resolve(rows.slice(0, _n));
            inner.orderBy = (..._args: unknown[]) => {
              const o: any = Promise.resolve(rows);
              o.limit = (_n: number) => Promise.resolve(rows.slice(0, _n));
              return o;
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
          const nextId = existing.length + 1;
          for (const v of list) existing.push({ id: nextId, ...v });
          tables.set(table, existing);
          // Drizzle returns [{ insertId, affectedRows }, ...]
          return Promise.resolve([{ insertId: nextId, affectedRows: list.length }]);
        },
      };
    },

    update(table: unknown) {
      return {
        set: (vals: Row) => ({
          where: (w: unknown) => {
            fake.updates.push({ table, set: vals, where: w });
            const rows = tables.get(table) ?? [];
            // naive: apply to all rows (tests typically have one host)
            for (const r of rows) Object.assign(r, vals);
            return Promise.resolve([{ affectedRows: rows.length }]);
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

// Expose tables for convenient setup.
export { hosts, versionsTable };
