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
import { migrationStatus, runMigrations, type MigrationState } from './migrator.js';

const USAGE = `Usage: node dist/migrate.js [options]

Applies every pending migration in db/migrations to the configured database.
Without options it migrates and exits 0 when the schema is up to date.

Options:
  --check              Report status and exit 1 if anything is pending. Drift is
                       reported but does not fail the check. No writes.
  --list               Print the ledger versus the shipped files. No writes.
  --dry-run            Report what would be applied. No writes.
  --baseline VERSION   Record migrations up to VERSION as applied WITHOUT running
                       them. Adoption path for a database migrated by hand.
  --reapply VERSION    Execute VERSION again even if the ledger says it is
                       applied. Repeatable. Use after editing a migration.
  --lock-timeout SECS  Seconds to wait for the migration lock (default 120).
  --json               Machine-readable output.
  -h, --help           This text.
`;

interface Options {
  check: boolean;
  list: boolean;
  dryRun: boolean;
  json: boolean;
  help: boolean;
  baseline: string | null;
  reapply: string[];
  lockTimeout: number | undefined;
}

function parseArgs(argv: string[]): Options {
  const options: Options = {
    check: false,
    list: false,
    dryRun: false,
    json: false,
    help: false,
    baseline: null,
    reapply: [],
    lockTimeout: undefined,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    const value = (): string => {
      const next = argv[index + 1];
      if (next === undefined || next.startsWith('-')) throw new Error(`${arg} requires a value`);
      index += 1;
      return next;
    };

    switch (arg) {
      case '--check':
        options.check = true;
        break;
      case '--list':
        options.list = true;
        break;
      case '--dry-run':
        options.dryRun = true;
        break;
      case '--json':
        options.json = true;
        break;
      case '--baseline':
        options.baseline = value();
        break;
      case '--reapply':
        options.reapply.push(value());
        break;
      case '--lock-timeout': {
        const parsed = Number(value());
        if (!Number.isFinite(parsed) || parsed <= 0) throw new Error('--lock-timeout must be > 0');
        options.lockTimeout = parsed;
        break;
      }
      case '-h':
      case '--help':
        options.help = true;
        break;
      default:
        throw new Error(`unknown option: ${arg}`);
    }
  }

  return options;
}

function out(text: string): void {
  process.stdout.write(text.endsWith('\n') ? text : `${text}\n`);
}

function formatStates(states: MigrationState[]): string {
  const width = Math.max(...states.map((state) => (state.filename ?? state.version).length), 9);
  const lines = states.map((state) => {
    const label = (state.filename ?? `${state.version} (no file)`).padEnd(width);
    const applied = state.appliedAt ? ` applied_at=${state.appliedAt}` : '';
    return `  ${state.status.padEnd(8)} ${label}${applied}`;
  });
  return lines.join('\n');
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
