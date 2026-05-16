import { randomBytes } from 'node:crypto';
import { Keyring } from '../../src/security/keyring.js';
import { loadEnv, resetEnvCache, type Env } from '../../src/env.js';

/**
 * Generates a fresh random 32-byte key for the test process, base64-encodes
 * it, and installs it into `process.env.ENCRYPTION_ACTIVE_KEY` if no key is
 * already configured. Returns a Keyring usable by `secret-box.{encrypt,decrypt}`.
 *
 * Idempotent across calls in the same process; subsequent calls return the
 * cached keyring so encrypted blobs round-trip within a single test run.
 */
let cachedKeyring: Keyring | undefined;

export function testKeyring(): Keyring {
  if (cachedKeyring) return cachedKeyring;
  ensureKeyEnv();
  // resetEnvCache so that any prior loadEnv() call within the process picks up
  // the freshly-installed key when we re-load.
  resetEnvCache();
  const env = loadTestEnv();
  cachedKeyring = Keyring.fromEnv(env);
  return cachedKeyring;
}

/**
 * Ensures the minimal env vars needed by `loadEnv()` are set, generating a
 * random key when absent. Safe to call before either `loadEnv()` or
 * `buildAppWithDb()`. Returns the resolved Env.
 */
export function loadTestEnv(): Env {
  ensureKeyEnv();
  ensureDbEnv();
  return loadEnv();
}

function ensureKeyEnv(): void {
  if (process.env.ENCRYPTION_ACTIVE_KEY || process.env.AUTH_ENCRYPTION_KEY) return;
  const key = randomBytes(32).toString('base64');
  process.env.ENCRYPTION_ACTIVE_KEY = key;
}

function ensureDbEnv(): void {
  // Provide harmless defaults so `loadEnv()` doesn't throw when DB-dependent
  // tests skip themselves. Tests that need a real DB use `skipUnlessDb()`.
  if (!process.env.DB_DATABASE) process.env.DB_DATABASE = 'codex_test';
  if (!process.env.DB_USERNAME) process.env.DB_USERNAME = 'codex';
  if (!process.env.DB_PASSWORD) process.env.DB_PASSWORD = 'codex';
  if (!process.env.DB_HOST) process.env.DB_HOST = '127.0.0.1';
  if (!process.env.DB_PORT) process.env.DB_PORT = '3306';
  if (!process.env.PUBLIC_BASE_URL_REQUIRED) process.env.PUBLIC_BASE_URL_REQUIRED = 'false';
  if (!process.env.ADMIN_ACCESS_MODE) process.env.ADMIN_ACCESS_MODE = 'cookie';
}
