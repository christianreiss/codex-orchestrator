import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadEnv, resetEnvCache, type Env } from '../../../src/env.js';

/**
 * `src/env.ts` is the gate every boot passes through, yet nothing drove it
 * directly: `test/unit/http/rate-limit-config.test.ts` covers the four
 * RATE_LIMIT_* knobs, and everywhere else the schema is parsed incidentally via
 * `test/helpers/test-keyring.ts`. A coercion that quietly flips, or a dropped
 * cross-field rule, would let a misconfigured deployment boot instead of
 * failing fast with the structured message `loadEnv()` promises — so these pin
 * the .env parser, both coercions and all three refinements.
 *
 * The parsed Env is process-wide state other suites read, so every key touched
 * here is saved and restored and `resetEnvCache()` runs in a `finally`.
 */

/** 32 zero bytes, base64. The schema only asks for a string; no key is built. */
const RAW_KEY = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';

/** The minimum that parses, with all three cross-field inputs cleared. */
const BASE_ENV: Record<string, string | undefined> = {
  DB_DATABASE: 'codex_test',
  DB_USERNAME: 'codex',
  DB_PASSWORD: 'codex',
  ENCRYPTION_ACTIVE_KEY: RAW_KEY,
  AUTH_ENCRYPTION_KEY: undefined,
  AUTH_RUNNER_URL: undefined,
  AUTH_RUNNER_SHARED_SECRET: undefined,
  ADMIN_WEBAUTHN_RP_ID: undefined,
  ADMIN_WEBAUTHN_ORIGIN: undefined,
};

/** Runs `fn` with `overrides` applied (undefined = unset), then restores each key. */
async function withEnv<T>(overrides: Record<string, string | undefined>, fn: () => T | Promise<T>): Promise<T> {
  const saved = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(overrides)) {
    saved.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  resetEnvCache();
  try {
    return await fn();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    resetEnvCache();
  }
}

/** Parses the Env with the given overrides on top of `BASE_ENV`. */
async function envWith(overrides: Record<string, string | undefined>): Promise<Env> {
  return withEnv({ ...BASE_ENV, ...overrides }, () => loadEnv());
}

/** Parses the Env expecting a refusal, and returns the thrown message. */
async function envError(overrides: Record<string, string | undefined>): Promise<string> {
  return withEnv({ ...BASE_ENV, ...overrides }, () => {
    try {
      loadEnv();
    } catch (err) {
      return (err as Error).message;
    }
    throw new Error('expected loadEnv() to refuse this configuration');
  });
}

describe('loadDotEnv', () => {
  it('ignores comments, blanks and "="-less lines, unquotes values, and never overwrites process env', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'env-schema-'));
    const file = join(dir, 'dotenv');
    writeFileSync(
      file,
      [
        '# a comment',
        '   # an indented comment',
        '',
        '   ',
        'ENV_SCHEMA_TEST_BARE_WORD',
        'ENV_SCHEMA_TEST_PLAIN = plain value ',
        'ENV_SCHEMA_TEST_DQ="double quoted"',
        "ENV_SCHEMA_TEST_SQ='single quoted'",
        'ENV_SCHEMA_TEST_EMPTY=',
        'ENV_SCHEMA_TEST_INNER=a=b',
        '=orphan',
        'ENV_SCHEMA_TEST_PRESET=from file',
      ].join('\n'),
    );

    try {
      await withEnv(
        {
          ENV_FILE: file,
          ENV_SCHEMA_TEST_BARE_WORD: undefined,
          ENV_SCHEMA_TEST_PLAIN: undefined,
          ENV_SCHEMA_TEST_DQ: undefined,
          ENV_SCHEMA_TEST_SQ: undefined,
          ENV_SCHEMA_TEST_EMPTY: undefined,
          ENV_SCHEMA_TEST_INNER: undefined,
          ENV_SCHEMA_TEST_PRESET: 'from process',
        },
        async () => {
          // The parser runs at import time, so the file is the only way in.
          vi.resetModules();
          await import('../../../src/env.js');

          expect(process.env.ENV_SCHEMA_TEST_PLAIN).toBe('plain value');
          expect(process.env.ENV_SCHEMA_TEST_DQ).toBe('double quoted');
          expect(process.env.ENV_SCHEMA_TEST_SQ).toBe('single quoted');
          expect(process.env.ENV_SCHEMA_TEST_EMPTY).toBe('');
          // Only the first `=` splits, so a value may contain more of them.
          expect(process.env.ENV_SCHEMA_TEST_INNER).toBe('a=b');
          // No assignment on the line, and no key before the `=`.
          expect('ENV_SCHEMA_TEST_BARE_WORD' in process.env).toBe(false);
          expect(process.env['']).toBeUndefined();
          // The documented precedence: process env always wins over .env.
          expect(process.env.ENV_SCHEMA_TEST_PRESET).toBe('from process');
        },
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('boots without a .env file at all', async () => {
    await withEnv({ ENV_FILE: join(tmpdir(), 'env-schema-absent', '.env') }, async () => {
      vi.resetModules();
      // A deployment configured purely from the process environment is normal:
      // a missing file is a no-op, not a read error that kills the boot.
      await expect(import('../../../src/env.js')).resolves.toBeDefined();
    });
  });
});

describe('env coercions', () => {
  it('reads 1/true/yes/on as true, whatever the case or padding', async () => {
    for (const value of ['1', 'true', 'yes', 'on', 'TRUE', 'Yes', ' on ', '\tTrue\t']) {
      expect((await envWith({ ADMIN_WS_ENABLED: value })).ADMIN_WS_ENABLED).toBe(true);
    }
  });

  it('reads 0/off/junk as false, and falls back to the declared default', async () => {
    for (const value of ['0', 'off', 'false', 'no', '', '2', 'maybe']) {
      expect((await envWith({ ADMIN_WS_ENABLED: value })).ADMIN_WS_ENABLED).toBe(false);
    }
    expect((await envWith({ ADMIN_WS_ENABLED: undefined })).ADMIN_WS_ENABLED).toBe(false);
  });

  it('falls back to the intish default for empty and non-finite values', async () => {
    expect((await envWith({ AUTH_RUNNER_TIMEOUT: '20' })).AUTH_RUNNER_TIMEOUT).toBe(20);
    expect((await envWith({ AUTH_RUNNER_TIMEOUT: '' })).AUTH_RUNNER_TIMEOUT).toBe(8);
    expect((await envWith({ AUTH_RUNNER_TIMEOUT: 'soon' })).AUTH_RUNNER_TIMEOUT).toBe(8);
    expect((await envWith({ AUTH_RUNNER_TIMEOUT: undefined })).AUTH_RUNNER_TIMEOUT).toBe(8);
  });

  it('holds CHATGPT_USAGE_TIMEOUT at 10 seconds for any non-positive value', async () => {
    expect((await envWith({ CHATGPT_USAGE_TIMEOUT: '30' })).CHATGPT_USAGE_TIMEOUT).toBe(30);
    // Zero or negative would mean "give up immediately", never what was meant.
    expect((await envWith({ CHATGPT_USAGE_TIMEOUT: '0' })).CHATGPT_USAGE_TIMEOUT).toBe(10);
    expect((await envWith({ CHATGPT_USAGE_TIMEOUT: '-5' })).CHATGPT_USAGE_TIMEOUT).toBe(10);
    expect((await envWith({ CHATGPT_USAGE_TIMEOUT: 'never' })).CHATGPT_USAGE_TIMEOUT).toBe(10);
    expect((await envWith({ CHATGPT_USAGE_TIMEOUT: '' })).CHATGPT_USAGE_TIMEOUT).toBe(10);
    expect((await envWith({ CHATGPT_USAGE_TIMEOUT: undefined })).CHATGPT_USAGE_TIMEOUT).toBe(10);
  });
});

describe('cross-field refinements', () => {
  it('refuses a boot with neither ENCRYPTION_ACTIVE_KEY nor AUTH_ENCRYPTION_KEY', async () => {
    const message = await envError({ ENCRYPTION_ACTIVE_KEY: undefined });

    expect(message).toContain('Invalid environment configuration:');
    expect(message).toContain(
      '  - ENCRYPTION_ACTIVE_KEY: Either ENCRYPTION_ACTIVE_KEY or AUTH_ENCRYPTION_KEY must be set',
    );
    // Either name satisfies it — the legacy one is still a valid way to boot.
    expect(
      (await envWith({ ENCRYPTION_ACTIVE_KEY: undefined, AUTH_ENCRYPTION_KEY: RAW_KEY }))
        .AUTH_ENCRYPTION_KEY,
    ).toBe(RAW_KEY);
  });

  it('refuses AUTH_RUNNER_URL without AUTH_RUNNER_SHARED_SECRET', async () => {
    const message = await envError({ AUTH_RUNNER_URL: 'http://runner:8081' });

    expect(message).toContain(
      '  - AUTH_RUNNER_SHARED_SECRET: AUTH_RUNNER_SHARED_SECRET is required when AUTH_RUNNER_URL is set',
    );
    const env = await envWith({
      AUTH_RUNNER_URL: 'http://runner:8081',
      AUTH_RUNNER_SHARED_SECRET: 'shhh',
    });
    expect(env.AUTH_RUNNER_URL).toBe('http://runner:8081');
  });

  it('refuses ADMIN_WEBAUTHN_RP_ID without ADMIN_WEBAUTHN_ORIGIN', async () => {
    const message = await envError({ ADMIN_WEBAUTHN_RP_ID: 'codex-auth.uggs.io' });

    expect(message).toContain(
      '  - ADMIN_WEBAUTHN_ORIGIN: ADMIN_WEBAUTHN_ORIGIN is required when ADMIN_WEBAUTHN_RP_ID is set',
    );
    const env = await envWith({
      ADMIN_WEBAUTHN_RP_ID: 'codex-auth.uggs.io',
      ADMIN_WEBAUTHN_ORIGIN: 'https://codex-auth.uggs.io',
    });
    expect(env.ADMIN_WEBAUTHN_ORIGIN).toBe('https://codex-auth.uggs.io');
  });

  it('lists every problem in one message rather than stopping at the first', async () => {
    const message = await envError({
      ENCRYPTION_ACTIVE_KEY: undefined,
      AUTH_RUNNER_URL: 'http://runner:8081',
      ADMIN_WEBAUTHN_RP_ID: 'codex-auth.uggs.io',
    });

    // One boot, one fix list: an operator should not have to restart three
    // times to discover three misconfigured vars.
    const paths = message
      .split('\n')
      .slice(1)
      .map((line) => line.replace(/^ {2}- /, '').split(':')[0]);
    expect(paths).toEqual([
      'ENCRYPTION_ACTIVE_KEY',
      'AUTH_RUNNER_SHARED_SECRET',
      'ADMIN_WEBAUTHN_ORIGIN',
    ]);
  });
});

describe('loadEnv caching', () => {
  it('returns the cached object until resetEnvCache, then re-parses', async () => {
    await withEnv({ ...BASE_ENV, ADMIN_SESSION_COOKIE: 'codex_admin_session' }, () => {
      const first = loadEnv();
      expect(loadEnv()).toBe(first);

      // A later env change is invisible: boot-time config stays frozen for the
      // lifetime of the process unless something explicitly drops the cache.
      process.env.ADMIN_SESSION_COOKIE = 'rotated_cookie';
      expect(loadEnv()).toBe(first);
      expect(first.ADMIN_SESSION_COOKIE).toBe('codex_admin_session');

      resetEnvCache();
      const second = loadEnv();
      expect(second).not.toBe(first);
      expect(second.ADMIN_SESSION_COOKIE).toBe('rotated_cookie');
    });
  });
});
