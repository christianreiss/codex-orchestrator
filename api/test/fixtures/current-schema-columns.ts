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
  const pairing = resolve(import.meta.dirname, '../../src/db/migrations/0107_companion_pairing_device.sql');
  const pairingColumns = splitSqlStatements(readFileSync(pairing, 'utf8')).flatMap((statement) =>
    [...statement.matchAll(/ALTER\s+TABLE\s+`?([A-Za-z0-9_$]+)`?\s+ADD\s+COLUMN\s+`?([A-Za-z0-9_$]+)`?/gi)]
      .map((match) => ({ table: match[1]!, column: match[2]! })),
  );
  if (pairingColumns.length !== 1 || pairingColumns[0]!.table !== 'companion_pairings' || pairingColumns[0]!.column !== 'device_id')
    throw new Error('Migration 0107 must declare companion_pairings.device_id; cannot project the bootstrap schema');
  tables.get('companion_pairings')!.add('device_id');
  const shared = resolve(import.meta.dirname, '../../src/db/migrations/0108_companion_shared_reads.sql');
  const sharedSql = readFileSync(shared, 'utf8');
  if (!/CREATE TABLE IF NOT EXISTS companion_reads/i.test(sharedSql) || !/ADD COLUMN read_sync_protocol/i.test(sharedSql))
    throw new Error('Migration 0108 must declare shared reads and device protocol');
  tables.set('companion_reads', new Set(['user_id', 'session_id', 'read_cursor', 'updated_at']));
  tables.get('companion_devices')!.add('read_sync_protocol');
  const supervisor=resolve(import.meta.dirname,'../../src/db/migrations/0111_agent_supervisor.sql');
  const newTables=splitSqlStatements(readFileSync(supervisor,'utf8')).map(statement=>{
    const name=/^CREATE TABLE IF NOT EXISTS ([a-z_]+)/i.exec(statement)?.[1];
    if(!name)throw new Error('Migration 0111 must create the supervisor tables');
    const columns=[...statement.matchAll(/(?:^|,)\s*([a-z_]+)\s+(?:CHAR|VARCHAR|TINYINT|INT)\b/gim)].map(m=>m[1]!);
    if(!columns.length)throw new Error('Migration 0111 columns could not be read');
    tables.set(name,new Set(columns));return name;
  });
  if(newTables.join()!=='agent_work_states,agent_work_dependencies')throw new Error('Migration 0111 supervisor table inventory changed');
  // Migration 0116 adds the open-or-join rendezvous key to conferences.
  const rendezvous = readFileSync(resolve(import.meta.dirname, '../../src/db/migrations/0116_conference_rendezvous_key.sql'), 'utf8');
  if (!/ADD COLUMN rendezvous_key CHAR\(64\) NULL/i.test(rendezvous))
    throw new Error('Migration 0116 must declare agent_bus_conferences.rendezvous_key; cannot project the bootstrap schema');
  tables.get('agent_bus_conferences')!.add('rendezvous_key');
  return tables;
}
