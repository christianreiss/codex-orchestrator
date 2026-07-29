import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { splitSqlStatements } from '../../../src/db/migration-sql.js';

/**
 * `test/fixtures/schema-baseline.sql` is generated from `src/db/schema.ts` (see
 * the fixture header) and is what `npm run test:db:setup` provisions the
 * DB-backed suites from. Nothing enforced the pairing: `migration-schema-drift`
 * checks the shipped migrations against the baseline, but a table or column that
 * reaches the mirror without a regenerated fixture stays invisible locally —
 * `npm run test:db` needs a real database — and only surfaces as a confusing
 * runtime error in the GitHub `db` job.
 *
 * This is the `schema.ts` half of that check — table and column additions only,
 * read out of the two files as text. Types, defaults, indexes and constraints
 * are not compared; the baseline cannot express FULLTEXT or foreign keys anyway.
 */

const SCHEMA = resolve(import.meta.dirname, '../../../src/db/schema.ts');
const BASELINE = resolve(import.meta.dirname, '../../fixtures/schema-baseline.sql');

/** Matches both the wrapped call and the one-line `mysqlTable('versions', {`. */
const MYSQL_TABLE = /mysqlTable\(\s*'([^']+)'\s*,\s*\{/g;
/**
 * A column is a property whose value is a drizzle type call, and the SQL name is
 * that call's first argument — `apiKey: char('api_key', { length: 64 })`. The
 * option objects in the same body (`{ mode: 'number' }`) hold no such call, so
 * they contribute nothing.
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

const schemaTables = (): Map<string, string[]> => {
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

describe('schema.ts against the test baseline', () => {
  it('declares no table or column that schema-baseline.sql lacks', () => {
    const baseline = baselineTables();
    const missing: string[] = [];

    for (const [table, columns] of schemaTables()) {
      const baselineColumns = baseline.get(table);
      if (!baselineColumns) {
        missing.push(table);
        continue;
      }
      for (const column of columns) {
        if (!baselineColumns.has(column)) missing.push(`${table}.${column}`);
      }
    }

    // Each entry is a mirror change that never reached the fixture: regenerate
    // it with the drizzle-kit pipeline in the fixture's header.
    expect(missing).toEqual([]);
  });

  // Pins the extraction itself, so a regex that quietly stops matching cannot
  // turn the check above into a comparison of two empty lists.
  it('reads every table in schema.ts, columns and all', () => {
    const tables = schemaTables();

    // Bump this with the table you added, in the same commit.
    expect(tables.size).toBe(54);
    expect([...tables].filter(([, columns]) => columns.length === 0)).toEqual([]);
    expect(tables.get('auth_canonical_heads')).toEqual([
      'engine',
      'payload_id',
      'generation',
      'updated_at',
    ]);
  });
});
