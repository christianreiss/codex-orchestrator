import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { GitDirectorService, GIT_DIRECTOR_ENABLED_FLAG } from '../../../src/services/git-director.js';
import { SettingsService } from '../../../src/services/settings.js';
import { getTestDb, type TestDb } from '../../helpers/test-db.js';
import { splitSqlStatements } from '../../../src/db/migration-sql.js';
import type { Host } from '../../../src/db/schema.js';

/**
 * The Git Director against real MySQL. Everything here needs a database to mean
 * anything:
 *
 *  1. **Lease exclusivity.** There is no lease table — the live lease is the
 *     merge-request row with `verdict='allow'` and an unexpired TTL, held by a
 *     `SELECT … FOR UPDATE` on the clone. `db-fake` has no transactions and no
 *     row locks, so a unit assertion would pass for the fake's reasons.
 *  2. **Idempotency.** `uq_git_merge_requests_client` is the retry guard. The
 *     fake enforces no unique index, so the property it protects — a retried
 *     tool call returning the original verdict instead of queueing a phantom
 *     contender — is only real here.
 *  3. **Reclaiming forgotten clients.** The behaviour that decides whether this
 *     feature is usable at all. An agent that closes its terminal mid-merge
 *     never calls `git_release`, and until its lease is reclaimed every other
 *     agent on that branch is queued behind something that no longer exists.
 *     Both signals are exercised: the definitive one (a bound agent whose
 *     session ended) and the fallback (silence past the TTL).
 *  4. **Clone identity.** That two worktrees of one checkout collapse onto one
 *     `git_clones` row is the premise of the whole feature, and it depends on
 *     the unique key.
 *
 * The judge is deliberately absent from most of this file: with no arbiter wired
 * every contended decision takes the deterministic fallback, which is exactly
 * the path that must keep working when inference is unreachable.
 */

const MIGRATIONS = ['0025_add_git_director.sql'].map((f) =>
  join(dirname(fileURLToPath(import.meta.url)), '../../../src/db/migrations/', f),
);

const FQDN = 'ztest-gitdirector.example';
const CLONE_DIR = '/srv/ztest-gd/repo/.git';
const MAIN_WT = '/srv/ztest-gd/repo';
const LINKED_WT = '/srv/ztest-gd/wt-a';
const REMOTE = 'git@git.example.com:ztest/gd.git';

const handle = await getTestDb();

describe.skipIf(!handle)('git director against a real database', () => {
  let db: TestDb;
  let svc: GitDirectorService;
  let host: Host;

  const exec = async (q: string) => db.execute(sql.raw(q));
  const rowsOf = (res: unknown): Array<Record<string, unknown>> => {
    const first = Array.isArray(res) ? (res[0] as unknown) : res;
    return Array.isArray(first) ? (first as Array<Record<string, unknown>>) : [];
  };

  const register = (path: string, extra: Record<string, unknown> = {}) =>
    svc.register(
      {
        worktree_path: path,
        clone_dir: CLONE_DIR,
        repo_root: MAIN_WT,
        remote_url: REMOTE,
        branch: path === MAIN_WT ? 'main' : 'feat/a',
        username: 'chris',
        ...extra,
      },
      host,
    );

  const requestMerge = (path: string, paths: string[], clientId = randomUUID()) =>
    svc.requestMerge(
      {
        worktree_path: path,
        target_branch: 'main',
        client_request_id: clientId,
        base_sha: 'aaaa',
        head_sha: 'bbbb',
        changed_paths: paths,
      },
      host,
    );

  beforeAll(async () => {
    db = handle!.db;
    for (const file of MIGRATIONS) {
      for (const stmt of splitSqlStatements(readFileSync(file, 'utf8'))) await exec(stmt);
    }
    const now = new Date().toISOString();
    await exec(`DELETE FROM hosts WHERE fqdn = '${FQDN}'`);
    await exec(
      `INSERT INTO hosts (fqdn, api_key, status, created_at, updated_at)
       VALUES ('${FQDN}', SHA2('${FQDN}', 256), 'active', '${now}', '${now}')`,
    );
    host = rowsOf(await exec(`SELECT id, fqdn FROM hosts WHERE fqdn = '${FQDN}'`))[0] as unknown as Host;
    svc = new GitDirectorService({ db, settings: new SettingsService(db) });
  });

  beforeEach(async () => {
    await exec(`DELETE FROM git_merge_requests WHERE clone_id IN (SELECT id FROM git_clones WHERE host_id = ${host.id})`);
    await exec(`DELETE FROM git_worktrees WHERE host_id = ${host.id}`);
    await exec(`DELETE FROM git_clones WHERE host_id = ${host.id}`);
    await new SettingsService(db).setFlag(GIT_DIRECTOR_ENABLED_FLAG, true, { publish: false });
  });

  it('collapses every worktree of one checkout onto a single clone', async () => {
    const first = (await register(MAIN_WT)) as Record<string, unknown>;
    const second = (await register(LINKED_WT)) as Record<string, unknown>;
    // The premise of the feature: the linked worktree contends with the main
    // checkout, not with itself.
    const cloneOf = (r: Record<string, unknown>) => (r['clone'] as Record<string, unknown>)['clone_id'];
    expect(cloneOf(second)).toBe(cloneOf(first));
    expect(rowsOf(await exec(`SELECT id FROM git_clones WHERE host_id = ${host.id}`))).toHaveLength(1);
    const peers = second['peers'] as Array<Record<string, unknown>>;
    expect(peers.map((p) => p['worktree_path'])).toEqual([MAIN_WT]);
  });

  it('grants one lease and makes the overlapping contender wait, naming the files', async () => {
    await register(MAIN_WT);
    await register(LINKED_WT);

    const granted = (await requestMerge(MAIN_WT, ['api/a.ts', 'api/b.ts'])) as Record<string, unknown>;
    expect(granted['verdict']).toBe('allow');
    expect(granted['decided_by']).toBe('policy');
    expect(granted['lease_expires_at']).toBeTruthy();

    const blocked = (await requestMerge(LINKED_WT, ['api/b.ts', 'api/c.ts'])) as Record<string, unknown>;
    expect(blocked['verdict']).toBe('wait');
    // No judge is wired, so this is the fallback path — the one that has to keep
    // working when no inference is reachable.
    expect(blocked['decided_by']).toBe('policy');
    expect(blocked['overlap']).toEqual(['api/b.ts']);
    expect(String(blocked['reason'])).toContain('api/b.ts');
  });

  it('returns the original verdict for a retried request instead of queueing twice', async () => {
    await register(MAIN_WT);
    await register(LINKED_WT);
    await requestMerge(MAIN_WT, ['api/a.ts']);

    const id = randomUUID();
    const first = (await requestMerge(LINKED_WT, ['api/a.ts'], id)) as Record<string, unknown>;
    const retry = (await requestMerge(LINKED_WT, ['api/a.ts'], id)) as Record<string, unknown>;

    expect(retry['request_id']).toBe(first['request_id']);
    expect(retry['replayed']).toBe(true);
    const queued = rowsOf(
      await exec(`SELECT id FROM git_merge_requests WHERE client_request_id = '${id}'`),
    );
    expect(queued).toHaveLength(1);
  });

  it('frees the branch when the holder releases, on the next poll', async () => {
    await register(MAIN_WT);
    await register(LINKED_WT);
    const granted = (await requestMerge(MAIN_WT, ['api/a.ts'])) as Record<string, unknown>;
    const waiting = (await requestMerge(LINKED_WT, ['api/a.ts'])) as Record<string, unknown>;
    expect(waiting['verdict']).toBe('wait');

    await svc.release({ request_id: granted['request_id'] }, host);

    // Promotion is poll-driven: nothing was pushed to the waiter.
    const promoted = (await svc.mergeStatus({ request_id: waiting['request_id'] }, host)) as Record<string, unknown>;
    expect(promoted['verdict']).toBe('allow');
  });

  describe('forgotten clients', () => {
    it('reclaims a lease whose holder went quiet past its TTL', async () => {
      await register(MAIN_WT);
      await register(LINKED_WT);
      const granted = (await requestMerge(MAIN_WT, ['api/a.ts'])) as Record<string, unknown>;

      // The terminal closed. Nothing calls git_release, ever. With no bound
      // address there is no liveness to consult, so silence is the only signal
      // and both the registration and its lease age out together.
      const past = new Date(Date.now() - 86_400_000).toISOString();
      await exec(`UPDATE git_worktrees SET expires_at = '${past}' WHERE worktree_path = '${MAIN_WT}'`);
      await exec(`UPDATE git_merge_requests SET lease_expires_at = '${past}' WHERE id = '${granted['request_id']}'`);

      const after = (await requestMerge(LINKED_WT, ['api/a.ts'])) as Record<string, unknown>;
      expect(after['verdict']).toBe('allow');

      const reclaimed = rowsOf(
        await exec(`SELECT verdict, reason FROM git_merge_requests WHERE id = '${granted['request_id']}'`),
      )[0]!;
      expect(reclaimed['verdict']).toBe('expired');
      // The reason has to record that it was abandoned rather than finished, or
      // a human reading the history cannot tell a clean merge from a vanished
      // agent. The registration went first, so the lease is reported as orphaned
      // rather than merely stale — the more specific of the two truths.
      expect(String(reclaimed['reason'])).toContain('no longer registered');
      expect(
        rowsOf(await exec(`SELECT status FROM git_worktrees WHERE worktree_path = '${MAIN_WT}'`))[0]!['status'],
      ).toBe('expired');
    });

    it('expires an unrenewed lease even while its agent is still working', async () => {
      await register(MAIN_WT);
      await register(LINKED_WT);
      const granted = (await requestMerge(MAIN_WT, ['api/a.ts'])) as Record<string, unknown>;

      // The other shape of forgetting: the agent is alive and still calling the
      // Director, it simply never released the branch it finished with. Only the
      // lease ages; the registration stays live.
      const past = new Date(Date.now() - 86_400_000).toISOString();
      await exec(`UPDATE git_merge_requests SET lease_expires_at = '${past}' WHERE id = '${granted['request_id']}'`);

      const after = (await requestMerge(LINKED_WT, ['api/a.ts'])) as Record<string, unknown>;
      expect(after['verdict']).toBe('allow');

      const reclaimed = rowsOf(
        await exec(`SELECT verdict, reason FROM git_merge_requests WHERE id = '${granted['request_id']}'`),
      )[0]!;
      expect(reclaimed['verdict']).toBe('expired');
      expect(String(reclaimed['reason'])).toContain('never renewed');
      // The registration itself must survive: the agent never went anywhere.
      expect(
        rowsOf(await exec(`SELECT status FROM git_worktrees WHERE worktree_path = '${MAIN_WT}'`))[0]!['status'],
      ).toBe('active');
    });

    it('reclaims immediately when the fleet can see the holder\'s session ended', async () => {
      await register(MAIN_WT);
      await register(LINKED_WT);
      const granted = (await requestMerge(MAIN_WT, ['api/a.ts'])) as Record<string, unknown>;

      // Bind a dead agent address to the holder: no current_session_id means no
      // wrapper lifecycle is attached, which is the fleet's own liveness signal.
      // Its TTL is left far in the future on purpose — this must not wait it out.
      const addressId = randomUUID();
      const now = new Date().toISOString();
      await exec(
        `INSERT INTO agent_bus_addresses
           (id, address, host_id, engine, username, cwd, cwd_hash, enabled, readiness, last_seen_at, created_at, updated_at)
         VALUES ('${addressId}', 'agent:${addressId}', ${host.id}, 'claude', 'chris', '${MAIN_WT}',
                 SHA2('${MAIN_WT}', 256), 1, 'offline', '${now}', '${now}', '${now}')`,
      );
      await exec(
        `UPDATE git_worktrees SET agent_bus_address_id = '${addressId}' WHERE worktree_path = '${MAIN_WT}'`,
      );

      const after = (await requestMerge(LINKED_WT, ['api/a.ts'])) as Record<string, unknown>;
      expect(after['verdict']).toBe('allow');

      const holder = rowsOf(
        await exec(`SELECT status FROM git_worktrees WHERE worktree_path = '${MAIN_WT}'`),
      )[0]!;
      expect(holder['status']).toBe('abandoned');
      const reclaimed = rowsOf(
        await exec(`SELECT verdict, reason FROM git_merge_requests WHERE id = '${granted['request_id']}'`),
      )[0]!;
      expect(reclaimed['verdict']).toBe('expired');
      expect(String(reclaimed['reason'])).toContain('no longer registered');

      await exec(`DELETE FROM agent_bus_addresses WHERE id = '${addressId}'`);
    });

    it('keeps a live-but-quiet agent alive: any call is proof of life', async () => {
      await register(MAIN_WT);
      const past = new Date(Date.now() - 86_400_000).toISOString();
      await exec(`UPDATE git_worktrees SET expires_at = '${past}' WHERE worktree_path = '${MAIN_WT}'`);

      // The agent was busy, not gone. Touching any tool that names its worktree
      // must revive the registration rather than leave it reaped.
      await svc.join({ worktree_path: MAIN_WT, task: 'still here' }, host);
      const row = rowsOf(
        await exec(`SELECT status, expires_at FROM git_worktrees WHERE worktree_path = '${MAIN_WT}'`),
      )[0]!;
      expect(row['status']).toBe('active');
      expect(String(row['expires_at']) > past).toBe(true);
    });

    it('still shows a reclaimed registration, rather than pretending nobody was there', async () => {
      await register(MAIN_WT, { task: 'refactor the arbiter' });
      await svc.join({ worktree_path: MAIN_WT, task: 'refactor the arbiter' }, host);
      const past = new Date(Date.now() - 86_400_000).toISOString();
      await exec(`UPDATE git_worktrees SET expires_at = '${past}' WHERE worktree_path = '${MAIN_WT}'`);

      const listed = (await svc.list({ scope: 'host' }, host)) as Record<string, unknown>;
      const clone = (listed['clones'] as Array<Record<string, unknown>>)[0]!;
      expect(clone['worktrees']).toEqual([]);
      const stale = clone['stale'] as Array<Record<string, unknown>>;
      expect(stale).toHaveLength(1);
      expect(stale[0]!['worktree_path']).toBe(MAIN_WT);
      expect(stale[0]!['status']).toBe('expired');
      expect(stale[0]!['task']).toBe('refactor the arbiter');
    });

    it('lets an operator evict a registration that is still technically alive', async () => {
      await register(MAIN_WT);
      await register(LINKED_WT);
      const granted = (await requestMerge(MAIN_WT, ['api/a.ts'])) as Record<string, unknown>;
      const worktreeId = rowsOf(
        await exec(`SELECT id FROM git_worktrees WHERE worktree_path = '${MAIN_WT}'`),
      )[0]!['id'];

      // Neither automatic signal fires here: the TTL is running and there is no
      // address to declare dead. A human who already knows is the third case.
      const out = (await svc.adminEvictWorktree(String(worktreeId))) as Record<string, unknown>;
      expect(out['released']).toBe(1);

      const lease = rowsOf(
        await exec(`SELECT verdict FROM git_merge_requests WHERE id = '${granted['request_id']}'`),
      )[0]!;
      expect(lease['verdict']).toBe('withdrawn');

      const next = (await requestMerge(LINKED_WT, ['api/a.ts'])) as Record<string, unknown>;
      expect(next['verdict']).toBe('allow');
    });
  });

  it('refuses to hand a held lease to a different agent by re-registering', async () => {
    await register(MAIN_WT);
    await requestMerge(MAIN_WT, ['api/a.ts']);
    await expect(register(MAIN_WT, { username: 'someone-else' })).rejects.toMatchObject({
      code: 'git_director_lease_held',
    });
  });

  it('applies its migration twice without error', async () => {
    for (const file of MIGRATIONS) {
      for (const stmt of splitSqlStatements(readFileSync(file, 'utf8'))) await exec(stmt);
    }
    expect(rowsOf(await exec(`SHOW TABLES LIKE 'git_%'`))).toHaveLength(3);
  });
});
