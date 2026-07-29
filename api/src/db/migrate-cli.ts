/**
 * Migration CLI — `npm run migrate` in a checkout, `node dist/migrate.js` in
 * the image (same bundle, same `dist/migrations` directory as the server).
 *
 * `scripts/deploy.sh` runs it between `build` and `up` so schema changes land
 * before any listener opens, then again with `--check` afterwards to prove the
 * running image has nothing pending. API boot applies migrations too, which
 * covers cold starts and out-of-band restarts.
 */

import pino from 'pino';
import { loadEnv } from '../env.js';
import { createDb } from './client.js';
import { loggerOptions } from '../util/log.js';
import { migrationStatus, runMigrations } from './migrator.js';
import { formatStates, parseArgs, USAGE } from './migrate-cli-args.js';

function out(text: string): void {
  process.stdout.write(text.endsWith('\n') ? text : `${text}\n`);
}

async function main(): Promise<number> {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    out(USAGE);
    return 0;
  }

  const env = loadEnv();
  const { pool } = createDb(env);
  const dir = env.MIGRATIONS_DIR;

  // The CLI's own output is the report; keep the pino stream on stderr so
  // `--json` stdout stays parseable.
  const logger = pino({ ...loggerOptions(env), base: { app: 'codex-orchestrator-migrate' } }, process.stderr);

  try {
    if (options.check || options.list) {
      const states = await migrationStatus(pool, dir);
      const pending = states.filter((state) => state.status === 'pending');
      const drifted = states.filter((state) => state.status === 'drifted');
      if (options.json) {
        out(JSON.stringify({ states, pending: pending.length, drifted: drifted.length }, null, 2));
      } else {
        out(formatStates(states));
        out(`  → ${states.filter((s) => s.status === 'applied').length} applied, ${pending.length} pending, ${drifted.length} drifted`);
      }
      return options.check && pending.length > 0 ? 1 : 0;
    }

    const report = await runMigrations(pool, {
      dir,
      logger,
      appliedBy: 'cli',
      dryRun: options.dryRun,
      baselineThrough: options.baseline,
      reapply: options.reapply,
      lockTimeoutSeconds: options.lockTimeout ?? env.MIGRATIONS_LOCK_TIMEOUT,
    });

    if (options.json) {
      out(JSON.stringify(report, null, 2));
      return 0;
    }

    if (report.outcomes.length === 0) {
      out(`nothing to do: ${report.alreadyApplied} migration(s) already applied`);
    } else {
      for (const outcome of report.outcomes) {
        out(`  ${outcome.action.padEnd(10)} ${outcome.filename} (${outcome.statements} statement(s), ${outcome.durationMs}ms)`);
      }
      const tally = (['applied', 'reapplied', 'baselined'] as const)
        .map((action) => [action, report.outcomes.filter((o) => o.action === action).length] as const)
        .filter(([, count]) => count > 0)
        .map(([action, count]) => `${count} ${report.dryRun ? `to be ${action}` : action}`)
        .join(', ');
      out(`${tally}; ${report.alreadyApplied} already up to date`);
    }
    for (const drifted of report.drifted) {
      out(`  WARNING ${drifted.filename} changed since it was applied — re-run with --reapply ${drifted.version} to execute the edit`);
    }
    return 0;
  } finally {
    await pool.end();
  }
}

try {
  process.exit(await main());
} catch (err) {
  process.stderr.write(`${err instanceof Error ? err.stack || err.message : String(err)}\n`);
  process.exit(1);
}
