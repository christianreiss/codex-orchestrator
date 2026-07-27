import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { sql } from 'drizzle-orm';
import type { RowDataPacket } from 'mysql2/promise';
import {
  LEDGER_TABLE,
  loadMigrations,
  migrationStatus,
  runMigrations,
  type MigrationLogger,
} from '../../../src/db/migrator.js';
import { getTestDb } from '../../helpers/test-db.js';

/**
 * The only tests that exercise the migration runner against real MySQL, and the
 * only place the "every migration is idempotent" contract is actually enforced:
 * `db-fake` has no information_schema, no `PREPARE`, no `DELIMITER`, and no
 * advisory locks, so none of the interesting failure modes exist there. CI runs
 * without a database and skips this file. Run it with:
 *
 *   npm run test:db          (TEST_USE_DB=1 + DB_* env)
 *   TEST_DATABASE_URL=mysql://root:pw@127.0.0.1:3306/db \
 *     npx vitest run test/integration --no-file-parallelism
 *
 * `--no-file-parallelism` is not optional: every real-DB suite shares one
 * database, this one applies DDL to all of it, and other suites drop indexes on
 * purpose. Run in parallel they race — a guard here reads "index missing" and the
 * `EXECUTE` a moment later dies with ER_DUP_KEYNAME because another file put it
 * back. Production is protected by the runner's advisory lock; a test issuing raw
 * DDL is not.
 *
 * The suite owns the `schema_migrations` table in the target database: it drops
 * and rebuilds the ledger to cover baselining, and leaves it complete and
 * consistent at the end. It never drops a data table.
 */

const handle = await getTestDb();

/** Captures what the runner logged so drift warnings can be asserted. */
function recordingLogger(): MigrationLogger & { lines: Array<[string, Record<string, unknown>, string]> } {
  const lines: Array<[string, Record<string, unknown>, string]> = [];
  return {
    lines,
    info: (payload, message) => lines.push(['info', payload, message]),
    warn: (payload, message) => lines.push(['warn', payload, message]),
    error: (payload, message) => lines.push(['error', payload, message]),
  };
}

// Real DDL against a real server: the first full pass rebuilds tables and
// builds FULLTEXT indexes, and every information_schema guard costs a round
// trip. On a cold server that runs well past the suite's 20s default.
describe.skipIf(!handle)('migration runner against a real database', { timeout: 300_000 }, () => {
  // Bound in beforeAll, not here: vitest still runs a skipped describe's body to
  // collect it, so dereferencing a null handle at this level fails the file
  // instead of skipping it on a machine with no database.
  let pool: NonNullable<typeof handle>['pool'];
  let db: NonNullable<typeof handle>['db'];

  const scalar = async (query: string): Promise<unknown> => {
    const [rows] = await pool.query<RowDataPacket[]>(query);
    return Object.values(rows[0] ?? {})[0];
  };

  beforeAll(async () => {
    pool = handle!.pool;
    db = handle!.db;
    // Start from a known state: no ledger, schema possibly already migrated.
    await db.execute(sql.raw(`DROP TABLE IF EXISTS ${LEDGER_TABLE}`));
  });

  afterAll(async () => {
    await handle?.pool.end();
  });

  it('applies every shipped migration and records it in the ledger', async () => {
    const files = await loadMigrations();
    const logger = recordingLogger();

    const report = await runMigrations(pool, { logger, appliedBy: 'vitest', lockTimeoutSeconds: 30 });

    expect(report.ledgerCreated).toBe(true);
    expect(report.dryRun).toBe(false);
    expect(report.drifted).toEqual([]);
    expect(report.orphaned).toEqual([]);
    expect(report.outcomes.map((outcome) => outcome.version)).toEqual(files.map((file) => file.version));
    for (const outcome of report.outcomes) {
      expect(outcome.action).toBe('applied');
      expect(outcome.statements).toBeGreaterThan(0);
    }

    const rows = await pool.query<RowDataPacket[]>(
      `SELECT version, checksum, statements, applied_by FROM ${LEDGER_TABLE} ORDER BY version`,
    );
    expect(rows[0].map((row) => row.version)).toEqual(files.map((file) => file.version));
    expect(rows[0].map((row) => row.checksum)).toEqual(files.map((file) => file.checksum));
    expect(rows[0].every((row) => row.applied_by === 'vitest')).toBe(true);

    // The tables the runner is supposed to have produced.
    for (const table of ['claude_artifacts', 'coord_project_memories', 'shared_memories', 'shared_memory_chunks', 'shared_memory_revisions']) {
      await expect(db.execute(sql.raw(`SELECT 1 FROM ${table} LIMIT 0`))).resolves.toBeDefined();
    }
    // …including the FULLTEXT indexes `drizzle-kit push` cannot express.
    // STATISTICS carries one row per indexed column, hence DISTINCT.
    expect(
      await scalar(
        `SELECT COUNT(DISTINCT INDEX_NAME) FROM information_schema.STATISTICS
          WHERE TABLE_SCHEMA = DATABASE() AND INDEX_TYPE = 'FULLTEXT'
            AND INDEX_NAME IN ('idx_shared_memories_search', 'idx_shared_memory_chunks_search', 'idx_coord_project_memories_search')`,
      ),
    ).toBe(3);
    // …and the ON DELETE CASCADE foreign keys it cannot express either.
    expect(
      await scalar(
        `SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
          WHERE TABLE_SCHEMA = DATABASE() AND CONSTRAINT_TYPE = 'FOREIGN KEY'
            AND CONSTRAINT_NAME IN ('fk_shared_memory_chunks_memory', 'fk_shared_memory_revisions_memory')`,
      ),
    ).toBe(2);
  });

  it('is a no-op on the second run', async () => {
    const files = await loadMigrations();
    const report = await runMigrations(pool, { appliedBy: 'vitest', lockTimeoutSeconds: 30 });

    expect(report.ledgerCreated).toBe(false);
    expect(report.outcomes).toEqual([]);
    expect(report.alreadyApplied).toBe(files.length);

    const states = await migrationStatus(pool);
    expect(states.every((state) => state.status === 'applied')).toBe(true);
  });

  // The contract every migration has to keep: re-running one must not fail.
  // This is what stops the next 0002 (bare `ADD UNIQUE INDEX` → ER_DUP_KEYNAME)
  // from reaching a deploy.
  it('can re-apply every migration against an already-migrated schema', async () => {
    const files = await loadMigrations();
    const report = await runMigrations(pool, {
      appliedBy: 'vitest',
      lockTimeoutSeconds: 30,
      reapply: files.map((file) => file.version),
    });

    expect(report.outcomes.map((outcome) => outcome.action)).toEqual(files.map(() => 'reapplied'));
    expect(report.alreadyApplied).toBe(0);
  });

  it('reports drift without silently re-running the edited file', async () => {
    const [first] = await loadMigrations();
    await pool.query(`UPDATE ${LEDGER_TABLE} SET checksum = ? WHERE version = ?`, [
      'f'.repeat(64),
      first!.version,
    ]);

    const states = await migrationStatus(pool);
    expect(states.find((state) => state.version === first!.version)?.status).toBe('drifted');

    const logger = recordingLogger();
    const report = await runMigrations(pool, { logger, appliedBy: 'vitest', lockTimeoutSeconds: 30 });
    expect(report.drifted.map((state) => state.version)).toEqual([first!.version]);
    expect(report.outcomes).toEqual([]);
    expect(logger.lines.some(([level, , message]) => level === 'warn' && message.includes('no longer matches'))).toBe(true);

    // Ledger keeps the stale checksum until an operator asks for the re-run.
    expect(await scalar(`SELECT checksum FROM ${LEDGER_TABLE} WHERE version = '${first!.version}'`)).toBe(
      'f'.repeat(64),
    );

    const forced = await runMigrations(pool, {
      appliedBy: 'vitest',
      lockTimeoutSeconds: 30,
      reapply: [first!.version],
    });
    expect(forced.outcomes.map((outcome) => outcome.action)).toEqual(['reapplied']);
    expect(forced.drifted).toEqual([]);
    expect((await migrationStatus(pool)).every((state) => state.status === 'applied')).toBe(true);
  });

  it('flags a ledger row this build does not ship as orphaned', async () => {
    await pool.query(
      `INSERT INTO ${LEDGER_TABLE} (version, name, checksum, statements, duration_ms, applied_at, applied_by)
       VALUES ('9999', 'from_the_future', ?, 1, 0, ?, 'vitest')`,
      ['a'.repeat(64), new Date().toISOString()],
    );
    try {
      const states = await migrationStatus(pool);
      expect(states.find((state) => state.version === '9999')?.status).toBe('orphaned');
      const report = await runMigrations(pool, { appliedBy: 'vitest', lockTimeoutSeconds: 30 });
      expect(report.orphaned.map((state) => state.version)).toEqual(['9999']);
      expect(report.outcomes).toEqual([]);
    } finally {
      await pool.query(`DELETE FROM ${LEDGER_TABLE} WHERE version = '9999'`);
    }
  });

  // The adoption path for crane: a database migrated by hand for months, where
  // re-running the historical files is pointless work at best.
  it('baselines historical migrations without executing them', async () => {
    const files = await loadMigrations();
    const cutoff = files[files.length - 2]!.version;
    const last = files[files.length - 1]!;

    await db.execute(sql.raw(`DROP TABLE IF EXISTS ${LEDGER_TABLE}`));
    const report = await runMigrations(pool, {
      appliedBy: 'vitest',
      lockTimeoutSeconds: 30,
      baselineThrough: cutoff,
    });

    const baselined = report.outcomes.filter((outcome) => outcome.action === 'baselined');
    expect(baselined).toHaveLength(files.length - 1);
    expect(baselined.every((outcome) => outcome.statements === 0)).toBe(true);
    expect(report.outcomes.filter((outcome) => outcome.action === 'applied').map((o) => o.version)).toEqual([
      last.version,
    ]);
    expect(await scalar(`SELECT COUNT(*) FROM ${LEDGER_TABLE}`)).toBe(files.length);
    expect(await scalar(`SELECT applied_by FROM ${LEDGER_TABLE} WHERE version = '${files[0]!.version}'`)).toBe(
      'baseline:vitest',
    );

    await expect(
      runMigrations(pool, { baselineThrough: '0000_nope', lockTimeoutSeconds: 30 }),
    ).rejects.toThrow(/does not match any migration version/);
  });

  it('serialises concurrent runners and releases the lock', async () => {
    const files = await loadMigrations();
    await db.execute(sql.raw(`DROP TABLE IF EXISTS ${LEDGER_TABLE}`));

    const [a, b] = await Promise.all([
      runMigrations(pool, { appliedBy: 'vitest-a', lockTimeoutSeconds: 30 }),
      runMigrations(pool, { appliedBy: 'vitest-b', lockTimeoutSeconds: 30 }),
    ]);

    // Whoever got the lock first did all the work; the other found the ledger
    // already complete. Exactly one of them applied anything.
    const applied = [a, b].filter((report) => report.outcomes.length > 0);
    expect(applied).toHaveLength(1);
    expect(applied[0]!.outcomes).toHaveLength(files.length);
    expect(await scalar(`SELECT COUNT(*) FROM ${LEDGER_TABLE}`)).toBe(files.length);
    expect(await scalar(`SELECT IS_USED_LOCK('codex_orchestrator_schema_migrations')`)).toBeNull();
  });

  it('writes nothing in dry-run mode', async () => {
    const files = await loadMigrations();
    await db.execute(sql.raw(`DROP TABLE IF EXISTS ${LEDGER_TABLE}`));

    const report = await runMigrations(pool, { dryRun: true, lockTimeoutSeconds: 30 });
    expect(report.dryRun).toBe(true);
    expect(report.outcomes).toHaveLength(files.length);
    expect(await scalar(
      `SELECT COUNT(*) FROM information_schema.TABLES
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = '${LEDGER_TABLE}'`,
    )).toBe(0);

    // Leave the database with a complete, honest ledger.
    const restored = await runMigrations(pool, { appliedBy: 'vitest', lockTimeoutSeconds: 30 });
    expect(restored.outcomes).toHaveLength(files.length);
  });
});
