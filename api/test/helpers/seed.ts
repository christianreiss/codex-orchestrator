import { makeAdminUser } from './factories/admin-users.js';
import { makeHost } from './factories/hosts.js';
import { setSetting } from './factories/versions.js';
import { resetDbRaw } from './test-db.js';
import type { TestDb } from './test-db.js';
import mysql from 'mysql2/promise';

/**
 * Truncates every writable table in dependency-safe order. Intended to be
 * called from `afterEach()` in DB-backed integration tests.
 *
 * Accepts either the {db, pool} handle returned by `getTestDb()` or a raw
 * pool. Callers that already use `useTestDbLifecycle()` get this called for
 * them.
 */
export async function resetDb(handle: { db: TestDb; pool: mysql.Pool }): Promise<void> {
  return resetDbRaw(handle);
}

export interface SeedBaselineResult {
  owner: Awaited<ReturnType<typeof makeAdminUser>>;
  host: Awaited<ReturnType<typeof makeHost>>;
}

/**
 * Seeds the minimum data set most DB-backed tests will want:
 *   - one owner admin user with a known password
 *   - one active host with a known api_key
 *   - baseline `versions` rows: codex_version, claude_version, public_base_url
 *
 * Tests that need more specific shapes should call individual factories
 * directly instead. This is the equivalent of the legacy PHP DatabaseSeeder.
 */
export async function seedBaseline(db: TestDb): Promise<SeedBaselineResult> {
  const owner = await makeAdminUser(db, {
    name: 'Owner',
    username: 'owner',
    email: 'owner@example.test',
    password: 'owner-password-1234',
    accessLevel: 'owner',
    active: 1,
  });
  const host = await makeHost(db, {
    fqdn: 'host.example.test',
    status: 'active',
    secure: 1,
    engines: 'codex',
  });
  await setSetting(db, 'codex_version', '0.0.0-test');
  await setSetting(db, 'claude_version', '0.0.0-test');
  await setSetting(db, 'public_base_url', 'https://api.example.test');
  return { owner, host };
}
