import { recordMessagingRowChange } from './messaging-totals.js';
import { and, eq, getTableColumns, type SQL } from 'drizzle-orm';
import type { AnyMySqlColumn, AnyMySqlTable } from 'drizzle-orm/mysql-core';
import * as schema from '../../db/schema.js';
import { stateKeyFields, type OwnedTableName, type Row, type StateRow } from './catalog.js';
import type { OwnerMutationContext } from './runtime.js';

type RowKey = string | number | bigint | readonly (string | number | bigint)[];

/** Explicit row persistence used by domain commands, never a SQL query adapter. */
function identity<K extends OwnedTableName>(name: K, row: Readonly<StateRow<K>>): SQL {
  const columns: Record<string, AnyMySqlColumn> = getTableColumns(schema[name]);
  const values = row as Record<string, unknown>;
  return and(...stateKeyFields(name).map((field) => eq(columns[field]!, values[field])))!;
}

export function stageUpdate<K extends OwnedTableName>(
  context: OwnerMutationContext,
  name: K,
  key: RowKey,
  patch: Partial<Row<K>>,
): Readonly<StateRow<K>> {
  const previous = context.draft.table(name).get(key);
  if (!previous) throw new Error(`Cannot update missing owned row ${name}`);
  for (const field of stateKeyFields(name))
    if (
      Object.hasOwn(patch, field) &&
      (patch as Record<string, unknown>)[field] !== (previous as Record<string, unknown>)[field]
    )
      throw new Error('Owned row identity cannot change');
  if (name === 'agentBusMessages' || name === 'agentMessages')
    recordMessagingRowChange(
      context.draft,
      name,
      previous as unknown as { status: string },
      { ...previous, ...patch } as unknown as { status: string },
    );
  context.draft.upsert(name, { ...previous, ...patch } as StateRow<K>);
  context.write(async (tx) => {
    await tx
      .update(schema[name] as AnyMySqlTable)
      .set(patch)
      .where(identity(name, previous));
  });
  return context.draft.table(name).get(key)!;
}

/** Caller also stages every affected FK cascade or SET NULL projection. */
export function stageDelete<K extends OwnedTableName>(
  context: OwnerMutationContext,
  name: K,
  key: RowKey,
): boolean {
  const previous = context.draft.table(name).get(key);
  if (!previous) return false;
  if (name === 'agentBusMessages' || name === 'agentMessages')
    recordMessagingRowChange(context.draft, name, previous as unknown as { status: string }, null);
  context.draft.remove(name, key);
  context.write(async (tx) => {
    await tx.delete(schema[name]).where(identity(name, previous));
  });
  return true;
}
