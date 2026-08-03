/**
 * Argument parsing and report formatting for the migration CLI, kept apart from
 * `migrate-cli.ts` because that file ends in a top-level `process.exit` and so
 * cannot be imported by a test. The flag surface here is what `scripts/deploy.sh`,
 * `.github/workflows/api.yml` and `src/db/README.md` all spell out.
 */

import { type MigrationState } from './migrator.js';

export const USAGE = `Usage: node dist/migrate.js [options]

Applies every pending migration in db/migrations to the configured database.
Without options it migrates and exits 0 when the schema is up to date.

Options:
  --check              Report status and exit 1 if anything is pending. Drift is
                       reported but does not fail the check. No writes.
  --list               Print the ledger versus the shipped files. No writes.
  --dry-run            Report what would be applied. No writes.
  --init-schema        Create the starting schema from db/baseline/schema.sql
                       when the database holds no application tables, then
                       migrate on top. A no-op against a database that already
                       has them, so a fresh-install script can re-run safely.
  --baseline VERSION   Record migrations up to VERSION as applied WITHOUT running
                       them. Adoption path for a database migrated by hand.
  --reapply VERSION    Execute VERSION again even if the ledger says it is
                       applied. Repeatable. Use after editing a migration.
  --lock-timeout SECS  Seconds to wait for the migration lock (default 120).
  --json               Machine-readable output.
  -h, --help           This text.
`;

export interface Options {
  check: boolean;
  list: boolean;
  dryRun: boolean;
  json: boolean;
  help: boolean;
  initSchema: boolean;
  baseline: string | null;
  reapply: string[];
  lockTimeout: number | undefined;
}

export function parseArgs(argv: string[]): Options {
  const options: Options = {
    check: false,
    list: false,
    dryRun: false,
    json: false,
    help: false,
    initSchema: false,
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
      case '--init-schema':
        options.initSchema = true;
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

export function formatStates(states: MigrationState[]): string {
  const width = Math.max(...states.map((state) => (state.filename ?? state.version).length), 9);
  const lines = states.map((state) => {
    const label = (state.filename ?? `${state.version} (no file)`).padEnd(width);
    const applied = state.appliedAt ? ` applied_at=${state.appliedAt}` : '';
    return `  ${state.status.padEnd(8)} ${label}${applied}`;
  });
  return lines.join('\n');
}
