import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * `docs/interface-db.md` calls itself the database source of truth and derives
 * its column lists from `src/db/schema.ts`. `schema-baseline-drift` and
 * `migration-schema-drift` pin the mirror against the SQL, but nothing pinned
 * the documented catalog, so `cli_auth_requests`, `openai_api_keys`,
 * `wrapper_signing_keys`, `wrapper_v2_binaries` and
 * `dashboard_graph_claude_quota_snapshots` all reached the mirror without ever
 * being written up.
 *
 * This is table coverage only — a name in the mirror needs a `**<name>**`
 * bullet in the doc. Columns, types and indexes are not compared.
 */

const SCHEMA = resolve(import.meta.dirname, '../../../src/db/schema.ts');
const DOC = resolve(import.meta.dirname, '../../../../docs/interface-db.md');

/** Matches both the wrapped call and the one-line `mysqlTable('versions', {`. */
const MYSQL_TABLE = /mysqlTable\(\s*'([^']+)'\s*,\s*\{/g;

const schemaTables = (): string[] =>
  [...readFileSync(SCHEMA, 'utf8').matchAll(MYSQL_TABLE)].map((table) => table[1]!);

/**
 * The doc opens each table's bullet with its name in bold. Sub-bullets that
 * qualify one table (`**hosts.browseros_mcp_enabled**`) carry the same marker,
 * so the whole bold span has to be the bare table name.
 */
const documentedTables = (): Set<string> =>
  new Set([...readFileSync(DOC, 'utf8').matchAll(/^-\s+\*\*([^*]+)\*\*/gm)].map((b) => b[1]!));

describe('docs/interface-db.md table catalog', () => {
  it('documents every table schema.ts declares', () => {
    const documented = documentedTables();
    const missing = schemaTables().filter((table) => !documented.has(table));

    // Each entry is a table that reached the mirror undocumented: add its
    // bullet to docs/interface-db.md in the style of its neighbours.
    expect(missing).toEqual([]);
  });

  // Pins the extraction itself, so a regex that quietly stops matching cannot
  // turn the check above into a comparison of two empty lists.
  it('reads the table names out of both files', () => {
    const tables = schemaTables();
    expect(tables).toContain('hosts');
    expect(tables).toContain('versions'); // The one-line declaration.
    expect(tables).toContain('schema_migrations');

    const documented = documentedTables();
    expect(documented.size).toBeGreaterThan(tables.length / 2);
    expect(documented.has('hosts')).toBe(true);
    // A qualifying sub-bullet is not a table bullet.
    expect(documented.has('hosts.browseros_mcp_enabled')).toBe(true);
    expect(documented.has('auth_payloads canonical resolution')).toBe(true);
  });
});
