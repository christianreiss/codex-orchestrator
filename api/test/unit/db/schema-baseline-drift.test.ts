import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { currentSchemaColumns } from '../../fixtures/current-schema-columns.js';

/** The shipped bootstrap snapshot is followed by migrations for fresh installs
 * and DB suites. Compare schema.ts to that complete projection while preserving
 * the frozen bootstrap artifact. The sibling migration check independently
 * verifies each shipped addition against the actual Drizzle mirror.
 * Types/defaults/indexes are covered by the real-MySQL migration tests. */

const SCHEMA = resolve(import.meta.dirname, '../../../src/db/schema.ts');

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
    tables.set(
      table[1]!,
      [...body.matchAll(COLUMN)].map((column) => column[1]!),
    );
  }
  return tables;
};

describe('schema.ts against the test baseline', () => {
  it('declares no table or column absent from bootstrap plus migration 0105', () => {
    const baseline = currentSchemaColumns();
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

    // Each entry lacks both the bootstrap column and its explicit migration.
    // Keep the shipped bootstrap snapshot unchanged for this additive change.
    expect(missing).toEqual([]);
  });

  // Pins the extraction itself, so a regex that quietly stops matching cannot
  // turn the check above into a comparison of two empty lists.
  it('reads every table in schema.ts, columns and all', () => {
    const tables = schemaTables();

    // Bump this with the table you added, in the same commit.
    expect(tables.size).toBe(135);
    expect([...tables].filter(([, columns]) => columns.length === 0)).toEqual([]);
    expect(tables.get('auth_canonical_heads')).toEqual(['engine', 'payload_id', 'generation', 'updated_at']);
  });
});
