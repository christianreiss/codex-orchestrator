/**
 * Boot-time schema convergence, run before anything else touches the database.
 *
 * Fails closed in both directions: with `RUN_MIGRATIONS_ON_BOOT` on (the
 * default) a migration that cannot be applied aborts the boot, and with it off
 * a *pending* migration aborts the boot too. Serving a request against a schema
 * the code does not expect is the failure mode this whole thing exists to kill —
 * `shared_memory_*` calls erroring out because 0006 was never piped into the
 * container by hand is the canonical example.
 */

import { hostname } from 'node:os';
import pino from 'pino';
import type { Pool } from 'mysql2/promise';
import type { Env } from '../env.js';
import { loggerOptions } from '../util/log.js';
import { migrationStatus, runMigrations } from '../db/migrator.js';

export async function runBootMigrations(env: Env, pool: Pool): Promise<void> {
  // Fastify (and its logger) does not exist yet at this point in boot, so the
  // migrator gets its own pino writing the same shape to the same stream.
  const logger = pino({ ...loggerOptions(env), base: { app: 'codex-orchestrator-api', env: env.APP_ENV, phase: 'migrate' } });

  try {
    await migrate(env, pool, logger);
  } catch (err) {
    // `restart: unless-stopped` turns this into a crash loop, so the reason has
    // to survive as one greppable line — `scripts/deploy.sh` scans for exactly
    // this wording, and an uncaught throw out of a minified bundle does not.
    logger.error(
      { err: err instanceof Error ? err.message : String(err) },
      'migration failed; refusing to start',
    );
    throw err;
  }
}

async function migrate(env: Env, pool: Pool, logger: pino.Logger): Promise<void> {
  if (!env.RUN_MIGRATIONS_ON_BOOT) {
    const pending = (await migrationStatus(pool, env.MIGRATIONS_DIR)).filter(
      (state) => state.status === 'pending',
    );
    if (pending.length > 0) {
      const names = pending.map((state) => state.filename ?? state.version).join(', ');
      throw new Error(
        `${pending.length} database migration(s) pending while RUN_MIGRATIONS_ON_BOOT is off: ${names}. ` +
          'Apply them with `node dist/migrate.js` (or set RUN_MIGRATIONS_ON_BOOT=1).',
      );
    }
    logger.info({ migrations: 'skipped' }, 'RUN_MIGRATIONS_ON_BOOT is off and no migration is pending');
    return;
  }

  const report = await runMigrations(pool, {
    dir: env.MIGRATIONS_DIR,
    logger,
    appliedBy: `boot@${hostname()}`,
    lockTimeoutSeconds: env.MIGRATIONS_LOCK_TIMEOUT,
  });

  logger.info(
    {
      applied: report.outcomes.length,
      alreadyApplied: report.alreadyApplied,
      drifted: report.drifted.length,
      ledgerCreated: report.ledgerCreated,
    },
    report.outcomes.length > 0 ? 'database schema migrated' : 'database schema already up to date',
  );
}
