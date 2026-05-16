/**
 * Tiny in-memory stand-in for the Drizzle MySQL client.
 *
 * Supports only the chain shapes exercised by the admin-hosts services:
 *
 *   db.select(...).from(t).where(eq(t.col, value)).limit(n)
 *   db.select({proj}).from(t).leftJoin(t2, eq(t2.col, t.col)).where(...).orderBy(...).limit(n)
 *   db.insert(t).values(row | rows)         -> returns [{ insertId, affectedRows }]
 *   db.update(t).set(patch).where(eq(...))  -> awaitable
 *   db.delete(t).where(eq(...))             -> awaitable
 *
 * Predicates only support `eq(column, value)` because that's the only shape
 * the services use. Joins likewise use a single `eq(joinedCol, sourceCol)`.
 */
import type { Database } from '../../src/db/client.js';

type Row = Record<string, unknown>;

interface ColumnRef {
  tableName: string;
  dbCol: string;
}

interface TableInfo {
  name: string;
  // ts column key -> db column name
  tsToDb: Record<string, string>;
  dbToTs: Record<string, string>;
}

function tableInfoOf(table: unknown): TableInfo {
  const syms = Object.getOwnPropertySymbols(table as object);
  const nameSym = syms.find((s) => s.toString() === 'Symbol(drizzle:Name)');
  const colsSym = syms.find((s) => s.toString() === 'Symbol(drizzle:Columns)');
  const name = nameSym ? ((table as Record<symbol, unknown>)[nameSym] as string) : 'unknown';
  const cols = colsSym
    ? ((table as Record<symbol, unknown>)[colsSym] as Record<string, { name: string }>)
    : {};
  const tsToDb: Record<string, string> = {};
  const dbToTs: Record<string, string> = {};
  for (const ts of Object.keys(cols)) {
    const dbName = cols[ts]!.name;
    tsToDb[ts] = dbName;
    dbToTs[dbName] = ts;
  }
  return { name, tsToDb, dbToTs };
}

function columnRef(col: unknown): ColumnRef | null {
  if (!col || typeof col !== 'object') return null;
  const c = col as { name?: string; table?: unknown };
  if (typeof c.name !== 'string' || !c.table) return null;
  const info = tableInfoOf(c.table);
  return { tableName: info.name, dbCol: c.name };
}

interface EqPredicate {
  kind: 'eq';
  column: ColumnRef;
  // Either a literal value (eq(col, literal)) or a column ref (eq(col, otherCol)) used for joins
  rhs: { kind: 'value'; value: unknown } | { kind: 'column'; column: ColumnRef };
}

function decodeEq(expr: unknown): EqPredicate | null {
  if (!expr || typeof expr !== 'object') return null;
  const e = expr as { queryChunks?: unknown[] };
  const chunks = e.queryChunks;
  if (!Array.isArray(chunks)) return null;
  // Expected order (eq): [StringChunk(''), column, StringChunk(' = '), Param|column, StringChunk('')]
  if (chunks.length !== 5) return null;
  const left = columnRef(chunks[1]);
  if (!left) return null;
  const rhsChunk = chunks[3];
  if (!rhsChunk || typeof rhsChunk !== 'object') return null;
  const r = rhsChunk as Record<string, unknown>;
  if ('value' in r && 'encoder' in r) {
    return { kind: 'eq', column: left, rhs: { kind: 'value', value: r.value } };
  }
  const col = columnRef(rhsChunk);
  if (col) {
    return { kind: 'eq', column: left, rhs: { kind: 'column', column: col } };
  }
  return null;
}

function tsRowFromInsert(row: Row, info: TableInfo): Row {
  const out: Row = {};
  for (const [k, v] of Object.entries(row)) {
    out[info.tsToDb[k] ?? k] = v;
  }
  return out;
}

function tsRowFromDb(row: Row, info: TableInfo): Row {
  const out: Row = {};
  for (const [k, v] of Object.entries(row)) {
    out[info.dbToTs[k] ?? k] = v;
  }
  return out;
}

export interface MockStore {
  tables: Map<string, Row[]>;
  autoIncrement: Map<string, number>;
}

export interface MockDb {
  db: Database;
  store: MockStore;
  insertRow(tableName: string, row: Row): Row;
  rows(tableName: string): Row[];
  reset(): void;
}

export function createMockDb(): MockDb {
  const store: MockStore = {
    tables: new Map(),
    autoIncrement: new Map(),
  };

  function ensure(name: string): Row[] {
    let rows = store.tables.get(name);
    if (!rows) {
      rows = [];
      store.tables.set(name, rows);
    }
    return rows;
  }

  function nextId(name: string): number {
    const cur = (store.autoIncrement.get(name) ?? 0) + 1;
    store.autoIncrement.set(name, cur);
    return cur;
  }

  const dbApi = {
    select(projection?: Record<string, unknown>) {
      let baseInfo: TableInfo | null = null;
      let joinInfo: TableInfo | null = null;
      let joinPred: EqPredicate | null = null;
      const wheres: EqPredicate[] = [];
      let limitN = Infinity;

      const builder: Record<string, unknown> = {
        from(table: unknown) {
          baseInfo = tableInfoOf(table);
          return builder;
        },
        leftJoin(table: unknown, on: unknown) {
          joinInfo = tableInfoOf(table);
          joinPred = decodeEq(on);
          return builder;
        },
        where(expr: unknown) {
          const p = decodeEq(expr);
          if (p) wheres.push(p);
          return builder;
        },
        orderBy() {
          return builder;
        },
        limit(n: number) {
          limitN = n;
          return builder;
        },
        then(resolve: (rows: Row[]) => void) {
          if (!baseInfo) {
            resolve([]);
            return;
          }
          const baseRows = ensure(baseInfo.name).filter((r) =>
            wheres.every(
              (w) =>
                w.column.tableName === baseInfo!.name &&
                w.rhs.kind === 'value' &&
                r[w.column.dbCol] === w.rhs.value,
            ),
          );
          let merged: Array<{ base: Row; joined: Row | null }> = baseRows.map((r) => ({
            base: r,
            joined: null,
          }));
          if (joinInfo && joinPred && joinPred.rhs.kind === 'column') {
            const jInfo = joinInfo;
            const jPred = joinPred;
            // jPred.column is on one table, jPred.rhs.column on the other
            const joinedRows = ensure(jInfo.name);
            merged = merged.map(({ base }) => {
              // Identify which side is the joined table.
              const leftCol = jPred.column;
              const rightCol = jPred.rhs.kind === 'column' ? jPred.rhs.column : null;
              if (!rightCol) return { base, joined: null };
              // Determine the joined-table column and the base-table column.
              let joinedTableCol: string;
              let baseTableCol: string;
              if (leftCol.tableName === jInfo.name) {
                joinedTableCol = leftCol.dbCol;
                baseTableCol = rightCol.dbCol;
              } else {
                joinedTableCol = rightCol.dbCol;
                baseTableCol = leftCol.dbCol;
              }
              const j =
                joinedRows.find((jr) => jr[joinedTableCol] === base[baseTableCol]) ?? null;
              return { base, joined: j };
            });
          }
          if (limitN !== Infinity) merged = merged.slice(0, limitN);
          let out: Row[];
          if (projection) {
            out = merged.map(({ base, joined }) => {
              const row: Row = {};
              for (const [alias, ref] of Object.entries(projection)) {
                const c = columnRef(ref);
                if (!c) continue;
                if (baseInfo && c.tableName === baseInfo.name) {
                  row[alias] = base[c.dbCol] ?? null;
                } else if (joinInfo && c.tableName === joinInfo.name) {
                  row[alias] = joined ? (joined[c.dbCol] ?? null) : null;
                } else {
                  row[alias] = null;
                }
              }
              resolve;
              return row;
            });
          } else {
            out = merged.map(({ base }) => tsRowFromDb(base, baseInfo!));
          }
          resolve(out);
        },
      };
      return builder;
    },
    insert(table: unknown) {
      const info = tableInfoOf(table);
      return {
        values(input: Row | Row[]) {
          const rowsIn = Array.isArray(input) ? input : [input];
          const stored = ensure(info.name);
          let lastInsertId = 0;
          for (const row of rowsIn) {
            const dbRow = tsRowFromInsert(row, info);
            if (dbRow.id === undefined && 'id' in info.tsToDb) {
              dbRow.id = nextId(info.name);
            }
            stored.push(dbRow);
            lastInsertId = (dbRow.id as number) ?? 0;
          }
          return Promise.resolve([{ insertId: lastInsertId, affectedRows: rowsIn.length }]);
        },
      };
    },
    update(table: unknown) {
      const info = tableInfoOf(table);
      let patch: Row = {};
      let pred: EqPredicate | null = null;
      const builder: Record<string, unknown> = {
        set(p: Row) {
          patch = p;
          return builder;
        },
        where(expr: unknown) {
          pred = decodeEq(expr);
          return builder;
        },
        then(resolve: (v: unknown) => void) {
          const dbPatch = tsRowFromInsert(patch, info);
          const rows = ensure(info.name);
          let count = 0;
          for (const r of rows) {
            if (!pred) {
              Object.assign(r, dbPatch);
              count++;
              continue;
            }
            if (
              pred.column.tableName === info.name &&
              pred.rhs.kind === 'value' &&
              r[pred.column.dbCol] === pred.rhs.value
            ) {
              Object.assign(r, dbPatch);
              count++;
            }
          }
          resolve([{ affectedRows: count }]);
        },
      };
      return builder;
    },
    delete(table: unknown) {
      const info = tableInfoOf(table);
      let pred: EqPredicate | null = null;
      const builder: Record<string, unknown> = {
        where(expr: unknown) {
          pred = decodeEq(expr);
          return builder;
        },
        then(resolve: (v: unknown) => void) {
          const tName = info.name;
          const rows = ensure(tName);
          const keep: Row[] = [];
          let removed = 0;
          for (const r of rows) {
            if (
              pred &&
              pred.column.tableName === tName &&
              pred.rhs.kind === 'value' &&
              r[pred.column.dbCol] === pred.rhs.value
            ) {
              removed++;
            } else {
              keep.push(r);
            }
          }
          store.tables.set(tName, keep);
          resolve([{ affectedRows: removed }]);
        },
      };
      return builder;
    },
  };

  return {
    db: dbApi as unknown as Database,
    store,
    insertRow(name: string, row: Row): Row {
      const rows = ensure(name);
      if (row.id === undefined) row.id = nextId(name);
      rows.push(row);
      return row;
    },
    rows(name: string): Row[] {
      return ensure(name);
    },
    reset() {
      store.tables.clear();
      store.autoIncrement.clear();
    },
  };
}
