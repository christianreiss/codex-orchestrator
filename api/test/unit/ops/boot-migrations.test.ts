import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { resolve } from 'node:path';
import type { Pool } from 'mysql2/promise';
import type { Env } from '../../../src/env.js';
import type {
  MigrationReport,
  MigrationState,
  MigrationStatusKind,
} from '../../../src/db/migrator.js';

/**
 * The boot wrapper around the migrator: which way it fails, and whether the
 * failure survives as something `scripts/deploy.sh` can find.
 * `test/unit/db/migrator-run.test.ts` owns the runner's own decisions; here the
 * migrator is a stub, because the questions are "does an unmigrated schema stop
 * the boot" and "does the reason reach the log in the wording deploy.sh greps".
 */

interface LogLine {
  level: 'info' | 'warn' | 'error';
  payload: Record<string, unknown>;
  message: string;
}

const migrator = vi.hoisted(() => ({
  migrationStatus: vi.fn(),
  runMigrations: vi.fn(),
}));

vi.mock('../../../src/db/migrator.js', () => migrator);

// Boot happens before Fastify exists, so the module builds its own pino; this
// stands in for it and keeps every line it writes.
const log = vi.hoisted(() => {
  const lines: LogLine[] = [];
  const at = (level: LogLine['level']) => (payload: Record<string, unknown>, message: string) => {
    lines.push({ level, payload, message });
  };
  return {
    lines,
    factory: vi.fn(() => ({ info: at('info'), warn: at('warn'), error: at('error') })),
  };
});

vi.mock('pino', () => ({ default: log.factory }));

import { runBootMigrations } from '../../../src/ops/boot-migrations.js';

/**
 * The alternation `scripts/deploy.sh` scans the post-deploy container logs
 * with. Parsed rather than copied: the whole point of the failure line's
 * wording is that this grep catches it, and a reword on either side has to
 * break something.
 */
const CRITICAL_LOG_PATTERN = (() => {
  const deploySh = readFileSync(resolve(import.meta.dirname, '../../../../scripts/deploy.sh'), 'utf8');
  const grep = /grep\s+-Ei\s+'([^']+)'/.exec(deploySh);
  if (!grep) throw new Error('scripts/deploy.sh no longer scans the deploy logs with `grep -Ei`');
  return new RegExp(grep[1]!, 'i');
})();

const pool = {} as Pool;

const envWith = (overrides: Partial<Env>): Env =>
  ({
    NODE_ENV: 'test',
    APP_ENV: 'test',
    LOG_LEVEL: 'info',
    LOG_PRETTY: false,
    MIGRATIONS_DIR: '/srv/api/migrations',
    MIGRATIONS_LOCK_TIMEOUT: 45,
    ...overrides,
  }) as Env;

const state = (version: string, filename: string, status: MigrationStatusKind): MigrationState => ({
  version,
  name: filename.replace(/^\d+_|\.sql$/g, ''),
  filename,
  status,
  checksum: 'a'.repeat(64),
  appliedChecksum: status === 'pending' ? null : 'a'.repeat(64),
  appliedAt: status === 'pending' ? null : '2026-07-27T00:00:00Z',
  statements: 1,
});

const report = (overrides: Partial<MigrationReport> = {}): MigrationReport => ({
  ledgerCreated: false,
  outcomes: [],
  drifted: [],
  orphaned: [],
  alreadyApplied: 0,
  dryRun: false,
  ...overrides,
});

const linesAt = (level: LogLine['level']): LogLine[] => log.lines.filter((line) => line.level === level);

beforeEach(() => {
  vi.clearAllMocks();
  log.lines.length = 0;
});

describe('runBootMigrations with RUN_MIGRATIONS_ON_BOOT off', () => {
  // The `shared_memory_*` failure mode: serving requests against a schema the
  // code does not expect, because 0006 was never applied by hand.
  it('aborts the boot when a migration is pending, naming the files', async () => {
    const env = envWith({ RUN_MIGRATIONS_ON_BOOT: false });
    migrator.migrationStatus.mockResolvedValue([
      state('0005', '0005_hosts.sql', 'applied'),
      state('0006', '0006_shared_memory.sql', 'pending'),
      state('0007', '0007_runner_telemetry.sql', 'pending'),
    ]);

    const thrown: unknown = await runBootMigrations(env, pool).then(
      () => null,
      (err: unknown) => err,
    );

    expect(thrown).toBeInstanceOf(Error);
    const message = (thrown as Error).message;
    expect(message).toContain('2 database migration(s) pending while RUN_MIGRATIONS_ON_BOOT is off');
    expect(message).toContain('0006_shared_memory.sql, 0007_runner_telemetry.sql');
    expect(message).not.toContain('0005_hosts.sql');
    expect(message).toContain('node dist/migrate.js');

    // Off means off: the schema is reported on, never converged.
    expect(migrator.migrationStatus).toHaveBeenCalledWith(pool, '/srv/api/migrations');
    expect(migrator.runMigrations).not.toHaveBeenCalled();
    expect(linesAt('error').map((line) => line.payload.err)).toEqual([message]);
  });

  it('starts quietly, and says so, when nothing is pending', async () => {
    const env = envWith({ RUN_MIGRATIONS_ON_BOOT: false });
    migrator.migrationStatus.mockResolvedValue([
      state('0005', '0005_hosts.sql', 'applied'),
      state('0006', '0006_shared_memory.sql', 'applied'),
    ]);

    await expect(runBootMigrations(env, pool)).resolves.toBeUndefined();

    expect(migrator.runMigrations).not.toHaveBeenCalled();
    expect(linesAt('info')).toEqual([
      {
        level: 'info',
        payload: { migrations: 'skipped' },
        message: 'RUN_MIGRATIONS_ON_BOOT is off and no migration is pending',
      },
    ]);
    expect(linesAt('error')).toEqual([]);
  });
});

describe('runBootMigrations with RUN_MIGRATIONS_ON_BOOT on', () => {
  it('hands the migrator the configured dir, a boot applier and the lock timeout', async () => {
    const env = envWith({ RUN_MIGRATIONS_ON_BOOT: true });
    migrator.runMigrations.mockResolvedValue(
      report({
        ledgerCreated: true,
        outcomes: [
          { version: '0006', filename: '0006_shared_memory.sql', action: 'applied', statements: 4, durationMs: 12 },
          { version: '0007', filename: '0007_runner_telemetry.sql', action: 'applied', statements: 2, durationMs: 3 },
        ],
        alreadyApplied: 5,
        drifted: [state('0004', '0004_sessions.sql', 'drifted')],
      }),
    );

    await runBootMigrations(env, pool);

    expect(migrator.migrationStatus).not.toHaveBeenCalled();
    expect(migrator.runMigrations).toHaveBeenCalledOnce();
    const [passedPool, options] = migrator.runMigrations.mock.calls[0] as [Pool, Record<string, unknown>];
    expect(passedPool).toBe(pool);
    expect(options.dir).toBe('/srv/api/migrations');
    expect(options.lockTimeoutSeconds).toBe(45);
    // Forensics on a fleet: the ledger row has to name the container that wrote it.
    expect(options.appliedBy).toBe(`boot@${hostname()}`);
    expect(String(options.appliedBy).startsWith('boot@')).toBe(true);

    expect(linesAt('info')).toEqual([
      {
        level: 'info',
        payload: { applied: 2, alreadyApplied: 5, drifted: 1, ledgerCreated: true },
        message: 'database schema migrated',
      },
    ]);
  });

  it('reports an already-converged schema without claiming it migrated anything', async () => {
    const env = envWith({ RUN_MIGRATIONS_ON_BOOT: true });
    migrator.runMigrations.mockResolvedValue(report({ alreadyApplied: 7 }));

    await runBootMigrations(env, pool);

    expect(linesAt('info')).toEqual([
      {
        level: 'info',
        payload: { applied: 0, alreadyApplied: 7, drifted: 0, ledgerCreated: false },
        message: 'database schema already up to date',
      },
    ]);
    expect(linesAt('error')).toEqual([]);
  });

  // `restart: unless-stopped` turns the re-throw into a crash loop, so the one
  // line deploy.sh can still see is the whole diagnosis.
  it('logs a line deploy.sh greps for and re-throws the migrator error', async () => {
    const env = envWith({ RUN_MIGRATIONS_ON_BOOT: true });
    const failure = new Error('migration 0006_shared_memory.sql failed at statement 2/4: ER_DUP_KEYNAME (1061)');
    migrator.runMigrations.mockRejectedValue(failure);

    await expect(runBootMigrations(env, pool)).rejects.toBe(failure);

    const errors = linesAt('error');
    expect(errors).toHaveLength(1);
    expect(errors[0]!.payload).toEqual({ err: failure.message });
    expect(errors[0]!.message).toMatch(CRITICAL_LOG_PATTERN);
  });

  it('stringifies a non-Error rejection instead of logging an empty reason', async () => {
    const env = envWith({ RUN_MIGRATIONS_ON_BOOT: true });
    migrator.runMigrations.mockRejectedValue('lock wait timeout');

    await expect(runBootMigrations(env, pool)).rejects.toBe('lock wait timeout');

    expect(linesAt('error')[0]!.payload).toEqual({ err: 'lock wait timeout' });
  });
});
