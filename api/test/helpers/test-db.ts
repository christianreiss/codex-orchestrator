import mysql from 'mysql2/promise';
import { drizzle } from 'drizzle-orm/mysql2';
import * as schema from '../../src/db/schema.js';
import { loadTestEnv } from './test-keyring.js';
import type { Database } from '../../src/db/client.js';

/**
 * Lazy holder for a singleton test Drizzle client. Tests opt-in by calling
 * `getTestDb()`; if `TEST_DATABASE_URL` (or DB_* env vars) are missing the
 * function returns `null` so callers can `skipUnlessDb()` cleanly.
 *
 * `TestDb` is the same type the production `createDb()` returns so that
 * helpers + factories interop with both seamlessly.
 */
export type TestDb = Database;

interface TestDbHandle {
  db: TestDb;
  pool: mysql.Pool;
}

let cached: TestDbHandle | null | undefined = undefined;

/**
 * Parse TEST_DATABASE_URL if present; otherwise fall back to DB_HOST/DB_PORT/…
 * vars. Returns null if no DB config is available — tests should skip.
 *
 * Exported so `test/fixtures/apply-schema-baseline.ts` resolves the target the
 * same way the suites do; a setup script that picked a different database than
 * the tests would be worse than none.
 */
export function readDbConfig(): mysql.PoolOptions | null {
  const url = process.env.TEST_DATABASE_URL;
  if (url) {
    try {
      const u = new URL(url);
      return {
        host: u.hostname || '127.0.0.1',
        port: u.port ? Number(u.port) : 3306,
        user: decodeURIComponent(u.username || 'root'),
        password: decodeURIComponent(u.password || ''),
        database: u.pathname.replace(/^\//, '') || 'codex_test',
        charset: 'utf8mb4',
        timezone: 'Z',
        dateStrings: true,
        decimalNumbers: true,
        connectionLimit: 4,
      };
    } catch {
      return null;
    }
  }
  // Fallback: only spin up if all DB_* are set with non-default test values.
  if (!process.env.DB_DATABASE || !process.env.DB_USERNAME) return null;
  // Require an explicit signal so we don't accidentally hit production DB.
  if (process.env.TEST_USE_DB !== '1') return null;
  return {
    host: process.env.DB_HOST || '127.0.0.1',
    port: process.env.DB_PORT ? Number(process.env.DB_PORT) : 3306,
    user: process.env.DB_USERNAME,
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_DATABASE,
    charset: 'utf8mb4',
    timezone: 'Z',
    dateStrings: true,
    decimalNumbers: true,
    connectionLimit: 4,
  };
}

/**
 * Returns a singleton test DB. Returns null when no DB is configured for tests.
 * Run loadTestEnv() side-effect to ensure encryption env is set.
 */
export async function getTestDb(): Promise<TestDbHandle | null> {
  if (cached !== undefined) return cached;
  loadTestEnv();
  const cfg = readDbConfig();
  if (!cfg) {
    cached = null;
    return null;
  }
  const pool = mysql.createPool(cfg);
  const db = drizzle(pool, { schema, mode: 'default' }) as TestDb;
  cached = { db, pool };
  return cached;
}

