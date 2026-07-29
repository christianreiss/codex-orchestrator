import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The DB-backed suites under `test/integration` are the only coverage some
 * behaviour has — FULLTEXT ranking, unique indexes, FK cascade, the migration
 * runner — and they run against real MySQL only under `npm run test:db`. The
 * default `npm test` collects them all the same, so each one stays honest by
 * binding `const handle = await getTestDb()` at module level and wrapping its
 * suites in `describe.skipIf(!handle)`.
 *
 * Nothing enforced that convention. A new suite that dereferenced the null
 * handle in a describe body would fail every run without a database, and one
 * that asserted against a null `db` would pass vacuously — the failure mode
 * this file exists to prevent, since `test:db` is not part of the gate.
 *
 * The scan reads every `*.test.ts` under `test/integration` that imports
 * `getTestDb` as a value and fails when either half of the convention is
 * missing. It also pins the `test:db` invocation itself: the suites' docstrings
 * call `--no-file-parallelism` non-optional (the index-drop tests race the
 * migration suite), and that requirement lives only in the npm script.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const INTEGRATION = resolve(HERE, '../../integration');
const PACKAGE_JSON = resolve(HERE, '../../../package.json');

/**
 * Suites exempt from the convention, keyed by their path relative to
 * `test/integration` with the reason they may skip it. Empty on purpose — an
 * addition here is a deliberate decision to let a DB-backed suite decide for
 * itself what happens when no database is configured.
 */
const ALLOWED: Record<string, string> = {};

/** The value import; `import type { TestDb }` alone does not touch the DB. */
const TEST_DB_IMPORT = /import\s+([^;]*?)\s+from\s+'[^']*helpers\/test-db\.js';/g;
/** Column 0 anchors it to module scope: inside a describe or beforeAll it is indented. */
const TOP_LEVEL_HANDLE = /^const handle = await getTestDb\(\)/m;
const SKIP_GUARD = /\b(?:describe|it)\.skipIf\(!handle\)/;

function importsGetTestDb(source: string): boolean {
  for (const [, clause] of source.matchAll(TEST_DB_IMPORT)) {
    const bindings = clause!;
    if (/^type\b/.test(bindings) || /\btype\s+getTestDb\b/.test(bindings)) continue;
    if (/\bgetTestDb\b/.test(bindings)) return true;
  }
  return false;
}

function testFiles(): string[] {
  return readdirSync(INTEGRATION, { recursive: true, encoding: 'utf8' })
    .filter((file) => file.endsWith('.test.ts'))
    .sort();
}

const dbBackedFiles = testFiles().filter((file) =>
  importsGetTestDb(readFileSync(join(INTEGRATION, file), 'utf8')),
);

function offencesOf(file: string): string[] {
  const source = readFileSync(join(INTEGRATION, file), 'utf8');
  const reasons: string[] = [];
  if (!TOP_LEVEL_HANDLE.test(source)) {
    reasons.push('no top-level `const handle = await getTestDb()`');
  }
  if (!SKIP_GUARD.test(source)) {
    reasons.push('no `describe.skipIf(!handle)` / `it.skipIf(!handle)` guard');
  }
  return reasons.map((reason) => `${file}: ${reason}`);
}

describe('DB-backed integration suites', () => {
  it('are all gated on a top-level getTestDb() handle', () => {
    const offenders = dbBackedFiles.filter((file) => !(file in ALLOWED)).flatMap((file) => offencesOf(file));
    expect(offenders, 'a suite without a database must skip, not fail or assert against null').toEqual([]);
  });

  it('are still found by the scan', () => {
    expect(dbBackedFiles.length, `no suite under ${INTEGRATION} imports getTestDb`).toBeGreaterThan(0);
  });
});

describe('the test:db script', () => {
  it('opts into the database and disables file parallelism', () => {
    const scripts = (JSON.parse(readFileSync(PACKAGE_JSON, 'utf8')) as { scripts: Record<string, string> })
      .scripts;
    const testDb = scripts['test:db'] ?? '';
    expect(testDb).toContain('TEST_USE_DB=1');
    expect(testDb, 'the index-drop suites race the migration suite when files run in parallel').toContain(
      '--no-file-parallelism',
    );
  });
});
