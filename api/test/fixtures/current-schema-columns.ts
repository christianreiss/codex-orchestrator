import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { splitSqlStatements } from '../../src/db/migration-sql.js';

/** The shipped bootstrap snapshot is followed by migrations on fresh installs.
 * Keep that snapshot unchanged and project the task's additive migration into
 * the test fixture, independently of schema.ts. No drift exception is granted. */
export function currentSchemaColumns(): Map<string, Set<string>> {
  const baseline = resolve(import.meta.dirname, '../../src/db/baseline/schema.sql');
  const tables = new Map<string, Set<string>>();
  for (const statement of splitSqlStatements(readFileSync(baseline, 'utf8'))) {
    const table = /^CREATE\s+TABLE\s+`([^`]+)`/i.exec(statement);
    if (!table) continue;
    tables.set(
      table[1]!,
      new Set([...statement.matchAll(/^\s*`([^`]+)`\s+\S/gm)].map((column) => column[1]!)),
    );
  }
  const migration = resolve(
    import.meta.dirname,
    '../../src/db/migrations/0105_agent_message_delivery_timing.sql',
  );
  const additions = splitSqlStatements(readFileSync(migration, 'utf8')).flatMap((statement) =>
    [
      ...statement.matchAll(/ALTER\s+TABLE\s+`?([A-Za-z0-9_$]+)`?\s+ADD\s+COLUMN\s+`?([A-Za-z0-9_$]+)`?/gi),
    ].map((match) => ({ table: match[1]!, column: match[2]! })),
  );
  if (
    additions.length !== 1 ||
    additions[0]!.table !== 'agent_bus_messages' ||
    additions[0]!.column !== 'delivery_timing'
  )
    throw new Error(
      'Migration 0105 must declare the delivery_timing column; cannot project the bootstrap schema',
    );
  for (const { table, column } of additions) {
    const columns = tables.get(table);
    if (!columns) throw new Error(`Migration 0105 extends missing bootstrap table ${table}`);
    columns.add(column);
  }
  // Migration 0106 creates agent_room_agent_reads; project it the same way.
  const roomReads = resolve(import.meta.dirname, '../../src/db/migrations/0106_agent_room_agent_reads.sql');
  const created = splitSqlStatements(readFileSync(roomReads, 'utf8')).flatMap((statement) => {
    const table = /^CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?`?([A-Za-z0-9_$]+)`?/i.exec(statement);
    return table
      ? [{ table: table[1]!, columns: [...statement.matchAll(/^\s+([a-z_][a-z0-9_]*)\s+(?:char|varchar|int)\b/gim)].map((c) => c[1]!) }]
      : [];
  });
  if (
    created.length !== 1 ||
    created[0]!.table !== 'agent_room_agent_reads' ||
    created[0]!.columns.join() !== 'room_id,address_id,read_through,updated_at'
  )
    throw new Error('Migration 0106 must create agent_room_agent_reads; cannot project the bootstrap schema');
  tables.set(created[0]!.table, new Set(created[0]!.columns));
  return tables;
}
