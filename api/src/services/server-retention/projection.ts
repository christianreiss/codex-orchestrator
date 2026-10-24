import { getTableColumns } from 'drizzle-orm';
import { getTableConfig } from 'drizzle-orm/mysql-core';
import * as schema from '../../db/schema.js';
import {
  OWNED_TABLE_NAMES,
  stateKeyFields,
  type OwnedTableName,
  type StateRow,
} from '../../control-plane/state/catalog.js';
import type { OwnerStateDraft } from '../../control-plane/state/store.js';

type RecordRow = Record<string, unknown>;
type Key = string | number | bigint | readonly (string | number | bigint)[];
/** Mirrors declared FK effects in RAM after the corresponding explicit DML.
 * It never interprets SQL or makes a database read. */
export class RetentionProjection {
  constructor(readonly draft: OwnerStateDraft) {}
  removeWhere<K extends OwnedTableName>(table: K, predicate: (row: Readonly<StateRow<K>>) => boolean): void {
    for (const row of this.draft.table(table).all()) if (predicate(row)) this.remove(table, row);
  }
  patchWhere<K extends OwnedTableName>(
    table: K,
    predicate: (row: Readonly<StateRow<K>>) => boolean,
    patch: Partial<StateRow<K>> | ((row: Readonly<StateRow<K>>) => Partial<StateRow<K>>),
  ): void {
    for (const row of this.draft.table(table).all())
      if (predicate(row))
        this.draft.upsert(table, {
          ...row,
          ...(typeof patch === 'function' ? patch(row) : patch),
        } as StateRow<K>);
  }
  remove<K extends OwnedTableName>(table: K, row: Readonly<StateRow<K>>): void {
    const record = row as RecordRow;
    const key = stateKeyFields(table).map((field) => record[field]) as Key;
    if (!this.draft.table(table).has(key)) return;
    this.draft.remove(table, key);
    const parentColumns = getTableColumns(schema[table]);
    for (const child of OWNED_TABLE_NAMES) {
      const childColumns = getTableColumns(schema[child]);
      for (const fk of getTableConfig(schema[child]).foreignKeys) {
        const reference = fk.reference();
        if (reference.foreignTable !== schema[table] || !['cascade', 'set null'].includes(fk.onDelete ?? ''))
          continue;
        const parents = reference.foreignColumns.map(
          (column) => Object.entries(parentColumns).find(([, value]) => value === column)?.[0],
        );
        const children = reference.columns.map(
          (column) => Object.entries(childColumns).find(([, value]) => value === column)?.[0],
        );
        if (parents.some((field) => !field) || children.some((field) => !field))
          throw new Error('Unknown retention foreign-key projection');
        const matches = (candidate: Readonly<StateRow<typeof child>>) =>
          children.every(
            (field, i) =>
              (candidate as RecordRow)[field!] !== null &&
              (candidate as RecordRow)[field!] !== undefined &&
              (candidate as RecordRow)[field!] === record[parents[i]!],
          );
        if (fk.onDelete === 'cascade') this.removeWhere(child, matches);
        else this.patchWhere(child, matches, Object.fromEntries(children.map((field) => [field!, null])));
      }
    }
  }
}
