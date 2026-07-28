import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * `docs-table-coverage` pins the doc's table names and says so — "Columns, types
 * and indexes are not compared" — so a column could reach the mirror without
 * ever being written up, and six `hosts` columns had: `auto_update_override`,
 * `last_cron_check`, `scaling_exempt`, `config_version`, `config_baked_at` and
 * `wrapper_track`, the fourth of which the neighbouring
 * `hosts.browseros_mcp_enabled` bullet already referred to as if it were
 * documented.
 *
 * This is the column half of that check: every column `schema.ts` declares needs
 * a backticked mention in its table's bullet, and every column a bullet names
 * has to exist in the mirror. Types, defaults and indexes are still not
 * compared.
 */

const SCHEMA = resolve(import.meta.dirname, '../../../src/db/schema.ts');
const DOC = resolve(import.meta.dirname, '../../../../docs/interface-db.md');

/**
 * Columns the mirror declares and the doc deliberately leaves out, as
 * `table.column`. Every entry carries the reason; the answer to a failure below
 * is normally to document the column, not to list it here.
 */
const UNDOCUMENTED = new Set<string>([
  // Empty on purpose: docs/interface-db.md names every column in the mirror.
]);

/** Matches both the wrapped call and the one-line `mysqlTable('versions', {`. */
const MYSQL_TABLE = /mysqlTable\(\s*'([^']+)'\s*,\s*\{/g;
/**
 * A column is a property whose value is a drizzle type call, and the SQL name is
 * that call's first argument — `apiKey: char('api_key', { length: 64 })`. Same
 * extraction as `schema-baseline-drift`.
 */
const COLUMN = /[A-Za-z0-9_$]+\s*:\s*[a-z][A-Za-z0-9_]*\(\s*'([^']+)'/g;

/**
 * The column object ends at the brace matching `open`: its nested option objects
 * are balanced and no string literal in the mirror carries a brace.
 */
const objectLiteral = (source: string, open: number): string => {
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}' && (depth -= 1) === 0) return source.slice(open + 1, i);
  }
  throw new Error(`unbalanced braces in schema.ts at offset ${open}`);
};

const schemaColumns = (): Map<string, string[]> => {
  const source = readFileSync(SCHEMA, 'utf8');
  const tables = new Map<string, string[]>();
  for (const table of source.matchAll(MYSQL_TABLE)) {
    // The `{` the match ends on opens the column object; the index config that
    // may follow it is a separate argument and stays out of the slice.
    const body = objectLiteral(source, table.index + table[0].length - 1);
    tables.set(table[1]!, [...body.matchAll(COLUMN)].map((column) => column[1]!));
  }
  return tables;
};

/** The doc opens each table's bullet with its name in bold. */
const TABLE_BULLET = /^-\s+\*\*([^*]+)\*\*/;
/**
 * A documented column is a backticked name followed by its SQL type, which is
 * how every bullet writes one. Demanding the type is what keeps index names,
 * string defaults, `versions` keys and `table.column` cross-references out.
 */
const DOC_COLUMN =
  /`([a-z0-9_]+)`\s+(?:BIGINT|VARCHAR|LONGTEXT|TINYINT|DATETIME|VARBINARY|CHAR|TEXT|JSON|BLOB|INT)\b/g;

const documentedColumns = (): Map<string, string[]> => {
  const bullets = new Map<string, string[]>();
  let current: string[] | undefined;
  for (const line of readFileSync(DOC, 'utf8').split('\n')) {
    const bullet = TABLE_BULLET.exec(line);
    if (bullet) {
      // A bullet that qualifies one table (`**hosts.browseros_mcp_enabled**`,
      // `**auth_payloads canonical resolution**`) carries the same marker, so it
      // gets its own entry under its own name and never joins the table's list.
      current = [];
      bullets.set(bullet[1]!, current);
    } else if (!/^\s+\S/.test(line)) {
      current = undefined; // Prose between bullets, not a wrapped bullet line.
    }
    if (current) current.push(...[...line.matchAll(DOC_COLUMN)].map((column) => column[1]!));
  }
  return bullets;
};

describe('docs/interface-db.md column lists', () => {
  it('names every column schema.ts declares, and none it does not', () => {
    const documented = documentedColumns();
    const drift: string[] = [];

    for (const [table, columns] of schemaColumns()) {
      const bullet = documented.get(table) ?? [];
      for (const column of columns) {
        if (!bullet.includes(column) && !UNDOCUMENTED.has(`${table}.${column}`)) {
          drift.push(`undocumented: ${table}.${column}`);
        }
      }
      for (const column of bullet) {
        if (!columns.includes(column)) drift.push(`not in schema.ts: ${table}.${column}`);
      }
    }

    // Each entry is column drift: write the new column into its bullet in the
    // style of its neighbours, or drop the one the mirror no longer declares.
    expect(drift).toEqual([]);
  });

  // Pins both extractions, so a regex that quietly stops matching cannot turn
  // the check above into a comparison of two empty lists.
  it('reads the columns out of both files', () => {
    const schema = schemaColumns();
    expect(schema.get('versions')).toEqual(['name', 'version', 'updated_at']); // The one-line table.
    expect(schema.get('hosts')).toContain('wrapper_track');
    // Index names live in the second argument, outside the column object.
    expect(schema.get('hosts')).not.toContain('idx_hosts_updated_at');

    const documented = documentedColumns();
    expect(documented.get('versions')).toEqual(['name', 'version', 'updated_at']);
    // That same bullet backticks every key the code stores under `versions`.
    expect(documented.get('versions')).not.toContain('client_available');
    expect(documented.get('hosts')).toContain('wrapper_track');
    expect(documented.get('logs')).not.toContain('idx_logs_host');
    // The qualifying bullets are read as themselves, not as their table.
    expect(documented.get('hosts.browseros_mcp_enabled')).toEqual([]);
    expect(documented.get('auth_payloads canonical resolution')).toEqual([]);
  });
});
