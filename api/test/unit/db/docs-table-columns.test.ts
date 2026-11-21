import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { is } from 'drizzle-orm';
import { getTableConfig, MySqlTable } from 'drizzle-orm/mysql-core';
import * as mirror from '../../../src/db/schema.js';

/**
 * `docs/interface-db.md` opens with "Column names and types below are derived
 * from that schema file", and every table bullet spells out a full column list —
 * the `hosts` one alone names about forty-five. `docs-table-coverage` pins the
 * table names and says what it leaves out ("Columns, types and indexes are not
 * compared"), and `schema-baseline-drift` and `migration-schema-drift` pin
 * `schema.ts` against the SQL but never against the doc.
 *
 * This resolves each documented column against the mirror it claims to be
 * derived from, in both directions: a bullet may not name a column `schema.ts`
 * does not declare, and a declared column needs an entry in its table's bullet.
 * Types, defaults and indexes are still not compared. Unlike the sibling checks
 * it fails closed on its own extraction — a table or bullet it cannot read
 * throws rather than contributing an empty set — and a delta is excusable only
 * through `ALLOWED`, which demands a written reason.
 */

const DOC = resolve(import.meta.dirname, '../../../../docs/interface-db.md');

/**
 * Deltas the doc keeps on purpose, as `table.column` → why. The answer to a
 * failure below is normally to fix `docs/interface-db.md`, not to add an entry
 * here.
 */
const ALLOWED = new Map<string, string>([
  // Empty on purpose: the doc names every column the mirror declares, and no
  // column it does not.
]);

function schemaColumns(): Map<string, string[]> {
  const tables = new Map<string, string[]>();
  for (const exported of Object.values(mirror)) {
    if (!is(exported, MySqlTable)) continue;
    const table = getTableConfig(exported);
    tables.set(table.name, table.columns.map((column) => column.name));
  }
  if (!tables.size) throw new Error('No MySQL tables exported by the schema');
  return tables;
}

/** The doc opens each table's bullet with its name in bold. */
const TABLE_BULLET = /^-\s+\*\*([^*]+)\*\*/;
/**
 * A documented column is a backticked name immediately followed by its SQL type,
 * which is how every bullet writes one. Demanding the type is what keeps index
 * names, string defaults, `versions` keys and `table.column` cross-references
 * out.
 */
const DOC_COLUMN =
  /`([a-z0-9_]+)`\s+(?:BIGINT|INT|SMALLINT|TINYINT|DOUBLE|VARCHAR|VARBINARY|CHAR|TEXT|LONGTEXT|MEDIUMTEXT|JSON|DATETIME|TIMESTAMP|BLOB)\b/g;

/** The column names each table's bullet declares, in the order it writes them. */
const documentedColumns = (tables: Iterable<string>): Map<string, string[]> => {
  const names = new Set(tables);
  const bullets = new Map<string, string[]>();

  let current: string[] | undefined;
  for (const line of readFileSync(DOC, 'utf8').split('\n')) {
    const heading = TABLE_BULLET.exec(line);
    if (heading) {
      // A bullet that qualifies one table (`**hosts.browseros_mcp_enabled**`,
      // `**auth_payloads canonical resolution**`) carries the same marker, so
      // only a bold span that is exactly a table name opens that table's list.
      current = names.has(heading[1]!) ? [] : undefined;
      if (current) bullets.set(heading[1]!, current);
    } else if (!/^\s+\S/.test(line)) {
      current = undefined; // Prose between bullets, not a wrapped bullet line.
    }
    if (current) current.push(...[...line.matchAll(DOC_COLUMN)].map((column) => column[1]!));
  }

  for (const table of names) {
    const bullet = bullets.get(table);
    // Every mirrored table is documented (`docs-table-coverage`) and every
    // bullet writes its columns with types, so either gap is a broken read.
    if (!bullet) throw new Error(`no bullet read out of docs/interface-db.md for table ${table}`);
    if (bullet.length === 0) throw new Error(`no columns read out of the ${table} bullet`);
  }
  return bullets;
};

describe('docs/interface-db.md column catalog', () => {
  it('resolves every documented column against the schema it derives from', () => {
    const schema = schemaColumns();
    const documented = documentedColumns(schema.keys());
    const drift: string[] = [];

    for (const [table, columns] of schema) {
      const bullet = documented.get(table)!;
      for (const column of columns) {
        if (!bullet.includes(column) && !ALLOWED.has(`${table}.${column}`)) {
          drift.push(`undocumented: ${table}.${column}`);
        }
      }
      for (const column of bullet) {
        if (!columns.includes(column) && !ALLOWED.has(`${table}.${column}`)) {
          drift.push(`not in schema.ts: ${table}.${column}`);
        }
      }
    }

    // Each entry is column drift in the file the repo calls the database source
    // of truth: write the new column into its bullet in the style of its
    // neighbours, or drop the one the mirror no longer declares.
    expect(drift).toEqual([]);
  });

  // Pins both extractions, so a regex that quietly stops matching cannot turn
  // the check above into a comparison of two empty lists.
  it('reads the columns out of both files', () => {
    const schema = schemaColumns();
    expect(schema.get('versions')).toEqual(['name', 'version', 'updated_at']); // The one-line table.
    expect(schema.get('hosts')).toContain('wrapper_canary');
    // Index names live in the second argument, outside the column object.
    expect(schema.get('hosts')).not.toContain('idx_hosts_updated_at');

    const documented = documentedColumns(schema.keys());
    expect(documented.get('versions')).toEqual(['name', 'version', 'updated_at']);
    expect(documented.get('hosts')).toContain('wrapper_canary');
    // A `versions` key, an index name and another table's column carry no type
    // here, so none of them is read as a column of the bullet that names it.
    expect(documented.get('versions')).not.toContain('client_available');
    expect(documented.get('logs')).not.toContain('idx_logs_host');
    expect(documented.get('shared_memory_chunks')).toContain('char_start');
    expect(documented.get('shared_memory_chunks')).not.toContain('content_length');
    // The qualifying bullets are not their table's bullet.
    expect(documented.has('hosts.browseros_mcp_enabled')).toBe(false);
    expect(documented.has('auth_payloads canonical resolution')).toBe(false);
  });

  it('throws rather than compare an empty set when a bullet cannot be read', () => {
    // A table with no bullet is the shape a renamed table leaves behind.
    expect(() => documentedColumns(['hosts', 'no_such_table'])).toThrow(/no_such_table/);
  });
});
