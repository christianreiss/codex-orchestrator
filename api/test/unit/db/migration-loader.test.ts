import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { defaultMigrationsDir, loadMigrations } from '../../../src/db/migrator.js';

describe('loadMigrations', () => {
  let root: string;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'codex-migrations-'));
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const fixture = async (name: string, files: Record<string, string>): Promise<string> => {
    const dir = join(root, name);
    await mkdir(dir, { recursive: true });
    for (const [filename, content] of Object.entries(files)) {
      await writeFile(join(dir, filename), content, 'utf8');
    }
    return dir;
  };

  it('orders by version and ignores non-SQL files', async () => {
    const dir = await fixture('ordered', {
      '0010_ten.sql': 'SELECT 10;',
      '0002_two.sql': 'SELECT 2;',
      'README.md': 'not a migration',
    });
    const files = await loadMigrations(dir);
    expect(files.map((file) => file.version)).toEqual(['0002', '0010']);
    expect(files[0]!.name).toBe('two');
  });

  it('rejects filenames that do not carry a version', async () => {
    const dir = await fixture('unnamed', { 'add_thing.sql': 'SELECT 1;' });
    await expect(loadMigrations(dir)).rejects.toThrow(/NNNN_snake_case\.sql/);
  });

  it('rejects two files claiming the same version', async () => {
    const dir = await fixture('clash', {
      '0001_a.sql': 'SELECT 1;',
      '0001_b.sql': 'SELECT 2;',
    });
    await expect(loadMigrations(dir)).rejects.toThrow(/duplicate migration version 0001/);
  });

  it('rejects a file with nothing executable in it', async () => {
    const dir = await fixture('empty', { '0001_nothing.sql': '-- just a note\n' });
    await expect(loadMigrations(dir)).rejects.toThrow(/contains no statements/);
  });

  // The failure this guards: a build that forgets to ship `migrations/` would
  // otherwise report "0 pending" and let the API serve against a stale schema.
  it('fails loudly instead of reporting an empty migration set', async () => {
    const dir = await fixture('barren', { 'notes.txt': 'nothing here' });
    await expect(loadMigrations(dir)).rejects.toThrow(/no \.sql migrations found/);
    await expect(loadMigrations(join(root, 'does-not-exist'))).rejects.toThrow(/unreadable/);
  });

  it('checksums the content, not the line endings', async () => {
    const lf = await fixture('lf', { '0001_x.sql': 'SELECT 1;\nSELECT 2;\n' });
    const crlf = await fixture('crlf', { '0001_x.sql': 'SELECT 1;\r\nSELECT 2;\r\n' });
    const [a] = await loadMigrations(lf);
    const [b] = await loadMigrations(crlf);
    expect(a!.checksum).toBe(b!.checksum);
  });

  it('loads the shipped migrations from the directory beside the module', async () => {
    expect(defaultMigrationsDir()).toBe(resolve(import.meta.dirname, '../../../src/db/migrations'));

    const files = await loadMigrations();
    expect(files.length).toBeGreaterThanOrEqual(6);
    expect(files.map((file) => file.version)).toEqual([...files.map((f) => f.version)].sort());
    for (const file of files) {
      expect(file.statements.length).toBeGreaterThan(0);
      expect(file.checksum).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  // Every migration is re-runnable by contract; 0002 used to be the exception
  // (bare `ADD UNIQUE INDEX`, ER_DUP_KEYNAME on the second pass). The real
  // enforcement is the double-apply integration test, but a static check keeps
  // the obvious version of the mistake out of review.
  it('ships no unguarded ADD INDEX / ADD CONSTRAINT statement', async () => {
    const files = await loadMigrations();
    for (const file of files) {
      for (const statement of file.statements) {
        if (!/^ALTER TABLE .* ADD (UNIQUE |FULLTEXT |)?(INDEX|KEY|CONSTRAINT)/i.test(statement)) {
          continue;
        }
        // Guarded variants reach the server as `PREPARE … FROM @ddl`, never as a
        // bare ALTER, so any bare ALTER here is unguarded by construction.
        expect.fail(`${file.filename} contains an unguarded index/constraint ALTER: ${statement}`);
      }
    }
  });
});
