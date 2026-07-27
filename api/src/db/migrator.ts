/**
 * Migration runner for the hand-written SQL in `migrations/`.
 *
 * Before this existed, every schema change had to be piped into the `mysql`
 * container by hand and the only thing standing between a missed migration and
 * a production 500 was a hand-maintained probe in `ops/boot-checks.ts`. The
 * runner replaces that with a ledger (`schema_migrations`) plus an advisory
 * lock, and is driven from two places: API boot (`ops/boot-migrations.ts`) and
 * the `migrate` CLI (`db/migrate-cli.ts`, `dist/migrate.js`).
 *
 * Three properties are load-bearing:
 *
 *  - **One connection for the whole run.** Migrations use session state — user
 *    variables (`SET @needs_ft := …` then `IF(@needs_ft, …)`) and `PREPARE` /
 *    `EXECUTE` handles. Spreading their statements across a pool would silently
 *    evaluate the guards against NULL and skip the DDL they protect.
 *  - **No transaction.** MySQL DDL commits implicitly, so a `BEGIN`/`ROLLBACK`
 *    wrapper would be theatre: a half-applied migration cannot be rolled back.
 *    Statements run in order, the first failure aborts the run, and the ledger
 *    row is written only after the whole file succeeds. Do not add one.
 *  - **Migrations must be idempotent.** They are re-runnable by contract
 *    (`CREATE TABLE IF NOT EXISTS`, information_schema guards), which is what
 *    lets a fresh runner meet an already-migrated database without exploding.
 *    `test/integration/db-migrations/migrator.test.ts` enforces it by applying
 *    every file twice.
 *
 * There is no `0000_baseline.sql`: 0003 and 0006 carry foreign keys to
 * `coord_projects`/`hosts`, so the runner evolves an existing schema rather
 * than creating one from nothing. See `db/README.md`.
 */

import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { Pool, PoolConnection, RowDataPacket } from 'mysql2/promise';
import { nowIso } from '../util/timestamp.js';
import { splitSqlStatements } from './migration-sql.js';

export const LEDGER_TABLE = 'schema_migrations';

/** Session-scoped MySQL advisory lock; names are capped at 64 characters. */
const LOCK_NAME = 'codex_orchestrator_schema_migrations';

const FILENAME = /^(\d{4,})_([a-z0-9][a-z0-9_]*)\.sql$/;

export interface MigrationFile {
  version: string;
  name: string;
  filename: string;
  /** sha256 of the file with line endings normalised, so CRLF checkouts agree. */
  checksum: string;
  statements: string[];
}

export interface LedgerRow {
  version: string;
  name: string;
  checksum: string;
  appliedAt: string;
  appliedBy: string | null;
}

/**
 * `drifted` = applied, but the file changed since. `orphaned` = the ledger
 * remembers a migration this build does not ship (an older image, usually).
 */
export type MigrationStatusKind = 'pending' | 'applied' | 'drifted' | 'orphaned';

export interface MigrationState {
  version: string;
  name: string;
  filename: string | null;
  status: MigrationStatusKind;
  checksum: string | null;
  appliedChecksum: string | null;
  appliedAt: string | null;
  statements: number | null;
}

export interface MigrationOutcome {
  version: string;
  filename: string;
  action: 'applied' | 'reapplied' | 'baselined';
  statements: number;
  durationMs: number;
}

export interface MigrationReport {
  ledgerCreated: boolean;
  outcomes: MigrationOutcome[];
  drifted: MigrationState[];
  orphaned: MigrationState[];
  alreadyApplied: number;
  dryRun: boolean;
}

export interface MigrationLogger {
  info(payload: Record<string, unknown>, message: string): void;
  warn(payload: Record<string, unknown>, message: string): void;
  error(payload: Record<string, unknown>, message: string): void;
}

export interface RunMigrationsOptions {
  dir?: string;
  logger?: MigrationLogger;
  /** Recorded in the ledger for forensics, e.g. `boot@api-3f21` or `cli`. */
  appliedBy?: string;
  lockTimeoutSeconds?: number;
  /** Resolve and report, write nothing. */
  dryRun?: boolean;
  /**
   * Record every migration up to and including this version as applied without
   * executing it — the adoption path for a database that was migrated by hand
   * before the runner existed. Only fills gaps; never rewrites an existing row.
   */
  baselineThrough?: string | null;
  /** Versions to execute again even though the ledger says they are applied. */
  reapply?: string[];
}

const silentLogger: MigrationLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

/** Thrown with enough context to debug a crash-looping container from logs. */
export class MigrationFailure extends Error {
  constructor(
    readonly filename: string,
    readonly statementIndex: number,
    readonly statementCount: number,
    readonly statement: string,
    cause: unknown,
  ) {
    const driver = cause as { code?: string; errno?: number; sqlMessage?: string } | null;
    const detail = driver?.sqlMessage ?? (cause instanceof Error ? cause.message : String(cause));
    const code = driver?.code ? `${driver.code}${driver.errno ? ` (${driver.errno})` : ''}` : 'unknown error';
    super(
      `migration ${filename} failed at statement ${statementIndex}/${statementCount}: ${code}: ${detail}\n` +
        `  statement: ${preview(statement)}`,
      { cause },
    );
    this.name = 'MigrationFailure';
  }
}

function preview(statement: string): string {
  const flat = statement.replace(/\s+/g, ' ').trim();
  return flat.length > 200 ? `${flat.slice(0, 200)}…` : flat;
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** Order and compare versions by number, so a 5-digit 10000 still sorts last. */
function versionKey(version: string): string {
  return version.padStart(8, '0');
}

/**
 * `migrations/` sits next to this module in both layouts: `src/db/migrations`
 * under tsx, and `dist/migrations` in the image, where `scripts/build.ts`
 * copies the files beside the bundle.
 */
export function defaultMigrationsDir(): string {
  return resolve(import.meta.dirname, 'migrations');
}

export async function loadMigrations(dir?: string): Promise<MigrationFile[]> {
  const root = dir?.trim() || defaultMigrationsDir();

  let entries: string[];
  try {
    entries = await readdir(root);
  } catch (cause) {
    // A missing directory means the build dropped the SQL files. Failing here
    // beats reporting "0 pending" and letting the API serve a stale schema.
    throw new Error(`migrations directory is unreadable: ${root}`, { cause });
  }

  const filenames = entries.filter((entry) => entry.endsWith('.sql')).sort();
  if (filenames.length === 0) throw new Error(`no .sql migrations found in ${root}`);

  const byVersion = new Map<string, string>();
  const files: MigrationFile[] = [];

  for (const filename of filenames) {
    const match = FILENAME.exec(filename);
    if (!match) {
      throw new Error(`migration filename must look like NNNN_snake_case.sql: ${filename}`);
    }
    const version = match[1]!;
    const clash = byVersion.get(version);
    if (clash) {
      throw new Error(`duplicate migration version ${version}: ${clash} and ${filename}`);
    }
    byVersion.set(version, filename);

    const raw = await readFile(join(root, filename), 'utf8');
    const statements = splitSqlStatements(raw);
    if (statements.length === 0) throw new Error(`migration contains no statements: ${filename}`);

    files.push({
      version,
      name: match[2]!,
      filename,
      checksum: sha256(raw.replace(/\r\n/g, '\n')),
      statements,
    });
  }

  return files.sort((a, b) => versionKey(a.version).localeCompare(versionKey(b.version)));
}

/** Read-only view of file state versus ledger state. Never writes. */
export async function migrationStatus(pool: Pool, dir?: string): Promise<MigrationState[]> {
  const files = await loadMigrations(dir);
  const conn = await pool.getConnection();
  try {
    const ledger = (await ledgerExists(conn)) ? await readLedger(conn) : new Map<string, LedgerRow>();
    return buildStates(files, ledger);
  } finally {
    conn.release();
  }
}

export async function runMigrations(
  pool: Pool,
  options: RunMigrationsOptions = {},
): Promise<MigrationReport> {
  const logger = options.logger ?? silentLogger;
  const dryRun = options.dryRun === true;
  const appliedBy = (options.appliedBy ?? 'api').slice(0, 191);
  const lockTimeout = Math.max(1, options.lockTimeoutSeconds ?? 120);
  const files = await loadMigrations(options.dir);

  const baselineThrough = options.baselineThrough?.trim() || null;
  if (baselineThrough && !files.some((file) => file.version === baselineThrough)) {
    throw new Error(`--baseline ${baselineThrough} does not match any migration version`);
  }
  const reapply = new Set(options.reapply ?? []);
  for (const version of reapply) {
    if (!files.some((file) => file.version === version)) {
      throw new Error(`--reapply ${version} does not match any migration version`);
    }
  }

  const conn = await pool.getConnection();
  try {
    await acquireLock(conn, lockTimeout);
    try {
      const ledgerCreated = !(await ledgerExists(conn));
      if (ledgerCreated && !dryRun) await createLedger(conn);
      const ledger = ledgerCreated ? new Map<string, LedgerRow>() : await readLedger(conn);

      const report: MigrationReport = {
        ledgerCreated,
        outcomes: [],
        drifted: [],
        orphaned: buildStates(files, ledger).filter((state) => state.status === 'orphaned'),
        alreadyApplied: 0,
        dryRun,
      };

      for (const file of files) {
        const row = ledger.get(file.version);
        const forced = reapply.has(file.version);

        if (row && !forced) {
          if (row.checksum === file.checksum) {
            report.alreadyApplied += 1;
            continue;
          }
          // Re-running on a checksum change would let a comment edit to a
          // destructive migration replay itself on the next boot. Report it and
          // let an operator decide with `--reapply`.
          report.drifted.push(stateFor(file, row));
          logger.warn(
            {
              version: file.version,
              migration: file.filename,
              appliedChecksum: row.checksum,
              fileChecksum: file.checksum,
              appliedAt: row.appliedAt,
            },
            'applied migration no longer matches its file; the edit is NOT applied (re-run with --reapply to execute it)',
          );
          continue;
        }

        const baselined =
          !row && baselineThrough !== null && versionKey(file.version) <= versionKey(baselineThrough);
        const action: MigrationOutcome['action'] = baselined
          ? 'baselined'
          : forced
            ? 'reapplied'
            : 'applied';

        if (dryRun) {
          report.outcomes.push({
            version: file.version,
            filename: file.filename,
            action,
            statements: baselined ? 0 : file.statements.length,
            durationMs: 0,
          });
          continue;
        }

        const durationMs = baselined ? 0 : await applyStatements(conn, file);
        const statements = baselined ? 0 : file.statements.length;
        await recordApplied(conn, file, {
          appliedBy: baselined ? `baseline:${appliedBy}` : appliedBy,
          statements,
          durationMs,
        });

        report.outcomes.push({
          version: file.version,
          filename: file.filename,
          action,
          statements,
          durationMs,
        });
        logger.info(
          { version: file.version, migration: file.filename, statements, durationMs, action },
          `migration ${action}`,
        );
      }

      for (const state of report.orphaned) {
        logger.warn(
          { version: state.version, appliedAt: state.appliedAt },
          'ledger records a migration this build does not ship; schema may be ahead of the code',
        );
      }

      return report;
    } finally {
      await releaseLock(conn, logger);
    }
  } finally {
    conn.release();
  }
}

async function applyStatements(conn: PoolConnection, file: MigrationFile): Promise<number> {
  const started = Date.now();
  for (const [offset, statement] of file.statements.entries()) {
    try {
      await conn.query(statement);
    } catch (cause) {
      throw new MigrationFailure(
        file.filename,
        offset + 1,
        file.statements.length,
        statement,
        cause,
      );
    }
  }
  return Date.now() - started;
}

async function recordApplied(
  conn: PoolConnection,
  file: MigrationFile,
  meta: { appliedBy: string; statements: number; durationMs: number },
): Promise<void> {
  await conn.query(
    `INSERT INTO ${LEDGER_TABLE}
       (version, name, checksum, statements, duration_ms, applied_at, applied_by)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       name = VALUES(name),
       checksum = VALUES(checksum),
       statements = VALUES(statements),
       duration_ms = VALUES(duration_ms),
       applied_at = VALUES(applied_at),
       applied_by = VALUES(applied_by)`,
    [
      file.version,
      file.name.slice(0, 191),
      file.checksum,
      meta.statements,
      meta.durationMs,
      nowIso(),
      meta.appliedBy,
    ],
  );
}

async function ledgerExists(conn: PoolConnection): Promise<boolean> {
  const [rows] = await conn.query<RowDataPacket[]>(
    `SELECT COUNT(*) AS present
       FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?`,
    [LEDGER_TABLE],
  );
  return Number(rows[0]?.present ?? 0) > 0;
}

async function createLedger(conn: PoolConnection): Promise<void> {
  await conn.query(
    `CREATE TABLE IF NOT EXISTS ${LEDGER_TABLE} (
       version VARCHAR(32) NOT NULL,
       name VARCHAR(191) NOT NULL,
       checksum CHAR(64) NOT NULL,
       statements INT UNSIGNED NOT NULL DEFAULT 0,
       duration_ms INT UNSIGNED NOT NULL DEFAULT 0,
       applied_at VARCHAR(100) NOT NULL,
       applied_by VARCHAR(191) NULL,
       PRIMARY KEY (version)
     ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  );
}

async function readLedger(conn: PoolConnection): Promise<Map<string, LedgerRow>> {
  const [rows] = await conn.query<RowDataPacket[]>(
    `SELECT version, name, checksum, applied_at, applied_by FROM ${LEDGER_TABLE}`,
  );
  const ledger = new Map<string, LedgerRow>();
  for (const row of rows) {
    ledger.set(String(row.version), {
      version: String(row.version),
      name: String(row.name),
      checksum: String(row.checksum),
      appliedAt: String(row.applied_at),
      appliedBy: row.applied_by === null ? null : String(row.applied_by),
    });
  }
  return ledger;
}

function stateFor(file: MigrationFile, row: LedgerRow | undefined): MigrationState {
  const status: MigrationStatusKind = !row
    ? 'pending'
    : row.checksum === file.checksum
      ? 'applied'
      : 'drifted';
  return {
    version: file.version,
    name: file.name,
    filename: file.filename,
    status,
    checksum: file.checksum,
    appliedChecksum: row?.checksum ?? null,
    appliedAt: row?.appliedAt ?? null,
    statements: file.statements.length,
  };
}

function buildStates(files: MigrationFile[], ledger: Map<string, LedgerRow>): MigrationState[] {
  const states = files.map((file) => stateFor(file, ledger.get(file.version)));
  const known = new Set(files.map((file) => file.version));
  for (const row of ledger.values()) {
    if (known.has(row.version)) continue;
    states.push({
      version: row.version,
      name: row.name,
      filename: null,
      status: 'orphaned',
      checksum: null,
      appliedChecksum: row.checksum,
      appliedAt: row.appliedAt,
      statements: null,
    });
  }
  return states.sort((a, b) => versionKey(a.version).localeCompare(versionKey(b.version)));
}

async function acquireLock(conn: PoolConnection, timeoutSeconds: number): Promise<void> {
  const [rows] = await conn.query<RowDataPacket[]>('SELECT GET_LOCK(?, ?) AS acquired', [
    LOCK_NAME,
    timeoutSeconds,
  ]);
  const acquired = rows[0]?.acquired ?? null;
  // GET_LOCK is 1 on success, 0 on timeout, NULL on error — and NULL coerces to
  // 0, so the three cases have to be separated before any numeric compare.
  if (acquired === null) {
    throw new Error(`migration lock ${LOCK_NAME} could not be evaluated (GET_LOCK returned NULL)`);
  }
  if (Number(acquired) === 1) return;
  throw new Error(
    `another process holds the migration lock ${LOCK_NAME} (waited ${timeoutSeconds}s); ` +
      'retry once it finishes',
  );
}

async function releaseLock(conn: PoolConnection, logger: MigrationLogger): Promise<void> {
  try {
    await conn.query('SELECT RELEASE_LOCK(?)', [LOCK_NAME]);
  } catch (err) {
    // The connection goes back to the pool either way; MySQL drops the lock
    // when the session ends, so this is noise rather than a failure.
    logger.warn({ err: String(err) }, 'failed to release the migration lock');
  }
}
