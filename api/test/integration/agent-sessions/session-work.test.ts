import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { loadSessionWork, pathLineage } from '../../../src/services/agent-session-work.js';
import { sha256 } from '../../../src/services/git-director.js';
import { getTestDb, type TestDb } from '../../helpers/test-db.js';

/**
 * The work enrichment against real MySQL.
 *
 * `db-fake` answers a `SELECT` by walking arrays, so every assertion below would
 * pass there for the fake's reasons rather than the schema's. What actually has
 * to hold is SQL:
 *
 *  1. **The ancestor walk resolves a real registration.** An agent working in
 *     `…/repo/api` must pick up the task declared for `…/repo`, which is an
 *     `IN` over a set of computed hashes plus a host match in JS -- and the
 *     deepest hit has to win, or a nested worktree would be reported under its
 *     parent's task.
 *  2. **A hash is not an identity.** `git_worktrees.worktree_hash` is unique per
 *     clone, not per fleet: two hosts registering the same absolute path produce
 *     the same hash, and only the `host_id` pairing keeps one host's task off the
 *     other's session.
 *  3. **The address join follows a nullable unique column.** `current_session_id`
 *     is NULL for every address that is not currently bound, and
 *     `inArray(..., sessionIds)` against a nullable column is exactly where a
 *     fake and a database disagree.
 */

const FQDN_A = 'ztest-sessionwork-a.example';
const FQDN_B = 'ztest-sessionwork-b.example';
const ROOT = '/srv/ztest-sw/repo';
const NESTED = '/srv/ztest-sw/repo/api';

const handle = await getTestDb();

describe.skipIf(!handle)('session work enrichment against a real database', () => {
  let db: TestDb;
  let hostA = 0;
  let hostB = 0;

  const exec = async (q: string) => db.execute(sql.raw(q));
  const rowsOf = (res: unknown): Array<Record<string, unknown>> => {
    const first = Array.isArray(res) ? (res[0] as unknown) : res;
    return Array.isArray(first) ? (first as Array<Record<string, unknown>>) : [];
  };
  const now = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');

  async function makeHost(fqdn: string): Promise<number> {
    const stamp = now();
    await exec(`DELETE FROM hosts WHERE fqdn = '${fqdn}'`);
    await exec(
      `INSERT INTO hosts (fqdn, api_key, status, created_at, updated_at)
       VALUES ('${fqdn}', SHA2('${fqdn}', 256), 'active', '${stamp}', '${stamp}')`,
    );
    return Number(rowsOf(await exec(`SELECT id FROM hosts WHERE fqdn = '${fqdn}'`))[0]!.id);
  }

  /** A registered worktree carrying a declared task. */
  async function registerWorktree(hostId: number, path: string, task: string, branch: string): Promise<void> {
    const stamp = now();
    const cloneId = randomUUID();
    await exec(
      `INSERT INTO git_clones (id, host_id, clone_key, clone_dir, repo_root, first_seen_at, last_seen_at, created_at, updated_at)
       VALUES ('${cloneId}', ${hostId}, SHA2('${path}${hostId}', 256), '${path}', '${path}', '${stamp}', '${stamp}', '${stamp}', '${stamp}')`,
    );
    await exec(
      `INSERT INTO git_worktrees
         (id, clone_id, host_id, worktree_path, worktree_hash, username, engine, branch, task,
          declared_paths, target_branch, status, registered_at, heartbeat_at, expires_at, created_at, updated_at)
       VALUES ('${randomUUID()}', '${cloneId}', ${hostId}, '${path}', '${sha256(path)}', 'chris', 'claude',
               '${branch}', '${task}', '["api/src"]', 'main', 'active',
               '${stamp}', '${stamp}', '${stamp}', '${stamp}', '${stamp}')`,
    );
  }

  async function makeSession(hostId: number, cwd: string): Promise<string> {
    const stamp = now();
    const id = randomUUID();
    await exec(
      `INSERT INTO agent_sessions
         (id, host_id, engine, username, cwd, invocation_kind, status,
          host_auth_fingerprint, bridge_token_hash, bridge_expires_at,
          started_at, heartbeat_at, created_at, updated_at)
       VALUES ('${id}', ${hostId}, 'claude', 'chris', '${cwd}', 'interactive', 'active',
               SHA2('fp', 256), SHA2('${id}', 256), '${stamp}',
               '${stamp}', '${stamp}', '${stamp}', '${stamp}')`,
    );
    return id;
  }

  beforeAll(async () => {
    db = handle!.db;
    hostA = await makeHost(FQDN_A);
    hostB = await makeHost(FQDN_B);
  });

  beforeEach(async () => {
    for (const hostId of [hostA, hostB]) {
      await exec(`DELETE FROM agent_bus_addresses WHERE host_id = ${hostId}`);
      await exec(`DELETE FROM agent_sessions WHERE host_id = ${hostId}`);
      await exec(`DELETE FROM git_worktrees WHERE host_id = ${hostId}`);
      await exec(`DELETE FROM git_clones WHERE host_id = ${hostId}`);
    }
  });

  it('resolves a task declared above the directory the agent is sitting in', async () => {
    await registerWorktree(hostA, ROOT, 'Rewrite the presence ladder', 'feat/presence');
    const id = await makeSession(hostA, NESTED);

    const work = await loadSessionWork(db, [{ id, host_id: hostA, cwd: NESTED }]);

    // Matching the cwd alone -- which is all a worktree_hash lookup does -- would
    // have returned nothing here, and nothing is what most of the fleet would
    // have shown.
    expect(work.get(id)?.task).toBe('Rewrite the presence ladder');
    expect(work.get(id)?.branch).toBe('feat/presence');
    expect(work.get(id)?.worktree_path).toBe(ROOT);
    expect(work.get(id)?.declared_paths).toEqual(['api/src']);
  });

  it('prefers the deepest registration when a worktree is nested inside another', async () => {
    await registerWorktree(hostA, ROOT, 'Outer task', 'main');
    await registerWorktree(hostA, NESTED, 'Inner task', 'feat/inner');
    const id = await makeSession(hostA, NESTED);

    const work = await loadSessionWork(db, [{ id, host_id: hostA, cwd: NESTED }]);
    expect(work.get(id)?.task).toBe('Inner task');
  });

  it('does not lend one host a task registered at the same path on another', async () => {
    // Same absolute path on two machines hashes identically; only host_id separates them.
    await registerWorktree(hostB, ROOT, 'Task belonging to host B', 'main');
    const id = await makeSession(hostA, ROOT);

    const work = await loadSessionWork(db, [{ id, host_id: hostA, cwd: ROOT }]);
    expect(work.get(id)).toBeUndefined();
  });

  it('ignores a registration the Director has already reclaimed', async () => {
    await registerWorktree(hostA, ROOT, 'Finished work', 'main');
    await exec(`UPDATE git_worktrees SET status = 'abandoned' WHERE host_id = ${hostA}`);
    const id = await makeSession(hostA, ROOT);

    const work = await loadSessionWork(db, [{ id, host_id: hostA, cwd: ROOT }]);
    expect(work.get(id)).toBeUndefined();
  });

  it('binds the messaging address through current_session_id and skips unbound ones', async () => {
    const bound = await makeSession(hostA, ROOT);
    const stamp = now();
    // One address bound to the live session, one left unbound the way every
    // finished session leaves its address behind.
    await exec(
      `INSERT INTO agent_bus_addresses
         (id, address, display_alias, host_id, engine, username, cwd, cwd_hash, enabled,
          current_session_id, readiness, last_seen_at, created_at, updated_at)
       VALUES ('${randomUUID()}', 'zt-bound', 'crisp-otter', ${hostA}, 'claude', 'chris', '${ROOT}',
               '${sha256(ROOT)}', 1, '${bound}', 'ready', '${stamp}', '${stamp}', '${stamp}')`,
    );
    await exec(
      `INSERT INTO agent_bus_addresses
         (id, address, display_alias, host_id, engine, username, cwd, cwd_hash, enabled,
          current_session_id, readiness, last_seen_at, created_at, updated_at)
       VALUES ('${randomUUID()}', 'zt-unbound', 'stale-heron', ${hostA}, 'claude', 'chris', '${ROOT}',
               '${sha256(ROOT)}', 1, NULL, 'offline', '${stamp}', '${stamp}', '${stamp}')`,
    );

    const work = await loadSessionWork(db, [{ id: bound, host_id: hostA, cwd: ROOT }]);
    expect(work.get(bound)?.address).toBe('zt-bound');
    expect(work.get(bound)?.address_alias).toBe('crisp-otter');
  });

  it('returns an empty map rather than querying for no sessions', async () => {
    expect((await loadSessionWork(db, [])).size).toBe(0);
  });
});

describe('pathLineage', () => {
  it('walks every ancestor deepest first', () => {
    expect(pathLineage('/srv/repo/api/src')).toEqual([
      '/srv/repo/api/src',
      '/srv/repo/api',
      '/srv/repo',
      '/srv',
    ]);
  });

  it('stops short of the filesystem root', () => {
    // A worktree registered at "/" would otherwise claim every session on the box.
    expect(pathLineage('/srv')).toEqual(['/srv']);
    expect(pathLineage('/')).toEqual([]);
  });

  it('normalizes before walking, so a trailing or doubled separator still matches', () => {
    expect(pathLineage('/srv//repo/')).toEqual(['/srv/repo', '/srv']);
  });

  it('gives nothing back for an empty path and passes a relative one through whole', () => {
    expect(pathLineage('')).toEqual([]);
    expect(pathLineage('relative/dir')).toEqual(['relative/dir']);
  });
});
