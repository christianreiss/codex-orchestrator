import mysql from 'mysql2/promise';
import { drizzle } from 'drizzle-orm/mysql2';
import { test as vitestTest, beforeAll, afterAll, afterEach } from 'vitest';
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
 */
function readDbConfig(): mysql.PoolOptions | null {
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

/**
 * Vitest helper: call inside a describe() to ensure the suite is skipped
 * when no test DB is configured. Otherwise returns the live db handle.
 *
 *   const ctx = skipUnlessDb();
 *   describe('hosts repo', () => {
 *     beforeAll(ctx.setup);
 *     afterEach(ctx.reset);
 *     it('inserts a host', async () => {
 *       const db = await ctx.db();
 *       ...
 *     });
 *   });
 */
export function skipUnlessDb() {
  let handle: TestDbHandle | null = null;
  return {
    async db(): Promise<TestDb> {
      const h = await getTestDb();
      if (!h) throw new Error('skipUnlessDb: no test database configured');
      handle = h;
      return h.db;
    },
    /** Use as `beforeAll(ctx.setup)` to ensure DB-dependent tests skip cleanly. */
    setup: async () => {
      const h = await getTestDb();
      if (!h) {
        // Vitest "test.skip"-style: bail at suite level via global skip.
        // Throwing here from beforeAll marks the suite as failed; instead
        // signal a skip by setting a flag the caller can read.
        // The recommended pattern is for tests to call `await ctx.guard()`
        // at the top of each it() and skip themselves; provide both.
        return;
      }
      handle = h;
    },
    /**
     * Call at top of each test that requires a DB; skips the test if missing.
     * Returns the live db when present.
     */
    guard: async (testCtx?: { skip: () => void }): Promise<TestDb> => {
      const h = await getTestDb();
      if (!h) {
        if (testCtx?.skip) testCtx.skip();
        throw new Error('skipUnlessDb.guard: no test database configured (test should be skipped)');
      }
      return h.db;
    },
    /** Resets all writable tables after each test. */
    reset: async () => {
      if (!handle) return;
      await resetDbRaw(handle);
    },
  };
}

/**
 * Truncate every row from every table managed by Drizzle. Order is
 * dependency-safe (children before parents). Safe to call repeatedly.
 */
export async function resetDbRaw(handle: TestDbHandle): Promise<void> {
  const { pool } = handle;
  const conn = await pool.getConnection();
  try {
    await conn.query('SET FOREIGN_KEY_CHECKS = 0');
    for (const tableName of TRUNCATE_ORDER) {
      await conn.query(`TRUNCATE TABLE \`${tableName}\``).catch(() => {
        /* table may not exist yet — ignore so this works on partial schemas */
      });
    }
    await conn.query('SET FOREIGN_KEY_CHECKS = 1');
  } finally {
    conn.release();
  }
}

/**
 * Child tables first, then parents, then root settings. Anything not listed
 * here will simply not be truncated.
 */
const TRUNCATE_ORDER = [
  // Auth chain (children → parents)
  'host_auth_states',
  'auth_entries',
  'auth_payloads',
  'host_auth_digests',
  'host_users',
  'install_tokens',
  'auth_seed_tokens',
  'cli_auth_requests',
  // Coord project children before parent
  'coord_project_events',
  'coord_project_feedback',
  'coord_project_files',
  'coord_project_todos',
  'coord_project_notes',
  'coord_projects',
  // Admin chain
  'admin_password_resets',
  'admin_webauthn_challenges',
  'admin_passkeys',
  'admin_sessions',
  'admin_events',
  'admin_users',
  // Usage chain
  'token_usages',
  'token_usage_ingests',
  'chatgpt_usage_snapshots',
  'claude_usage_snapshots',
  'dashboard_graph_usage_daily_stats',
  'dashboard_graph_quota_snapshots',
  'dashboard_graph_claude_daily_stats',
  'dashboard_graph_claude_quota_snapshots',
  // Misc content
  'skills',
  'agents_documents',
  'agents_document_state',
  'client_config_documents',
  'mcp_memories',
  'mcp_access_logs',
  'mcp_session_tokens',
  'openai_api_keys',
  'joplin_notes_cache',
  // Insecure / rate / logs / wrappers
  'insecure_auth_requests',
  'insecure_domain_allows',
  'ip_rate_limits',
  'logs',
  'wrapper_signing_keys',
  'wrapper_v2_binaries',
  // Hosts last so FK-bearing tables truncate first
  'hosts',
  // Settings
  'versions',
];

/**
 * Convenience: install global lifecycle hooks for a suite.
 *
 *   useTestDbLifecycle();
 *   it('...', async (ctx) => {
 *     const db = await guardTestDb(ctx);
 *     ...
 *   });
 */
export function useTestDbLifecycle() {
  let handle: TestDbHandle | null = null;
  beforeAll(async () => {
    handle = await getTestDb();
  });
  afterEach(async () => {
    if (handle) await resetDbRaw(handle);
  });
  afterAll(async () => {
    if (handle) await handle.pool.end();
    handle = null;
  });
}

/**
 * Helper that picks a test as skipped when no DB is configured. Use inside
 * `it()` callbacks that take the context object.
 */
export async function guardTestDb(ctx: { skip: () => void }): Promise<TestDb> {
  const h = await getTestDb();
  if (!h) {
    ctx.skip();
    throw new Error('unreachable after skip');
  }
  return h.db;
}

// Re-export the vitest `test` symbol so callers that prefer ctx-driven tests
// can `import { test } from 'helpers/test-db'` and get the skip helper free.
export const test = vitestTest;
