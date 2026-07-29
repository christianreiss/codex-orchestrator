import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * `docs-table-columns` pins the columns each bullet declares with a type, and
 * says what that leaves out: "Demanding the type is what keeps index names,
 * string defaults, `versions` keys and `table.column` cross-references out". A
 * column renamed or dropped in a migration therefore still leaves the doc
 * asserting something false everywhere else it names it — the index and
 * unique-key column lists, the FK targets, and the prose explaining what the
 * column is for — and with `npm run test:db` needing a real database, no live
 * schema contradicts it either.
 *
 * This is the liveness half: every column name a bullet cites *outside* its
 * typed DDL list has to be one the mirror still declares. It is a one-way check
 * — a column the doc never mentions is `docs-table-columns`' business, and
 * types, defaults and index names are nobody's.
 */

const SCHEMA = resolve(import.meta.dirname, '../../../src/db/schema.ts');
const DOC = resolve(import.meta.dirname, '../../../../docs/interface-db.md');

/**
 * Backticked identifiers a bullet names that are not columns of its table, as
 * `table.token`. Every entry carries the reason; the answer to a failure below
 * is normally to fix the doc, not to list the name here.
 */
const NOT_A_COLUMN = new Set<string>([
  'auth_canonical_heads.auth_generation_ledger_v1', // A `versions` marker key.
  'coord_project_memories.deleted_at', // Names the column this table deliberately lacks.
  'coord_project_memories.utf8mb4_unicode_ci', // A MySQL collation.
  'shared_memories.utf8mb4_unicode_ci', // A MySQL collation.
  'shared_memory_revisions.shared_memory_search', // The search API, not a column.
  'wrapper_signing_keys.wrapper_v2_unavailable', // An API error code.
]);

/** Matches both the wrapped call and the one-line `mysqlTable('versions', {`. */
const MYSQL_TABLE = /mysqlTable\(\s*'([^']+)'\s*,\s*\{/g;
/**
 * A column is a property whose value is a drizzle type call, and the SQL name is
 * that call's first argument — `apiKey: char('api_key', { length: 64 })`. Same
 * extraction as `docs-table-columns`.
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

const schemaColumns = (): Map<string, Set<string>> => {
  const source = readFileSync(SCHEMA, 'utf8');
  const tables = new Map<string, Set<string>>();
  for (const table of source.matchAll(MYSQL_TABLE)) {
    // The `{` the match ends on opens the column object; the index config that
    // may follow it is a separate argument and stays out of the slice.
    const body = objectLiteral(source, table.index + table[0].length - 1);
    tables.set(table[1]!, new Set([...body.matchAll(COLUMN)].map((column) => column[1]!)));
  }
  return tables;
};

/** The doc opens each table's bullet with its name in bold. */
const TABLE_BULLET = /^-\s+\*\*([^*]+)\*\*/;
/**
 * Index, unique-key and composite-primary-key column lists: the doc writes every
 * one of them as `… on (`host_id`, `engine`)`.
 */
const INDEXED_COLUMNS = /\bon \(\s*((?:`[a-z0-9_]+`(?:,\s*)?)+)\)/g;
/** A cross-table reference — an FK target (`hosts.id`) or a prose citation. */
const QUALIFIED_REF = /`([a-z][a-z0-9_]*)\.([a-z][a-z0-9_]*)`/g;
/**
 * A bare backticked snake_case identifier, which is how the prose cites a column
 * of the bullet's own table. The underscore is what keeps the string defaults and
 * enum members out — `active`, `codex`, `pending`, `bearer`, `latest`/`locked` —
 * since the doc writes those the same way. Single-word column names lose nothing
 * by it: their typed declaration is already pinned by `docs-table-columns`.
 */
const BARE_REF = /`([a-z][a-z0-9]*(?:_[a-z0-9]+)+)`/g;
/** Index and key names, which name no column even when they are built from one. */
const INDEX_NAME = /^(?:idx|uniq|uq|unique)_/;

/**
 * Every column name the doc cites, as table → columns. Bullets contribute the
 * column lists and prose of their own table; a `table.column` reference is
 * credited to the table it names, wherever it appears.
 */
const referencedColumns = (tables: Set<string>): Map<string, Set<string>> => {
  const refs = new Map<string, Set<string>>();
  const cite = (table: string, column: string): void => {
    const columns = refs.get(table) ?? new Set<string>();
    refs.set(table, columns.add(column));
  };

  let bullet: { table: string | undefined; lines: string[] } | undefined;
  const bullets: { table: string | undefined; lines: string[] }[] = [];
  for (const line of readFileSync(DOC, 'utf8').split('\n')) {
    const heading = TABLE_BULLET.exec(line);
    if (heading) {
      // A bullet that qualifies one table (`**hosts.browseros_mcp_enabled**`)
      // carries the same marker but is not that table's bullet, so it
      // contributes its `table.column` references and nothing else.
      bullet = { table: tables.has(heading[1]!) ? heading[1]! : undefined, lines: [] };
      bullets.push(bullet);
    } else if (!/^\s+\S/.test(line)) {
      bullet = undefined; // Prose between bullets, not a wrapped bullet line.
    }
    bullet?.lines.push(line);
  }

  for (const { table, lines } of bullets) {
    const text = lines.join(' ');
    for (const ref of text.matchAll(QUALIFIED_REF)) {
      if (tables.has(ref[1]!)) cite(ref[1]!, ref[2]!);
    }
    if (!table) continue;
    for (const list of text.matchAll(INDEXED_COLUMNS)) {
      for (const column of list[1]!.matchAll(/`([a-z0-9_]+)`/g)) cite(table, column[1]!);
    }
    // `versions` is a key/value store and its bullet enumerates the keys its
    // rows hold, not columns; the three it has are typed, so pinned already.
    if (table === 'versions') continue;
    for (const ref of text.matchAll(BARE_REF)) {
      // A table name in prose cites a table, and an index name cites an index.
      if (!tables.has(ref[1]!) && !INDEX_NAME.test(ref[1]!)) cite(table, ref[1]!);
    }
  }
  return refs;
};

describe('docs/interface-db.md column liveness', () => {
  it('cites no column schema.ts no longer declares', () => {
    const schema = schemaColumns();
    const stale: string[] = [];

    for (const [table, columns] of referencedColumns(new Set(schema.keys()))) {
      for (const column of columns) {
        const cited = `${table}.${column}`;
        if (!schema.get(table)!.has(column) && !NOT_A_COLUMN.has(cited)) stale.push(cited);
      }
    }

    // Each entry is a column name the doc still cites — in an index list, an FK
    // target or its prose — that the mirror dropped or renamed: update the doc.
    expect(stale).toEqual([]);
  });

  // Pins the extraction itself, so a regex that quietly stops matching cannot
  // turn the check above into a comparison of two empty lists.
  it('reads a column out of every kind of citation the doc makes', () => {
    const schema = schemaColumns();
    const refs = referencedColumns(new Set(schema.keys()));

    // An index list, an FK target from another table's bullet, and prose.
    expect(refs.get('coord_project_memories')).toContain('memory_key');
    expect(refs.get('hosts')).toContain('id');
    expect(refs.get('auth_seed_tokens')).toContain('used_at');
    // The qualifying sub-bullet is read for its table, not for its own name.
    expect(refs.get('hosts')).toContain('config_version');
    expect(refs.size).toBeGreaterThan(schema.size / 2);

    // Index names, `versions` keys and table names are not columns.
    expect(refs.get('logs')).not.toContain('idx_logs_host');
    expect(refs.get('versions') ?? new Set()).not.toContain('client_available');
    expect(refs.get('mcp_memories')).not.toContain('coord_project_memories');
  });
});
