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
 *  - **No DDL transaction.** MySQL DDL commits implicitly, so a `BEGIN`/`ROLLBACK`
 *    wrapper would be theatre: a half-applied migration cannot be rolled back.
 *    Statements run in order, the first failure aborts the run, and the ledger
 *    row is written only after the whole file succeeds. Do not add one.
 *  - **Migrations must be idempotent.** They are re-runnable by contract
 *    (`CREATE TABLE IF NOT EXISTS`, information_schema guards), which is what
 *    lets a fresh runner meet an already-migrated database without exploding.
 *    `test/integration/db-migrations/migrator.test.ts` enforces it by applying
 *    every file twice.
 *
 * There is no `0000_baseline.sql`, and there deliberately is not one: 0003 and
 * 0006 carry foreign keys to `coord_projects`/`hosts`, so the migrations evolve
 * an existing schema rather than creating one from nothing. The starting schema
 * comes from `baseline/schema.sql` instead, applied once by `--init-schema`
 * against an empty database. Its temporary recovery checkpoint uses a
 * reserved, non-numeric ledger key. Keeping it out of the sequence is what stops an existing deployment
 * seeing a new pending migration. See `db/README.md`.
 */

import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { Pool, PoolConnection, RowDataPacket } from 'mysql2/promise';
import { nowIso } from '../util/timestamp.js';
import { splitSqlStatements } from './migration-sql.js';

export const LEDGER_TABLE = 'schema_migrations';
const BASELINE_PROGRESS = '@init-schema';

/**
 * Session-scoped MySQL advisory lock; names are capped at 64 characters.
 * GET_LOCK names are server-global, but the ledger and the schema it guards
 * belong to one database, so the name carries a digest of `DATABASE()`
 * (like the control-plane owner lock). Every runner against the same database
 * — API boot and the `migrate` CLI in `scripts/deploy.sh` — still derives the
 * same name and serialises; runners against other databases on the same server
 * no longer block each other.
 */
const LOCK_PREFIX = 'codex_orchestrator_schema_migrations';

export function migrationLockName(database: string): string {
  return `${LOCK_PREFIX}.${createHash('sha256').update(database).digest('hex').slice(0, 16)}`;
}

export type MigrationPool = Pick<Pool, 'getConnection'>;

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
  statements: number;
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

/**
 * Result of the `--init-schema` pass. `applied: false` with a reason is the
 * normal outcome on every run after the first — an installer has to be safe to
 * re-run, so meeting a populated database is success, not an error.
 */
export interface BaselineOutcome {
  applied: boolean;
  reason: string;
  statements: number;
  durationMs: number;
}

export interface MigrationReport {
  ledgerCreated: boolean;
  /** Present only when `--init-schema` was requested. */
  baseline: BaselineOutcome | null;
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
  /**
   * Create the starting schema from `baseline/schema.sql` when the database
   * holds no application tables, then migrate on top as usual. A no-op against
   * a provisioned database. A marked interrupted initialization resumes under the lock.
   * Mutually exclusive with `baselineThrough`, which records without executing
   * and would leave an empty database claiming to be migrated.
   */
  initSchema?: boolean;
  /** Override the baseline location; defaults to `defaultBaselineFile()`. */
  baselineFile?: string;
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

/**
 * The baseline sits beside this module in both layouts for the same reason
 * `migrations/` does: `src/db/baseline` under tsx, `dist/baseline` in the image,
 * where `scripts/build.ts` copies it next to the bundle. Resolving it any other
 * way is how you ship a command that works in a checkout and throws in the
 * container.
 */
export function defaultBaselineFile(): string {
  return resolve(import.meta.dirname, 'baseline', 'schema.sql');
}

/** Parsed the same way a migration is, so both paths agree on statement splitting. */
export async function loadBaseline(file?: string): Promise<string[]> {
  const path = file?.trim() || defaultBaselineFile();
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (cause) {
    throw new Error(`baseline schema is unreadable: ${path}`, { cause });
  }
  const statements = splitSqlStatements(raw);
  if (statements.length === 0) throw new Error(`baseline schema contains no statements: ${path}`);
  return statements;
}

/**
 * Every table in the current database except the runner's own ledger. The ledger
 * is excluded because a `--check` or an aborted earlier run can create it before
 * any schema exists — treating it as "the database is populated" would make
 * init unreachable exactly when it is needed.
 */
async function applicationTables(conn: PoolConnection): Promise<string[]> {
  const [rows] = await conn.query<RowDataPacket[]>(
    'SELECT TABLE_NAME AS name FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE()',
  );
  return rows.map((row) => String(row.name)).filter((name) => name !== LEDGER_TABLE);
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
export async function migrationStatus(pool: MigrationPool, dir?: string): Promise<MigrationState[]> {
  const files = await loadMigrations(dir);
  const conn = await pool.getConnection();
  try {
    const ledger = (await ledgerExists(conn)) ? await readLedger(conn) : new Map<string, LedgerRow>();
    if (ledger.has(BASELINE_PROGRESS)) {
      throw new Error('baseline initialization is unfinished; run migrate --init-schema with the original baseline');
    }
    return buildStates(files, ledger);
  } finally {
    conn.release();
  }
}

export async function runMigrations(
  pool: MigrationPool,
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
  const initSchema = options.initSchema === true;
  if (initSchema && baselineThrough) {
    // --baseline records without executing. Against the empty database
    // --init-schema exists for, it would mark every migration applied over a
    // schema that was never created.
    throw new Error('--init-schema cannot be combined with --baseline');
  }
  const reapply = new Set(options.reapply ?? []);
  for (const version of reapply) {
    if (!files.some((file) => file.version === version)) {
      throw new Error(`--reapply ${version} does not match any migration version`);
    }
  }
  // Read before taking the lock so a missing artifact fails fast and loudly
  // rather than after a lock acquisition that can block for two minutes.
  const baselineStatements = initSchema ? await loadBaseline(options.baselineFile) : null;

  const conn = await pool.getConnection();
  try {
    const lockName = await resolveLockName(conn);
    await acquireLock(conn, lockName, lockTimeout);
    try {
      const ledgerCreated = !(await ledgerExists(conn));
      const ledger = ledgerCreated ? new Map<string, LedgerRow>() : await readLedger(conn);
      const progress = ledger.get(BASELINE_PROGRESS);
      if (progress && !baselineStatements) {
        throw new Error('baseline initialization is unfinished; run migrate --init-schema with the original baseline');
      }
      const baseline = baselineStatements
        ? await applyBaseline(conn, baselineStatements, progress, ledger.size > 0, { dryRun, logger, ledgerMissing: ledgerCreated })
        : null;
      if (ledgerCreated && !dryRun && !baseline?.applied) await createLedger(conn);
      ledger.delete(BASELINE_PROGRESS);

      const report: MigrationReport = {
        ledgerCreated,
        baseline,
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
      await releaseLock(conn, lockName, logger);
    }
  } finally {
    conn.release();
  }
}

// A successful acknowledgement advances the marker. A missing acknowledgement
// leaves it at the preceding boundary, including the exact schema observed there.
const createTablePattern = /^CREATE TABLE `?(\w+)`?\s*\(/i;
const changedTablePattern = /^(?:ALTER TABLE|CREATE (?:UNIQUE )?INDEX `?\w+`? ON) `?(\w+)`?\s/i;

async function tableDefinition(conn: PoolConnection, table: string): Promise<string> {
  const quoted = '`' + table.replaceAll('`', '``') + '`';
  const [rows] = await conn.query<RowDataPacket[]>(`SHOW CREATE TABLE ${quoted}`);
  const ddl = rows[0]?.['Create Table'];
  if (typeof ddl !== 'string') throw new Error(`cannot verify baseline table ${table}`);
  return ddl;
}

function definitionDigest(ddl: string): string {
  // Exclude the table name so a connection-private CREATE can verify the same
  // definition. A row insert changes AUTO_INCREMENT without changing the DDL.
  return sha256(ddl.replace(/^CREATE (?:TEMPORARY )?TABLE `(?:``|[^`])+`/, 'CREATE TABLE')
    .replace(/^(\) ENGINE=.*?) AUTO_INCREMENT=\d+(?= |$)/m, '$1'));
}

async function schemaDigests(conn: PoolConnection, tables: string[]): Promise<Map<string, string>> {
  const digests = new Map<string, string>();
  for (const table of tables) digests.set(table, definitionDigest(await tableDefinition(conn, table)));
  return digests;
}

function schemaDigest(digests: Map<string, string>): string {
  return sha256(JSON.stringify([...digests].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)));
}

async function checkpointBaseline(conn: PoolConnection, checksum: string, schema: string, offset: number): Promise<void> {
  await conn.query(
    `INSERT INTO ${LEDGER_TABLE} (version, name, checksum, statements, duration_ms, applied_at, applied_by)
       VALUES (?, ?, ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE name=VALUES(name), statements=VALUES(statements),
       applied_at=VALUES(applied_at)`,
    [BASELINE_PROGRESS, schema, checksum, offset, 0, nowIso(), 'init-schema'],
  );
}

// Compare the definition of an already-committed CREATE TABLE with a
// connection-private probe. Index/constraint additions can instead be removed
// from the server's canonical SHOW CREATE text in memory. The entire preceding
// schema must match, including the rest of the affected table.
async function verifiesCommittedDdl(
  conn: PoolConnection, statement: string, current: Map<string, string>, expectedBefore: string,
): Promise<boolean> {
  const previous = new Map(current);
  const create = createTablePattern.exec(statement);
  if (create) {
    const table = create[1]!;
    if (!previous.delete(table) || schemaDigest(previous) !== expectedBefore) return false;
    const probe = '__cxx_baseline_definition_probe';
    await conn.query(statement.replace(create[0], `CREATE TEMPORARY TABLE \`${probe}\` (`));
    try {
      return definitionDigest(await tableDefinition(conn, probe)) === current.get(table);
    } finally {
      await conn.query(`DROP TEMPORARY TABLE \`${probe}\``);
    }
  }
  const index = /^CREATE (UNIQUE )?INDEX (`\w+`) ON `(\w+)` (\([`\w, ]+\))$/i.exec(statement);
  const fk = /^ALTER TABLE `(\w+)` ADD (CONSTRAINT (`\w+`) FOREIGN KEY (\([`\w, ]+\)) REFERENCES .+)$/i.exec(statement);
  const table = index?.[3] ?? fk?.[1];
  if (!table || !current.has(table)) return false;
  const clause = index ? `${index[1] ?? ''}KEY ${index[2]} ${index[4]}` : fk![2]!;
  const normalize = (line: string) => line.trim().replace(/\s*\(\s*/g, '(')
    .replace(/,\s*/g, ',').replace(/ ON (UPDATE|DELETE) NO ACTION/gi, '')
    .replace(/\b(cascade|restrict|set null)\b/gi, word => word.toUpperCase());
  const lines = (await tableDefinition(conn, table)).split('\n');
  const end = lines.findIndex(line => line.startsWith(')'));
  if (end < 2) return false;
  const elements = lines.slice(1, end).map(line => line.replace(/,$/, ''));
  const remaining = elements.filter(line => normalize(line) !== normalize(clause));
  if (remaining.length !== elements.length - 1) return false;
  const matchesPrior = (body: string[]) => {
    const ddl = [lines[0]!, body.join(',\n'), ...lines.slice(end)].join('\n');
    previous.set(table, definitionDigest(ddl));
    return schemaDigest(previous) === expectedBefore;
  };
  if (matchesPrior(remaining)) return true;
  // InnoDB can install a same-named supporting index with the foreign key.
  const support = fk && normalize(`KEY ${fk[3]} ${fk[4]}`);
  return !!support && matchesPrior(remaining.filter(line => normalize(line) !== support));
}

async function applyBaseline(
  conn: PoolConnection,
  statements: string[],
  progress: LedgerRow | undefined,
  hasLedgerHistory: boolean,
  ctx: { dryRun: boolean; logger: MigrationLogger; ledgerMissing: boolean },
): Promise<BaselineOutcome> {
  const started = Date.now();
  const existing = await applicationTables(conn);
  const checksum = sha256(JSON.stringify(statements));
  const declared = statements.flatMap(statement => createTablePattern.exec(statement)?.[1] ?? []);
  if (!progress && !existing.length && hasLedgerHistory) {
    throw new Error('migration history exists but the application schema is empty; inspect the ledger before initialization');
  }
  if (!progress && existing.length > 0) {
    // A pre-ledger installation may predate tables introduced in the current
    // baseline. Its operator can explicitly adopt it with the ordinary migrator.
    if (!hasLedgerHistory && declared.some(table => table !== LEDGER_TABLE && !existing.includes(table))) {
      throw new Error('unmarked partial schema: --init-schema cannot distinguish an interrupted install from an older database; inspect the schema before explicit migration/adoption');
    }
    const reason = `schema already present (${existing.length} table(s))`;
    ctx.logger.info({ tables: existing.length }, `baseline skipped: ${reason}`);
    return { applied: false, reason, statements: 0, durationMs: 0 };
  }
  if (progress && (progress.checksum !== checksum || !Number.isInteger(progress.statements)
    || progress.statements < 0 || progress.statements > statements.length)) {
    throw new Error('unfinished baseline does not match its checkpoint; use the original baseline artifact');
  }
  let offset = progress?.statements ?? 0;
  let digests = await schemaDigests(conn, existing);
  if (progress && schemaDigest(digests) !== progress.name) {
    const statement = statements[offset] ?? '';
    const verified = !ctx.dryRun && await verifiesCommittedDdl(conn, statement, digests, progress.name);
    if (!verified) {
      throw new Error(`baseline schema differs at statement ${offset + 1}; effect uncertain, inspect the schema and checkpoint before continuing`);
    }
    offset++;
    await checkpointBaseline(conn, checksum, schemaDigest(digests), offset);
  }
  if (ctx.dryRun) {
    return { applied: false, reason: 'dry run: baseline would be applied or resumed',
      statements: statements.length - offset, durationMs: 0 };
  }
  if (ctx.ledgerMissing) await createLedger(conn);
  if (!progress) await checkpointBaseline(conn, checksum, schemaDigest(digests), 0);
  const startOffset = offset;
  while (offset < statements.length) {
    const statement = statements[offset]!;
    const created = createTablePattern.exec(statement)?.[1];
    const target = created ?? changedTablePattern.exec(statement)?.[1];
    if (/^(INSERT|UPDATE|DELETE) /i.test(statement)) {
      // Row changes and their acknowledgement can commit atomically. If COMMIT
      // loses its reply, the next connection reads either both or neither.
      await conn.beginTransaction();
      try {
        await conn.query(statement);
        await checkpointBaseline(conn, checksum, schemaDigest(digests), offset + 1);
        await conn.commit();
      } catch (cause) {
        try { await conn.rollback(); } catch { conn.destroy(); }
        throw new MigrationFailure('baseline/schema.sql', offset + 1, statements.length, statement, cause);
      }
      offset++;
      continue;
    }
    // A SET/PREPARE/EXECUTE/DEALLOCATE sequence uses connection-local state.
    // Its guarded schema conversions form a single retry boundary.
    const sessionBlock = /^(SET |PREPARE |EXECUTE |DEALLOCATE )/i.test(statement);
    try {
      do {
        const sql = statements[offset]!;
        if (created !== LEDGER_TABLE) await conn.query(sql);
        offset++;
      } while (sessionBlock && offset < statements.length && /^(SET |PREPARE |EXECUTE |DEALLOCATE )/i.test(statements[offset]!));
    } catch (cause) {
      throw new MigrationFailure('baseline/schema.sql', offset + 1, statements.length, statements[offset]!, cause);
    }
    if (target && target !== LEDGER_TABLE) digests.set(target, definitionDigest(await tableDefinition(conn, target)));
    else if (!target) digests = await schemaDigests(conn, await applicationTables(conn));
    await checkpointBaseline(conn, checksum, schemaDigest(digests), offset);
  }
  await conn.query(`DELETE FROM ${LEDGER_TABLE} WHERE version = ?`, [BASELINE_PROGRESS]);
  return { applied: true, reason: progress ? 'resumed baseline/schema.sql' : 'created from baseline/schema.sql',
    statements: statements.length - startOffset, durationMs: Date.now() - started };
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
    `SELECT version, name, checksum, applied_at, applied_by, statements FROM ${LEDGER_TABLE}`,
  );
  const ledger = new Map<string, LedgerRow>();
  for (const row of rows) {
    ledger.set(String(row.version), {
      version: String(row.version),
      statements: Number(row.statements),
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
    if (row.version === BASELINE_PROGRESS || known.has(row.version)) continue;
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

async function resolveLockName(conn: PoolConnection): Promise<string> {
  const [rows] = await conn.query<RowDataPacket[]>('SELECT DATABASE() AS db');
  return migrationLockName(String(rows[0]?.db ?? ''));
}

async function acquireLock(conn: PoolConnection, lockName: string, timeoutSeconds: number): Promise<void> {
  const [rows] = await conn.query<RowDataPacket[]>('SELECT GET_LOCK(?, ?) AS acquired', [
    lockName,
    timeoutSeconds,
  ]);
  const acquired = rows[0]?.acquired ?? null;
  // GET_LOCK is 1 on success, 0 on timeout, NULL on error — and NULL coerces to
  // 0, so the three cases have to be separated before any numeric compare.
  if (acquired === null) {
    throw new Error(`migration lock ${lockName} could not be evaluated (GET_LOCK returned NULL)`);
  }
  if (Number(acquired) === 1) return;
  throw new Error(
    `another process holds the migration lock ${lockName} (waited ${timeoutSeconds}s); ` +
      'retry once it finishes',
  );
}

async function releaseLock(conn: PoolConnection, lockName: string, logger: MigrationLogger): Promise<void> {
  try {
    await conn.query('SELECT RELEASE_LOCK(?)', [lockName]);
  } catch (err) {
    // The connection goes back to the pool either way; MySQL drops the lock
    // when the session ends, so this is noise rather than a failure.
    logger.warn({ err: String(err) }, 'failed to release the migration lock');
  }
}
