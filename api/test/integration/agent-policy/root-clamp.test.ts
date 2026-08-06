import { sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { AgentPolicyProfilesService } from '../../../src/services/agent-policy-profiles.js';
import { presetLevels } from '../../../src/services/agent-security-levels.js';
import { getTestDb, type TestDb } from '../../helpers/test-db.js';

const PREFIX = 'ztest-root-clamp';
const handle = await getTestDb();

/**
 * These run against real MySQL because both projections are joins, and the
 * in-memory fake does not execute joins -- it would swallow them into the
 * degrade-to-empty catch and pass forever while the console warning silently
 * never appeared. That is the exact failure this surface exists to prevent.
 */
describe.skipIf(!handle)('root permission clamp projections', { timeout: 120_000 }, () => {
  let db: TestDb;
  let service: AgentPolicyProfilesService;
  let hostId: number;

  const exec = async (query: string) => await db.execute(sql.raw(query));

  const cleanup = async (): Promise<void> => {
    await exec(`DELETE FROM host_users WHERE username LIKE '${PREFIX}%' OR host_id IN (
      SELECT id FROM hosts WHERE fqdn LIKE '${PREFIX}%')`);
    await exec(`DELETE FROM agent_policy_profile_assignments WHERE host_id IN (
      SELECT id FROM hosts WHERE fqdn LIKE '${PREFIX}%')`);
    await exec(`DELETE FROM agent_policy_profiles WHERE name LIKE '${PREFIX}%'`);
    await exec(`DELETE FROM hosts WHERE fqdn LIKE '${PREFIX}%'`);
  };

  beforeAll(async () => {
    db = handle!.db;
    service = new AgentPolicyProfilesService(db as never);
  });

  beforeEach(async () => {
    await cleanup();
    const now = new Date().toISOString();
    await exec(
      `INSERT INTO hosts (fqdn, api_key, status, secure, engines, created_at, updated_at)
       VALUES ('${PREFIX}-01.example', '${'a'.repeat(64)}', 'active', 1, 'claude', '${now}', '${now}')`,
    );
    const rows = await exec(`SELECT id FROM hosts WHERE fqdn = '${PREFIX}-01.example'`);
    hostId = Number((rows as unknown as Array<Array<{ id: number }>>)[0]![0]!.id);
    await exec(
      `INSERT INTO agent_policy_profiles (name, description, levels, is_default, revision, created_at, updated_at)
       VALUES ('${PREFIX}-unrestricted', NULL, '${JSON.stringify(presetLevels('unrestricted'))}', 0, 1, '${now}', '${now}')`,
    );
    const profile = await exec(`SELECT id FROM agent_policy_profiles WHERE name = '${PREFIX}-unrestricted'`);
    const profileId = Number((profile as unknown as Array<Array<{ id: number }>>)[0]![0]!.id);
    await exec(
      `INSERT INTO agent_policy_profile_assignments (host_id, profile_id, created_at, updated_at)
       VALUES (${hostId}, ${profileId}, '${now}', '${now}')`,
    );
  });

  afterEach(cleanup);
  // Deliberately does NOT end the pool: `getTestDb` caches one handle for the
  // whole run, so the first file to close it takes every later file down with
  // it. Cleaning up our own rows is this file's whole responsibility.
  afterAll(cleanup);

  const seedUser = async (username: string) => {
    const now = new Date().toISOString();
    await exec(
      `INSERT INTO host_users (host_id, username, first_seen, last_seen)
       VALUES (${hostId}, '${username}', '${now}', '${now}')`,
    );
  };

  it('reports the clamp for a root host on a bypass posture', async () => {
    await seedUser('root');

    // The posture still asks for the bypass; the clamp is what the host is
    // actually served.
    const enforcement = await service.enforcementForHost(hostId);
    expect(enforcement.claude.permission_mode.value).toBe('bypassPermissions');

    expect(await service.permissionClampsForHost(hostId)).toEqual([
      { username: 'root', from: 'bypassPermissions', to: 'auto' },
    ]);
    expect(await service.rootHostNames()).toContain(`${PREFIX}-01.example`);
  });

  it('reports nothing for a non-root host on the same posture', async () => {
    await seedUser(`${PREFIX}-deploy`);

    expect(await service.permissionClampsForHost(hostId)).toEqual([]);
    expect(await service.rootHostNames()).not.toContain(`${PREFIX}-01.example`);
  });

  it('reports nothing for a root host whose posture asks for a startable mode', async () => {
    await seedUser('root');
    await exec(`DELETE FROM agent_policy_profile_assignments WHERE host_id = ${hostId}`);
    const now = new Date().toISOString();
    await exec(
      `INSERT INTO agent_policy_profiles (name, description, levels, is_default, revision, created_at, updated_at)
       VALUES ('${PREFIX}-standard', NULL, '${JSON.stringify(presetLevels('standard'))}', 0, 1, '${now}', '${now}')`,
    );
    const profile = await exec(`SELECT id FROM agent_policy_profiles WHERE name = '${PREFIX}-standard'`);
    const profileId = Number((profile as unknown as Array<Array<{ id: number }>>)[0]![0]!.id);
    await exec(
      `INSERT INTO agent_policy_profile_assignments (host_id, profile_id, created_at, updated_at)
       VALUES (${hostId}, ${profileId}, '${now}', '${now}')`,
    );

    // Standard resolves to `auto`, which root can start in — nothing to report.
    expect(await service.permissionClampsForHost(hostId)).toEqual([]);
    // The host is still root, so it stays on the list the console warns from.
    expect(await service.rootHostNames()).toContain(`${PREFIX}-01.example`);
  });
});
