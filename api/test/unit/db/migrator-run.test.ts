import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Pool } from 'mysql2/promise';
import {
  LEDGER_TABLE,
  MigrationFailure,
  loadMigrations,
  migrationStatus,
  runMigrations,
  type MigrationLogger,
} from '../../../src/db/migrator.js';

/**
 * The runner's decision machine — drift, orphans, baselining, dry-run and the
 * advisory lock — without a database. `test/integration/db-migrations/migrator.test.ts`
 * owns the parts that need a real server (idempotency of the shipped SQL,
 * information_schema, actual lock contention) and is skipped whenever
 * `TEST_USE_DB!=1`, which is every CI run; the branches asserted here decide
 * what boot does to a production schema, so they cannot be gated on that.
 *
 * `runMigrations` touches the pool only through `getConnection()` → `query()` →
 * `release()`, so a fake that answers the ledger probe, the ledger SELECT,
 * GET_LOCK/RELEASE_LOCK and the INSERT drives all of it.
 */

const IS_GET_LOCK = /^SELECT GET_LOCK/;
const IS_RELEASE_LOCK = /^SELECT RELEASE_LOCK/;
/**
 * Two different information_schema reads have to be told apart. The table
 * listing `--init-schema` uses is the narrower pattern and is matched first:
 * `IS_LEDGER_PROBE` is unanchored and would otherwise swallow the listing and
 * answer it with a `present` count.
 */
const IS_TABLE_LIST = /^SELECT TABLE_NAME AS name/;
const IS_LEDGER_PROBE = /information_schema\.TABLES/;
const IS_CREATE_LEDGER = new RegExp(`^CREATE TABLE IF NOT EXISTS ${LEDGER_TABLE}\\b`);
const IS_READ_LEDGER = new RegExp(`^SELECT version, name, checksum, applied_at, applied_by FROM ${LEDGER_TABLE}`);
const IS_INSERT_LEDGER = new RegExp(`^INSERT INTO ${LEDGER_TABLE}\\b`);

interface Query {
  sql: string;
  params: unknown[];
}

/** Exactly the columns `readLedger` selects, in the driver's snake_case. */
interface LedgerRowShape {
  version: string;
  name: string;
  checksum: string;
  applied_at: string;
  applied_by: string | null;
}

interface FakePoolOptions {
  /** Omitted models a database with no `schema_migrations` table yet. */
  ledger?: LedgerRowShape[];
  /**
   * Application tables information_schema reports — what `--init-schema` reads
   * to decide whether the database still needs provisioning. Defaults to none,
   * i.e. an empty database.
   */
  tables?: string[];
  /** What GET_LOCK answers: 1 acquired, 0 timeout, null error. */
  getLock?: unknown;
  releaseLockError?: unknown;
  /** Rejects the first migration statement matching `match`. */
  failStatement?: { match: RegExp; error: unknown };
}

class FakePool {
  readonly queries: Query[] = [];
  /** Statements that are neither locking nor ledger bookkeeping: migration SQL. */
  readonly executed: string[] = [];
  connections = 0;
  released = 0;
  ledger: Map<string, LedgerRowShape> | null;
  tables: string[];

  private readonly getLock: unknown;
  private readonly releaseLockError: unknown;
  private readonly failStatement: { match: RegExp; error: unknown } | null;

  constructor(options: FakePoolOptions = {}) {
    this.ledger = options.ledger ? new Map(options.ledger.map((row) => [row.version, row])) : null;
    this.tables = [...(options.tables ?? [])];
    this.getLock = 'getLock' in options ? options.getLock : 1;
    this.releaseLockError = options.releaseLockError ?? null;
    this.failStatement = options.failStatement ?? null;
  }

  async getConnection(): Promise<unknown> {
    this.connections += 1;
    return {
      query: (sql: string, params?: unknown[]) => this.query(sql, params ?? []),
      release: () => {
        this.released += 1;
      },
    };
  }

  /** Forget what was asked so far, keeping the ledger a run just wrote. */
  clearLog(): void {
    this.queries.length = 0;
    this.executed.length = 0;
  }

  private async query(sql: string, params: unknown[]): Promise<[unknown, unknown[]]> {
    this.queries.push({ sql, params });

    if (IS_GET_LOCK.test(sql)) return [[{ acquired: this.getLock }], []];
    if (IS_RELEASE_LOCK.test(sql)) {
      if (this.releaseLockError) throw this.releaseLockError;
      return [[{ released: 1 }], []];
    }
    if (IS_TABLE_LIST.test(sql)) {
      const names = this.ledger ? [...this.tables, LEDGER_TABLE] : [...this.tables];
      return [names.map((name) => ({ name })), []];
    }
    if (IS_LEDGER_PROBE.test(sql)) return [[{ present: this.ledger ? 1 : 0 }], []];
    if (IS_CREATE_LEDGER.test(sql)) {
      this.ledger ??= new Map();
      return [{ affectedRows: 0 }, []];
    }
    if (IS_READ_LEDGER.test(sql)) return [[...(this.ledger?.values() ?? [])], []];
    if (IS_INSERT_LEDGER.test(sql)) {
      const [version, name, checksum, , , appliedAt, appliedBy] = params;
      (this.ledger ??= new Map()).set(String(version), {
        version: String(version),
        name: String(name),
        checksum: String(checksum),
        applied_at: String(appliedAt),
        applied_by: appliedBy === null ? null : String(appliedBy),
      });
      return [{ affectedRows: 1 }, []];
    }

    if (this.failStatement?.match.test(sql)) throw this.failStatement.error;
    this.executed.push(sql);
    return [{ affectedRows: 0 }, []];
  }
}

const asPool = (fake: FakePool): Pool => fake as unknown as Pool;
const inserts = (fake: FakePool): Query[] => fake.queries.filter((query) => IS_INSERT_LEDGER.test(query.sql));

/** Every exit path — success, lock refusal, statement failure — must release. */
function expectDrained(fake: FakePool): void {
  expect(fake.connections).toBeGreaterThan(0);
  expect(fake.released).toBe(fake.connections);
}

/** Captures what the runner logged so drift and orphan warnings can be asserted. */
function recordingLogger(): MigrationLogger & { lines: Array<[string, Record<string, unknown>, string]> } {
  const lines: Array<[string, Record<string, unknown>, string]> = [];
  return {
    lines,
    info: (payload, message) => lines.push(['info', payload, message]),
    warn: (payload, message) => lines.push(['warn', payload, message]),
    error: (payload, message) => lines.push(['error', payload, message]),
  };
}

const warned = (logger: ReturnType<typeof recordingLogger>, fragment: string): boolean =>
  logger.lines.some(([level, , message]) => level === 'warn' && message.includes(fragment));

const MAIN_FILES: Record<string, string> = {
  // Written out of order to prove the runner sorts by version, not by readdir.
  '0002_second.sql': 'CREATE TABLE beta (id INT);\nCREATE INDEX idx_beta ON beta (id);\n',
  '0001_first.sql': 'CREATE TABLE alpha (id INT);\n',
  '0003_third.sql': 'CREATE TABLE gamma (id INT);\n',
};

const MAIN_STATEMENTS = [
  'CREATE TABLE alpha (id INT)',
  'CREATE TABLE beta (id INT)',
  'CREATE INDEX idx_beta ON beta (id)',
  'CREATE TABLE gamma (id INT)',
];

describe('runMigrations against a fake pool', () => {
  let root: string;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'codex-migrator-run-'));
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const fixture = async (name: string, files: Record<string, string> = MAIN_FILES): Promise<string> => {
    const dir = join(root, name);
    await mkdir(dir, { recursive: true });
    for (const [filename, content] of Object.entries(files)) {
      await writeFile(join(dir, filename), content, 'utf8');
    }
    return dir;
  };

  it('creates the ledger and applies every file in version order', async () => {
    const dir = await fixture('fresh');
    const files = await loadMigrations(dir);
    const fake = new FakePool();
    const logger = recordingLogger();

    const report = await runMigrations(asPool(fake), { dir, logger, appliedBy: 'unit' });

    expect(report.ledgerCreated).toBe(true);
    expect(report.dryRun).toBe(false);
    expect(report.alreadyApplied).toBe(0);
    expect(report.drifted).toEqual([]);
    expect(report.orphaned).toEqual([]);
    expect(report.outcomes.map((outcome) => [outcome.version, outcome.action, outcome.statements])).toEqual([
      ['0001', 'applied', 1],
      ['0002', 'applied', 2],
      ['0003', 'applied', 1],
    ]);
    expect(fake.executed).toEqual(MAIN_STATEMENTS);

    // The lock brackets the whole run; a ledger this run created is known to be
    // empty, so it is never read back.
    expect(IS_GET_LOCK.test(fake.queries[0]!.sql)).toBe(true);
    expect(fake.queries[0]!.params).toEqual(['codex_orchestrator_schema_migrations', 120]);
    expect(IS_RELEASE_LOCK.test(fake.queries[fake.queries.length - 1]!.sql)).toBe(true);
    expect(fake.queries.some((query) => IS_CREATE_LEDGER.test(query.sql))).toBe(true);
    expect(fake.queries.some((query) => IS_READ_LEDGER.test(query.sql))).toBe(false);

    // One ledger row per file, carrying the file's checksum and the caller's name.
    expect(inserts(fake).map((query) => query.params[0])).toEqual(['0001', '0002', '0003']);
    expect(inserts(fake).map((query) => query.params[2])).toEqual(files.map((file) => file.checksum));
    expect(inserts(fake).map((query) => query.params[3])).toEqual([1, 2, 1]);
    expect(inserts(fake).every((query) => query.params[6] === 'unit')).toBe(true);
    expect(logger.lines.filter(([level, , message]) => level === 'info' && message === 'migration applied')).toHaveLength(3);
    expectDrained(fake);
  });

  it('applies nothing on a second run with unchanged files', async () => {
    const dir = await fixture('unchanged');
    const fake = new FakePool();
    await runMigrations(asPool(fake), { dir, appliedBy: 'unit' });

    fake.clearLog();
    const report = await runMigrations(asPool(fake), { dir, appliedBy: 'unit' });

    expect(report.ledgerCreated).toBe(false);
    expect(report.outcomes).toEqual([]);
    expect(report.alreadyApplied).toBe(3);
    expect(fake.executed).toEqual([]);
    expect(inserts(fake)).toEqual([]);
    expect(fake.queries.some((query) => IS_CREATE_LEDGER.test(query.sql))).toBe(false);
    expect((await migrationStatus(asPool(fake), dir)).every((state) => state.status === 'applied')).toBe(true);
    expectDrained(fake);
  });

  // The failure this guards: a comment edit to a destructive migration replaying
  // itself on the next boot. Drift is reported and left alone until an operator
  // asks for it with --reapply.
  it('reports an edited file as drifted without re-running it, and reapplies on demand', async () => {
    const dir = await fixture('drift');
    const before = await loadMigrations(dir);
    const fake = new FakePool();
    await runMigrations(asPool(fake), { dir, appliedBy: 'unit' });

    await writeFile(
      join(dir, '0002_second.sql'),
      `${MAIN_FILES['0002_second.sql']!}CREATE INDEX idx_beta_two ON beta (id);\n`,
      'utf8',
    );
    const after = await loadMigrations(dir);

    fake.clearLog();
    const logger = recordingLogger();
    const report = await runMigrations(asPool(fake), { dir, logger, appliedBy: 'unit' });

    expect(report.drifted.map((state) => [state.version, state.status])).toEqual([['0002', 'drifted']]);
    expect(report.drifted[0]!.appliedChecksum).toBe(before[1]!.checksum);
    expect(report.drifted[0]!.checksum).toBe(after[1]!.checksum);
    expect(report.outcomes).toEqual([]);
    expect(report.alreadyApplied).toBe(2);
    expect(fake.executed).toEqual([]);
    expect(inserts(fake)).toEqual([]);
    expect(warned(logger, 'no longer matches')).toBe(true);
    // The ledger keeps the stale checksum, so the drift is still reported next boot.
    expect(fake.ledger?.get('0002')?.checksum).toBe(before[1]!.checksum);
    expect((await migrationStatus(asPool(fake), dir)).map((state) => state.status)).toEqual([
      'applied',
      'drifted',
      'applied',
    ]);

    fake.clearLog();
    const forced = await runMigrations(asPool(fake), { dir, appliedBy: 'unit', reapply: ['0002'] });

    expect(forced.outcomes.map((outcome) => [outcome.version, outcome.action, outcome.statements])).toEqual([
      ['0002', 'reapplied', 3],
    ]);
    expect(forced.drifted).toEqual([]);
    expect(forced.alreadyApplied).toBe(2);
    expect(fake.executed).toEqual([
      'CREATE TABLE beta (id INT)',
      'CREATE INDEX idx_beta ON beta (id)',
      'CREATE INDEX idx_beta_two ON beta (id)',
    ]);
    expect(fake.ledger?.get('0002')?.checksum).toBe(after[1]!.checksum);
    expect((await migrationStatus(asPool(fake), dir)).every((state) => state.status === 'applied')).toBe(true);
    expectDrained(fake);
  });

  it('flags a ledger row this build does not ship as orphaned', async () => {
    const dir = await fixture('orphan');
    const fake = new FakePool();

    // Nothing applied yet: every file is pending and the ledger is not even read.
    expect((await migrationStatus(asPool(fake), dir)).every((state) => state.status === 'pending')).toBe(true);

    await runMigrations(asPool(fake), { dir, appliedBy: 'unit' });
    fake.ledger!.set('9999', {
      version: '9999',
      name: 'from_the_future',
      checksum: 'a'.repeat(64),
      applied_at: '2026-01-01T00:00:00Z',
      applied_by: 'a-newer-image',
    });

    fake.clearLog();
    const states = await migrationStatus(asPool(fake), dir);
    expect(states.map((state) => [state.version, state.status])).toEqual([
      ['0001', 'applied'],
      ['0002', 'applied'],
      ['0003', 'applied'],
      ['9999', 'orphaned'],
    ]);
    const orphan = states[3]!;
    expect(orphan.filename).toBeNull();
    expect(orphan.statements).toBeNull();
    expect(orphan.checksum).toBeNull();
    expect(orphan.appliedChecksum).toBe('a'.repeat(64));
    expect(orphan.appliedAt).toBe('2026-01-01T00:00:00Z');
    // Read-only: status never takes the lock and never writes.
    expect(fake.queries.every((query) => query.sql.startsWith('SELECT'))).toBe(true);

    fake.clearLog();
    const logger = recordingLogger();
    const report = await runMigrations(asPool(fake), { dir, logger, appliedBy: 'unit' });

    expect(report.orphaned.map((state) => state.version)).toEqual(['9999']);
    expect(report.outcomes).toEqual([]);
    expect(report.alreadyApplied).toBe(3);
    expect(fake.executed).toEqual([]);
    expect(warned(logger, 'does not ship')).toBe(true);
    expectDrained(fake);
  });

  // The adoption path for a database migrated by hand before the runner existed.
  it('records versions up to the baseline without executing them', async () => {
    const dir = await fixture('baseline');
    const fake = new FakePool();

    const report = await runMigrations(asPool(fake), { dir, appliedBy: 'unit', baselineThrough: '0002' });

    expect(report.outcomes.map((outcome) => [outcome.version, outcome.action, outcome.statements])).toEqual([
      ['0001', 'baselined', 0],
      ['0002', 'baselined', 0],
      ['0003', 'applied', 1],
    ]);
    expect(report.outcomes.slice(0, 2).every((outcome) => outcome.durationMs === 0)).toBe(true);
    expect(fake.executed).toEqual(['CREATE TABLE gamma (id INT)']);
    // Baselined rows are real ledger rows, marked so an operator can tell them apart.
    expect(inserts(fake).map((query) => query.params[0])).toEqual(['0001', '0002', '0003']);
    expect(inserts(fake).map((query) => query.params[6])).toEqual(['baseline:unit', 'baseline:unit', 'unit']);
    expect(inserts(fake).map((query) => query.params[3])).toEqual([0, 0, 1]);
    expectDrained(fake);
  });

  it('only fills gaps when baselining and never rewrites an existing row', async () => {
    const dir = await fixture('baseline-gap');
    const files = await loadMigrations(dir);
    const existing: LedgerRowShape = {
      version: '0001',
      name: 'first',
      checksum: files[0]!.checksum,
      applied_at: '2020-01-01T00:00:00Z',
      applied_by: 'by-hand',
    };
    const fake = new FakePool({ ledger: [{ ...existing }] });

    const report = await runMigrations(asPool(fake), { dir, appliedBy: 'unit', baselineThrough: '0003' });

    expect(report.ledgerCreated).toBe(false);
    expect(report.alreadyApplied).toBe(1);
    expect(report.outcomes.map((outcome) => [outcome.version, outcome.action])).toEqual([
      ['0002', 'baselined'],
      ['0003', 'baselined'],
    ]);
    expect(fake.executed).toEqual([]);
    expect(inserts(fake).map((query) => query.params[0])).toEqual(['0002', '0003']);
    expect(fake.ledger?.get('0001')).toEqual(existing);
    expectDrained(fake);
  });

  it('rejects a baseline or reapply version no file carries', async () => {
    const dir = await fixture('unknown-version');
    const fake = new FakePool();

    await expect(runMigrations(asPool(fake), { dir, baselineThrough: '0000_nope' })).rejects.toThrow(
      /--baseline 0000_nope does not match any migration version/,
    );
    await expect(runMigrations(asPool(fake), { dir, reapply: ['0002', '4242'] })).rejects.toThrow(
      /--reapply 4242 does not match any migration version/,
    );
    // Both guards fire before the runner takes a connection or the lock.
    expect(fake.connections).toBe(0);
    expect(fake.queries).toEqual([]);
  });

  it('writes nothing in dry-run mode while still reporting outcomes', async () => {
    const dir = await fixture('dry');
    const fake = new FakePool();

    const report = await runMigrations(asPool(fake), { dir, dryRun: true, appliedBy: 'unit' });

    expect(report.dryRun).toBe(true);
    expect(report.ledgerCreated).toBe(true);
    expect(report.outcomes.map((outcome) => [outcome.version, outcome.action, outcome.statements])).toEqual([
      ['0001', 'applied', 1],
      ['0002', 'applied', 2],
      ['0003', 'applied', 1],
    ]);
    expect(fake.executed).toEqual([]);
    expect(fake.queries.some((query) => IS_CREATE_LEDGER.test(query.sql))).toBe(false);
    expect(inserts(fake)).toEqual([]);
    expect(fake.ledger).toBeNull();
    expectDrained(fake);
  });

  // GET_LOCK is 1 on success, 0 on timeout and NULL on error, and NULL coerces
  // to 0 — the two failures must not collapse into one message.
  it('separates a held lock from an unevaluable one', async () => {
    const dir = await fixture('lock');

    const busy = new FakePool({ getLock: 0 });
    await expect(runMigrations(asPool(busy), { dir, lockTimeoutSeconds: 7 })).rejects.toThrow(
      /another process holds the migration lock codex_orchestrator_schema_migrations \(waited 7s\)/,
    );
    expect(busy.queries[0]!.params).toEqual(['codex_orchestrator_schema_migrations', 7]);
    expect(busy.executed).toEqual([]);
    expect(busy.queries.some((query) => IS_LEDGER_PROBE.test(query.sql))).toBe(false);
    // The lock was never taken, so it is not released; the connection still is.
    expect(busy.queries.some((query) => IS_RELEASE_LOCK.test(query.sql))).toBe(false);
    expectDrained(busy);

    const broken = new FakePool({ getLock: null });
    await expect(runMigrations(asPool(broken), { dir })).rejects.toThrow(/GET_LOCK returned NULL/);
    expect(broken.executed).toEqual([]);
    expectDrained(broken);
  });

  it('surfaces a failing statement as a MigrationFailure and abandons the rest of the file', async () => {
    const dir = await fixture('failing', {
      '0001_first.sql': 'CREATE TABLE alpha (id INT);\n',
      '0002_boom.sql':
        'CREATE TABLE beta (id INT);\nALTER TABLE beta ADD INDEX idx_beta (id);\nCREATE TABLE delta (id INT);\n',
    });
    const driverError = Object.assign(new Error('sql error'), {
      code: 'ER_DUP_KEYNAME',
      errno: 1061,
      sqlMessage: "Duplicate key name 'idx_beta'",
    });
    const fake = new FakePool({ failStatement: { match: /ADD INDEX/, error: driverError } });

    const thrown: unknown = await runMigrations(asPool(fake), { dir, appliedBy: 'unit' }).then(
      () => null,
      (err: unknown) => err,
    );

    expect(thrown).toBeInstanceOf(MigrationFailure);
    const failure = thrown as MigrationFailure;
    expect(failure.filename).toBe('0002_boom.sql');
    expect(failure.statementIndex).toBe(2);
    expect(failure.statementCount).toBe(3);
    expect(failure.statement).toBe('ALTER TABLE beta ADD INDEX idx_beta (id)');
    expect(failure.cause).toBe(driverError);
    expect(failure.message).toContain('migration 0002_boom.sql failed at statement 2/3');
    expect(failure.message).toContain('ER_DUP_KEYNAME (1061)');
    expect(failure.message).toContain("Duplicate key name 'idx_beta'");

    // The statements after the failure never run, and the file gets no ledger row.
    expect(fake.executed).toEqual(['CREATE TABLE alpha (id INT)', 'CREATE TABLE beta (id INT)']);
    expect(inserts(fake).map((query) => query.params[0])).toEqual(['0001']);
    expect(fake.queries.some((query) => IS_RELEASE_LOCK.test(query.sql))).toBe(true);
    expectDrained(fake);
  });

  // MySQL drops the lock when the session ends, so a failed release is noise —
  // failing the run over it would turn a healthy boot into a crash loop.
  it('warns instead of failing when the lock cannot be released', async () => {
    const dir = await fixture('release-fails');
    const fake = new FakePool({ releaseLockError: new Error('connection lost') });
    const logger = recordingLogger();

    const report = await runMigrations(asPool(fake), { dir, logger, appliedBy: 'unit' });

    expect(report.outcomes).toHaveLength(3);
    expect(fake.executed).toEqual(MAIN_STATEMENTS);
    expect(
      logger.lines.some(
        ([level, payload, message]) =>
          level === 'warn' &&
          message.includes('failed to release the migration lock') &&
          String(payload.err).includes('connection lost'),
      ),
    ).toBe(true);
    expectDrained(fake);
  });

  /**
   * `--init-schema` is the only way a fresh install gets a schema at all: the
   * migrations extend an existing one and 0003/0006 carry foreign keys, so an
   * empty database cannot be built by replaying them. These branches decide
   * whether `bin/install.sh` produces a working stack or a crash-looping one,
   * and whether re-running it over a live database is safe.
   */
  describe('--init-schema', () => {
    const BASELINE = 'CREATE TABLE hosts (id INT);\nCREATE TABLE admin_users (id INT);\n';

    const withBaseline = async (name: string): Promise<{ dir: string; baselineFile: string }> => {
      const dir = await fixture(name);
      const baselineFile = join(root, `${name}-baseline.sql`);
      await writeFile(baselineFile, BASELINE, 'utf8');
      return { dir, baselineFile };
    };

    it('creates the schema on an empty database, then migrates on top', async () => {
      const { dir, baselineFile } = await withBaseline('init-empty');
      const fake = new FakePool();
      const logger = recordingLogger();

      const report = await runMigrations(asPool(fake), {
        dir,
        logger,
        baselineFile,
        initSchema: true,
        appliedBy: 'unit',
      });

      expect(report.baseline).toMatchObject({ applied: true, statements: 2 });
      // Baseline first, migrations after — the other order would run 0003's
      // foreign keys against tables that do not exist yet.
      expect(fake.executed).toEqual([
        'CREATE TABLE hosts (id INT)',
        'CREATE TABLE admin_users (id INT)',
        ...MAIN_STATEMENTS,
      ]);
      expect(report.outcomes.map((outcome) => outcome.action)).toEqual(['applied', 'applied', 'applied']);
      expectDrained(fake);
    });

    // An installer that fails the second time it runs is not one anybody can
    // recover a half-finished install with.
    it('skips the baseline when application tables already exist, and still migrates', async () => {
      const { dir, baselineFile } = await withBaseline('init-populated');
      const fake = new FakePool({ tables: ['hosts', 'admin_users'] });
      const logger = recordingLogger();

      const report = await runMigrations(asPool(fake), {
        dir,
        logger,
        baselineFile,
        initSchema: true,
        appliedBy: 'unit',
      });

      expect(report.baseline).toMatchObject({ applied: false, statements: 0 });
      expect(report.baseline?.reason).toContain('schema already present');
      expect(fake.executed).toEqual(MAIN_STATEMENTS);
      expectDrained(fake);
    });

    /**
     * The ledger can exist before any schema does — a `--check` against an empty
     * database creates it, and so does an aborted earlier init. Counting it as
     * "populated" would make init unreachable exactly when it is needed.
     */
    it('does not count the migration ledger as an application table', async () => {
      const { dir, baselineFile } = await withBaseline('init-ledger-only');
      const fake = new FakePool({ ledger: [] });
      const logger = recordingLogger();

      const report = await runMigrations(asPool(fake), {
        dir,
        logger,
        baselineFile,
        initSchema: true,
        appliedBy: 'unit',
      });

      expect(report.baseline?.applied).toBe(true);
      expectDrained(fake);
    });

    it('writes nothing under --dry-run but reports what it would do', async () => {
      const { dir, baselineFile } = await withBaseline('init-dry');
      const fake = new FakePool();

      const report = await runMigrations(asPool(fake), {
        dir,
        baselineFile,
        initSchema: true,
        dryRun: true,
        appliedBy: 'unit',
      });

      expect(report.baseline).toMatchObject({ applied: false, statements: 2 });
      expect(report.baseline?.reason).toContain('dry run');
      expect(fake.executed).toEqual([]);
      expectDrained(fake);
    });

    // `--baseline` records migrations without executing them. Combined with an
    // empty database it would mark the whole set applied over a schema that was
    // never created — the one failure mode init exists to prevent.
    it('refuses to combine with --baseline', async () => {
      const { dir, baselineFile } = await withBaseline('init-conflict');
      const fake = new FakePool();

      await expect(
        runMigrations(asPool(fake), {
          dir,
          baselineFile,
          initSchema: true,
          baselineThrough: '0002',
          appliedBy: 'unit',
        }),
      ).rejects.toThrow('--init-schema cannot be combined with --baseline');
      // Rejected before the lock is taken, so nothing to drain.
      expect(fake.connections).toBe(0);
    });

    it('fails loudly when the baseline artifact is missing from the build', async () => {
      const dir = await fixture('init-missing');
      const fake = new FakePool();

      await expect(
        runMigrations(asPool(fake), {
          dir,
          baselineFile: join(root, 'does-not-exist.sql'),
          initSchema: true,
          appliedBy: 'unit',
        }),
      ).rejects.toThrow('baseline schema is unreadable');
      expect(fake.connections).toBe(0);
    });
  });
});
