import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs, formatStates, USAGE } from '../../../src/db/migrate-cli-args.js';
import { type MigrationState } from '../../../src/db/migrator.js';

/**
 * The CLI's flag surface is a deployment contract: `scripts/deploy.sh` and the
 * `db` job in `.github/workflows/api.yml` invoke it unattended, and
 * `--baseline VERSION` is the documented adoption path for a hand-migrated
 * database — parse it wrong and a live database replays its whole history.
 */

const README = resolve(import.meta.dirname, '../../../src/db/README.md');

const state = (over: Partial<MigrationState>): MigrationState => ({
  version: '0001',
  name: 'init',
  filename: '0001_init.sql',
  status: 'applied',
  checksum: 'aa',
  appliedChecksum: 'aa',
  appliedAt: null,
  statements: 3,
  ...over,
});

describe('parseArgs', () => {
  it('defaults to a plain migrate run on empty argv', () => {
    expect(parseArgs([])).toEqual({
      check: false,
      list: false,
      dryRun: false,
      json: false,
      help: false,
      baseline: null,
      reapply: [],
      lockTimeout: undefined,
    });
  });

  it.each([
    ['--check', 'check'],
    ['--list', 'list'],
    ['--dry-run', 'dryRun'],
    ['--json', 'json'],
  ] as const)('%s sets %s', (flag, key) => {
    expect(parseArgs([flag])[key]).toBe(true);
  });

  it('captures the version given to --baseline', () => {
    expect(parseArgs(['--baseline', '0006']).baseline).toBe('0006');
  });

  it('accumulates every --reapply version', () => {
    expect(parseArgs(['--reapply', '0003']).reapply).toEqual(['0003']);
    expect(parseArgs(['--reapply', '0003', '--reapply', '0006']).reapply).toEqual(['0003', '0006']);
  });

  it('accepts a positive --lock-timeout', () => {
    expect(parseArgs(['--lock-timeout', '300']).lockTimeout).toBe(300);
  });

  it('rejects a --lock-timeout that is not a positive number', () => {
    expect(() => parseArgs(['--lock-timeout', '0'])).toThrow('--lock-timeout must be > 0');
    expect(() => parseArgs(['--lock-timeout', 'soon'])).toThrow('--lock-timeout must be > 0');
    // A negative is rejected one step earlier: `value()` refuses any following
    // token that starts with `-`, so it never reaches the numeric guard.
    expect(() => parseArgs(['--lock-timeout', '-5'])).toThrow('--lock-timeout requires a value');
  });

  it('rejects a value-taking flag with nothing after it', () => {
    expect(() => parseArgs(['--baseline'])).toThrow('--baseline requires a value');
  });

  it('rejects a value-taking flag followed by another flag', () => {
    expect(() => parseArgs(['--reapply', '--json'])).toThrow('--reapply requires a value');
  });

  it('sets help for both spellings', () => {
    expect(parseArgs(['-h']).help).toBe(true);
    expect(parseArgs(['--help']).help).toBe(true);
  });

  it('rejects an unknown option', () => {
    expect(() => parseArgs(['--nope'])).toThrow('unknown option: --nope');
  });
});

/**
 * `src/db/README.md` is where an operator looks before running this against a
 * production database, so a flag documented there and dropped here (or renamed)
 * would be a silent break. Both directions are checked: the parser accepts it,
 * and `--help` still describes it.
 */
describe('documented flags', () => {
  /** `` `--baseline VERSION` `` → the flag, plus its value placeholder if any. */
  const FLAG = /`(--[a-z-]+)( [A-Z]+)?`/g;

  const documented = (): [string, boolean][] => {
    const readme = readFileSync(README, 'utf8');
    const paragraph = /^Useful flags:[\s\S]*?(?=\n\n)/m.exec(readme);
    if (!paragraph) throw new Error(`no 'Useful flags' paragraph in ${README}`);
    return [...paragraph[0].matchAll(FLAG)].map((match) => [match[1]!, match[2] !== undefined]);
  };

  it('finds the documented set', () => {
    expect(documented().map(([flag]) => flag)).toEqual([
      '--check',
      '--list',
      '--dry-run',
      '--json',
      '--baseline',
      '--reapply',
      '--lock-timeout',
      '--help',
    ]);
  });

  it('accepts every flag the README spells, and documents it in --help', () => {
    for (const [flag, takesValue] of documented()) {
      // `0001` reads as a version for --baseline/--reapply and as 1 second for
      // --lock-timeout, so one placeholder serves all three.
      expect(() => parseArgs(takesValue ? [flag, '0001'] : [flag])).not.toThrow();
      expect(USAGE).toContain(flag);
    }
  });
});

describe('formatStates', () => {
  it('renders an applied/pending/drifted mix aligned on the longest filename', () => {
    const rendered = formatStates([
      state({ appliedAt: '2026-07-27T10:00:00Z' }),
      state({ version: '0002', name: 'hosts', filename: '0002_hosts.sql', status: 'pending' }),
      state({
        version: '0003',
        name: 'auth',
        filename: '0003_auth.sql',
        status: 'drifted',
        appliedChecksum: 'bb',
        appliedAt: '2026-07-28T11:00:00Z',
      }),
    ]);

    expect(rendered.split('\n')).toEqual([
      '  applied  0001_init.sql  applied_at=2026-07-27T10:00:00Z',
      '  pending  0002_hosts.sql',
      '  drifted  0003_auth.sql  applied_at=2026-07-28T11:00:00Z',
    ]);
  });

  it('names a ledger version this build ships no file for', () => {
    const rendered = formatStates([
      state({
        version: '0009',
        name: 'gone',
        filename: null,
        status: 'orphaned',
        checksum: null,
        appliedAt: '2026-07-20T09:00:00Z',
      }),
    ]);

    expect(rendered).toBe('  orphaned 0009 (no file) applied_at=2026-07-20T09:00:00Z');
  });
});
