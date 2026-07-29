import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { is } from 'drizzle-orm';
import { getTableConfig, MySqlTable } from 'drizzle-orm/mysql-core';
import * as schema from '../../../src/db/schema.js';

/**
 * `boot-checks.ts` probes the tables Claude bootstrap and auth retention need
 * before the listener opens, and it names them as raw SQL text: TypeScript
 * cannot see inside a `sql` template, and `boot-checks.test.ts` only compares
 * the rendered SQL against the same literals it already contains. So renaming
 * `claude_artifacts` or `auth_payloads.purge_after` in `schema.ts` plus its
 * migration keeps typecheck and the unit suite green while the server dies at
 * startup — in the probe written to prevent exactly that.
 *
 * This reads the identifiers back out of the source and resolves each against
 * `getTableConfig`, so the comparison is against the DB-side names Drizzle
 * emits rather than the TypeScript property names.
 */

const BOOT_CHECKS = resolve(import.meta.dirname, '../../../src/ops/boot-checks.ts');

/** Every `sql`…`` template in the file; none of them contain a backtick. */
const SQL_TEMPLATE = /\bsql`([^`]*)`/g;

/** `SELECT 1 FROM t`, `SELECT a, b FROM t`. */
const SELECT = /^SELECT (.+?) FROM ([A-Za-z_][A-Za-z0-9_]*)/i;
/** `INSERT INTO t (a, b, c)`. */
const INSERT = /^INSERT INTO ([A-Za-z_][A-Za-z0-9_]*) \(([^)]*)\)/i;
/** The upsert's `version = VALUES(version)` assignments name columns too. */
const ON_DUPLICATE = /ON DUPLICATE KEY UPDATE (.+)$/i;
const ASSIGNED = /([A-Za-z_][A-Za-z0-9_]*) *=/g;
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

interface Reference {
  table: string;
  columns: string[];
}

/** Bound parameters collapse to `?` and the upsert's line breaks to spaces. */
function statements(): string[] {
  return [...readFileSync(BOOT_CHECKS, 'utf8').matchAll(SQL_TEMPLATE)].map((template) =>
    template[1]!
      .replace(/\$\{[^}]*\}/g, '?')
      .replace(/\s+/g, ' ')
      .trim(),
  );
}

function reference(statement: string): Reference | null {
  const insert = INSERT.exec(statement);
  if (insert) {
    const listed = insert[2]!.split(',').map((column) => column.trim());
    const update = ON_DUPLICATE.exec(statement);
    const assigned = update ? [...update[1]!.matchAll(ASSIGNED)].map((match) => match[1]!) : [];
    return { table: insert[1]!, columns: [...new Set([...listed, ...assigned])] };
  }

  const select = SELECT.exec(statement);
  if (!select) return null;
  // `SELECT 1 FROM t` probes the table's existence; the literal is no column.
  const columns = select[1]!
    .split(',')
    .map((column) => column.trim())
    .filter((column) => IDENTIFIER.test(column));
  return { table: select[2]!, columns };
}

const references = (): Reference[] =>
  statements()
    .map(reference)
    .filter((entry): entry is Reference => entry !== null);

/** Table name as MySQL sees it → its column names, likewise DB-side. */
function schemaTables(): Map<string, Set<string>> {
  const tables = new Map<string, Set<string>>();
  for (const exported of Object.values(schema)) {
    if (!is(exported, MySqlTable)) continue;
    const config = getTableConfig(exported);
    tables.set(config.name, new Set(config.columns.map((column) => column.name)));
  }
  return tables;
}

describe('boot-check SQL identifiers', () => {
  // Pins the extraction, so a regex that quietly stops matching cannot turn the
  // resolution below into a walk over an empty list. A new probe belongs here.
  it('reads the identifiers boot-checks.ts hard-codes', () => {
    const all = statements();
    expect(all).toHaveLength(5);
    // The generic `SELECT 1` names nothing, and must not fake a table.
    expect(all).toContain('SELECT 1');
    expect(reference('SELECT 1')).toBeNull();

    expect(references()).toEqual([
      { table: 'claude_artifacts', columns: [] },
      { table: 'auth_payloads', columns: ['generation', 'superseded_at', 'purge_after'] },
      { table: 'auth_canonical_heads', columns: [] },
      { table: 'versions', columns: ['name', 'version', 'updated_at'] },
    ]);
  });

  // Likewise for the schema side: an empty catalog would resolve nothing.
  it('reads DB-side names out of schema.ts, not TypeScript properties', () => {
    const tables = schemaTables();
    expect(tables.size).toBeGreaterThan(20);

    const authPayloads = tables.get('auth_payloads');
    expect(authPayloads).toBeDefined();
    expect(authPayloads!.has('superseded_at')).toBe(true);
    expect(authPayloads!.has('supersededAt')).toBe(false); // The property name.
  });

  it('resolves every probed table and column against schema.ts', () => {
    const tables = schemaTables();
    const missing: string[] = [];
    for (const { table, columns } of references()) {
      const known = tables.get(table);
      if (!known) {
        missing.push(`table ${table}`);
        continue;
      }
      missing.push(...columns.filter((column) => !known.has(column)).map((c) => `${table}.${c}`));
    }

    // Each entry is an identifier the boot probe would hit a missing table or
    // column on: schema.ts was renamed without src/ops/boot-checks.ts.
    expect(missing).toEqual([]);
  });
});
