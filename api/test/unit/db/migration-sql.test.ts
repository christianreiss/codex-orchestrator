import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { splitSqlStatements } from '../../../src/db/migration-sql.js';

/**
 * The splitter is the part of the runner that can corrupt a migration silently:
 * a wrong cut produces a syntactically valid prefix that MySQL happily executes.
 * Every case here is drawn from something the real files under
 * `src/db/migrations/` actually do.
 */
describe('splitSqlStatements', () => {
  it('splits on semicolons and drops the terminator', () => {
    expect(splitSqlStatements('SELECT 1; SELECT 2;')).toEqual(['SELECT 1', 'SELECT 2']);
  });

  it('keeps a trailing statement that has no terminator', () => {
    expect(splitSqlStatements('SELECT 1;\nSELECT 2')).toEqual(['SELECT 1', 'SELECT 2']);
  });

  it('ignores empty statements from stray terminators and blank lines', () => {
    expect(splitSqlStatements(';;\n\nSELECT 1;;\n')).toEqual(['SELECT 1']);
  });

  it('strips line comments without gluing the tokens around them', () => {
    const statements = splitSqlStatements('SELECT 1 -- trailing note\nFROM t;\n# whole line\nSELECT 2;');
    expect(statements).toEqual(['SELECT 1 \nFROM t', 'SELECT 2']);
  });

  it('keeps a semicolon that lives inside a comment out of the split', () => {
    expect(splitSqlStatements('-- one; two; three\nSELECT 1;')).toEqual(['SELECT 1']);
    expect(splitSqlStatements('/* one; two */ SELECT 1;')).toEqual(['SELECT 1']);
  });

  it('treats -- as a comment only when whitespace follows it', () => {
    expect(splitSqlStatements('SELECT 1--2;')).toEqual(['SELECT 1--2']);
  });

  it('forwards MySQL executable comments to the server', () => {
    expect(splitSqlStatements('/*!40101 SET NAMES utf8 */;')).toEqual(['/*!40101 SET NAMES utf8 */']);
  });

  it('does not split inside quoted literals or identifiers', () => {
    expect(splitSqlStatements(`INSERT INTO t VALUES ('a;b', "c;d", 1);`)).toEqual([
      `INSERT INTO t VALUES ('a;b', "c;d", 1)`,
    ]);
    expect(splitSqlStatements('SELECT `we;ird` FROM t;')).toEqual(['SELECT `we;ird` FROM t']);
  });

  it('handles doubled and backslash-escaped quotes', () => {
    // The `''legacy''` form from 0005_add_auth_generation_ledger.sql.
    const doubled = `CALL p('ALTER TABLE t ADD COLUMN c VARCHAR(32) NOT NULL DEFAULT ''legacy''');`;
    expect(splitSqlStatements(doubled)).toEqual([doubled.slice(0, -1)]);
    expect(splitSqlStatements("SELECT 'a\\';b';")).toEqual(["SELECT 'a\\';b'"]);
  });

  it('leaves a comment marker inside a string alone', () => {
    expect(splitSqlStatements(`SELECT '-- not a comment; really';`)).toEqual([
      `SELECT '-- not a comment; really'`,
    ]);
  });

  it('honours DELIMITER and never forwards the directive itself', () => {
    const text = [
      'DELIMITER //',
      'CREATE PROCEDURE p()',
      'BEGIN',
      '  SET @a = 1;',
      '  SET @b = 2;',
      'END//',
      'DELIMITER ;',
      'CALL p();',
    ].join('\n');

    const statements = splitSqlStatements(text);
    expect(statements).toHaveLength(2);
    expect(statements[0]).toContain('SET @a = 1;');
    expect(statements[0]).toContain('SET @b = 2;');
    expect(statements[0]!.endsWith('END')).toBe(true);
    expect(statements[0]).not.toMatch(/DELIMITER/i);
    expect(statements[1]).toBe('CALL p()');
  });

  it('runs the real 0005 procedure definitions out as whole statements', () => {
    const file = readFileSync(
      resolve(import.meta.dirname, '../../../src/db/migrations/0005_add_auth_generation_ledger.sql'),
      'utf8',
    );
    const statements = splitSqlStatements(file);

    const procedures = statements.filter((statement) => statement.startsWith('CREATE PROCEDURE'));
    expect(procedures).toHaveLength(2);
    for (const procedure of procedures) {
      expect(procedure).toContain('DEALLOCATE PREPARE auth_generation_stmt');
      expect(procedure.trimEnd().endsWith('END')).toBe(true);
    }
    expect(statements.some((statement) => /^DELIMITER/i.test(statement))).toBe(false);
    expect(statements.filter((statement) => statement.startsWith('CALL '))).toHaveLength(16);
  });

  it('keeps the prepared-statement guards in 0006 intact', () => {
    const file = readFileSync(
      resolve(import.meta.dirname, '../../../src/db/migrations/0006_add_shared_memories.sql'),
      'utf8',
    );
    const statements = splitSqlStatements(file);

    // Three CREATE TABLE, four guard triplets (SET/SET/PREPARE/EXECUTE/DEALLOCATE)
    // and two orphan sweeps — the exact shape matters less than each guard
    // surviving as its own statement with its variable assignment intact.
    expect(statements.filter((s) => s.startsWith('CREATE TABLE IF NOT EXISTS'))).toHaveLength(3);
    expect(statements.filter((s) => s.startsWith('PREPARE '))).toHaveLength(4);
    expect(statements.filter((s) => s.startsWith('EXECUTE '))).toHaveLength(4);
    expect(statements.filter((s) => s.startsWith('DEALLOCATE PREPARE '))).toHaveLength(4);
    expect(statements.filter((s) => s.startsWith('DELETE '))).toHaveLength(2);
    const guard = statements.find((s) => s.includes('@needs_doc_ft :='));
    expect(guard).toContain('idx_shared_memories_search');
    expect(guard).toContain('information_schema.STATISTICS');
  });
});
