import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { splitSqlStatements } from '../../../src/db/migration-sql.js';
import { loadMigrations } from '../../../src/db/migrator.js';

/**
 * AGENTS.md requires a migration to land with the matching `schema.ts` update in
 * the same commit, and `test/fixtures/schema-baseline.sql` is generated from
 * `schema.ts` and provisions the DB-backed suites. Nothing enforced the pairing:
 * the double-apply test in `test/integration/db-migrations/` needs a real
 * database, so a migration shipped without the schema update would leave
 * production ahead of both the mirror and the baseline with every gate green.
 *
 * This is the static half of that check — table and column additions only, read
 * out of the shipped SQL and looked up in the baseline. Types, defaults, indexes
 * and constraints are not compared; the baseline cannot express FULLTEXT or
 * foreign keys anyway (see the header of the fixture).
 */

const BASELINE = resolve(import.meta.dirname, '../../fixtures/schema-baseline.sql');

/** Anchored: a `CREATE TABLE` quoted inside a CALL argument is not a creation. */
const CREATE_TABLE = /^CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?`?([A-Za-z0-9_$]+)`?/i;
/** Unanchored: 0005 hides its ALTERs inside `CALL add_auth_generation_column(…)`. */
const ADD_COLUMN = /ALTER\s+TABLE\s+`?([A-Za-z0-9_$]+)`?\s+ADD\s+COLUMN\s+`?([A-Za-z0-9_$]+)`?/gi;

interface Addition {
  migration: string;
  table: string;
  column?: string;
}

/**
 * Statements come from the production splitter, so comments are already gone —
 * the prose in 0003/0006 that quotes `CREATE TABLE IF NOT EXISTS` cannot be
 * mistaken for a real one.
 */
const migrationAdditions = async (): Promise<Addition[]> => {
  const additions: Addition[] = [];
  for (const file of await loadMigrations()) {
    for (const statement of file.statements) {
      const created = CREATE_TABLE.exec(statement);
      if (created) {
        additions.push({ migration: file.filename, table: created[1]! });
      }
      for (const [, table, column] of statement.matchAll(ADD_COLUMN)) {
        additions.push({ migration: file.filename, table: table!, column: column! });
      }
    }
  }
  return additions;
};

const baselineTables = (): Map<string, Set<string>> => {
  const tables = new Map<string, Set<string>>();
  for (const statement of splitSqlStatements(readFileSync(BASELINE, 'utf8'))) {
    const table = /^CREATE\s+TABLE\s+`([^`]+)`/i.exec(statement);
    if (!table) continue; // The trailing `CREATE INDEX` run.
    const columns = new Set<string>();
    for (const line of statement.split('\n')) {
      // A column definition is a backticked name followed by its type; the
      // `CONSTRAINT …` lines in the same body start with a bare keyword.
      const column = /^\s*`([^`]+)`\s+\S/.exec(line);
      if (column) columns.add(column[1]!);
    }
    tables.set(table[1]!, columns);
  }
  return tables;
};

describe('migrations against the test baseline', () => {
  it('adds no table or column that schema-baseline.sql lacks', async () => {
    const baseline = baselineTables();
    const missing: string[] = [];

    for (const { migration, table, column } of await migrationAdditions()) {
      const columns = baseline.get(table);
      if (column === undefined) {
        if (!columns) missing.push(`${migration}:${table}`);
        continue;
      }
      if (!columns?.has(column)) missing.push(`${migration}:${table}.${column}`);
    }

    // Each entry is a schema change that reached `migrations/` without reaching
    // `schema.ts`: update the mirror and regenerate the fixture.
    expect(missing).toEqual([]);
  });

  // Pins the extraction itself, so a regex that quietly stops matching cannot
  // turn the check above into a test of an empty list.
  it('reads the tables and columns the shipped migrations actually add', async () => {
    const additions = await migrationAdditions();

    expect(additions.filter((a) => a.column === undefined).map((a) => a.table)).toEqual([
      'coord_project_memories',
      'claude_artifacts',
      'auth_canonical_heads',
      'shared_memories',
      'shared_memory_chunks',
      'shared_memory_revisions',
    ]);
    expect(
      additions.filter((a) => a.column !== undefined).map((a) => `${a.table}.${a.column}`),
    ).toEqual([
      'auth_payloads.generation',
      'auth_payloads.source_kind',
      'auth_payloads.parent_payload_id',
      'auth_payloads.credential_kind',
      'auth_payloads.fingerprint_kid',
      'auth_payloads.access_fingerprint',
      'auth_payloads.refresh_fingerprint',
      'auth_payloads.pair_fingerprint',
      'auth_payloads.credential_issued_at',
      'auth_payloads.access_expires_at',
      'auth_payloads.refresh_expires_at',
      'auth_payloads.superseded_at',
      'auth_payloads.purge_after',
    ]);
  });

  it('reads whole tables out of the baseline, columns and all', () => {
    const baseline = baselineTables();
    expect(baseline.get('auth_canonical_heads')).toEqual(
      new Set(['engine', 'payload_id', 'generation', 'updated_at']),
    );
    expect(baseline.get('schema_migrations')?.has('checksum')).toBe(true);
  });
});
