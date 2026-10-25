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
  return tables;
}
