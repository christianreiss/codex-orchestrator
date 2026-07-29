import { describe, it, expect } from 'vitest';
import { readDbConfig } from '../../helpers/test-db.js';

/**
 * `readDbConfig()` is the only thing standing between the ordinary `npm test`
 * run and a real MySQL server: `vitest.config.ts` includes `test/**` wholesale,
 * so `test/integration/**` is always collected and skips only because
 * `getTestDb()` hands back null. Those suites drop the migration ledger and drop
 * indexes, and they need `--no-file-parallelism` to not race each other — none
 * of which the plain gate supplies. So an ambient `TEST_DATABASE_URL` in a
 * developer's shell must not be enough; `TEST_USE_DB=1` is the opt-in, on both
 * branches.
 */

const DB_KEYS = [
  'TEST_USE_DB',
  'TEST_DATABASE_URL',
  'DB_HOST',
  'DB_PORT',
  'DB_USERNAME',
  'DB_PASSWORD',
  'DB_DATABASE',
];

/** Calls readDbConfig() with exactly these DB env vars set (absent = unset). */
function configWith(env: Record<string, string | undefined>): ReturnType<typeof readDbConfig> {
  const saved = new Map<string, string | undefined>();
  for (const key of DB_KEYS) {
    saved.set(key, process.env[key]);
    const value = env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return readDbConfig();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

const URL_ONLY = 'mysql://tester:s%3Acret@db.example:3307/codex_probe';

describe('readDbConfig TEST_DATABASE_URL branch', () => {
  it('returns null without the TEST_USE_DB opt-in', () => {
    expect(configWith({ TEST_DATABASE_URL: URL_ONLY })).toBeNull();
  });

  it('returns null for TEST_USE_DB values that are not exactly "1"', () => {
    expect(configWith({ TEST_DATABASE_URL: URL_ONLY, TEST_USE_DB: '0' })).toBeNull();
    expect(configWith({ TEST_DATABASE_URL: URL_ONLY, TEST_USE_DB: 'true' })).toBeNull();
  });

  it('parses the URL when opted in', () => {
    const cfg = configWith({ TEST_DATABASE_URL: URL_ONLY, TEST_USE_DB: '1' });
    expect(cfg).toMatchObject({
      host: 'db.example',
      port: 3307,
      user: 'tester',
      password: 's:cret',
      database: 'codex_probe',
    });
  });

  it('falls back to localhost defaults for a URL that omits them', () => {
    const cfg = configWith({ TEST_DATABASE_URL: 'mysql://host.invalid/', TEST_USE_DB: '1' });
    expect(cfg).toMatchObject({ port: 3306, user: 'root', password: '', database: 'codex_test' });
  });

  it('returns null for a malformed URL even when opted in', () => {
    expect(configWith({ TEST_DATABASE_URL: 'not a url', TEST_USE_DB: '1' })).toBeNull();
  });

  it('does not fall through to the DB_* branch when the URL is malformed', () => {
    expect(
      configWith({
        TEST_DATABASE_URL: 'not a url',
        TEST_USE_DB: '1',
        DB_DATABASE: 'codex_test',
        DB_USERNAME: 'root',
      }),
    ).toBeNull();
  });
});

describe('readDbConfig DB_* branch', () => {
  it('reads the DB_* vars when opted in', () => {
    const cfg = configWith({
      TEST_USE_DB: '1',
      DB_HOST: 'db.example',
      DB_PORT: '3307',
      DB_USERNAME: 'tester',
      DB_PASSWORD: 'secret',
      DB_DATABASE: 'codex_probe',
    });
    expect(cfg).toMatchObject({
      host: 'db.example',
      port: 3307,
      user: 'tester',
      password: 'secret',
      database: 'codex_probe',
    });
  });

  it('defaults host, port and password when only the required vars are set', () => {
    const cfg = configWith({ TEST_USE_DB: '1', DB_USERNAME: 'root', DB_DATABASE: 'codex_test' });
    expect(cfg).toMatchObject({ host: '127.0.0.1', port: 3306, password: '' });
  });

  it('returns null without the TEST_USE_DB opt-in', () => {
    expect(configWith({ DB_USERNAME: 'root', DB_DATABASE: 'codex_test' })).toBeNull();
    expect(configWith({ TEST_USE_DB: '0', DB_USERNAME: 'root', DB_DATABASE: 'codex_test' })).toBeNull();
  });

  it('returns null when DB_DATABASE or DB_USERNAME is missing', () => {
    expect(configWith({ TEST_USE_DB: '1', DB_USERNAME: 'root' })).toBeNull();
    expect(configWith({ TEST_USE_DB: '1', DB_DATABASE: 'codex_test' })).toBeNull();
  });

  it('returns null when nothing is configured at all', () => {
    expect(configWith({ TEST_USE_DB: '1' })).toBeNull();
  });
});
