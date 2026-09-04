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
  // Server-authored stamps drop milliseconds; presence compares these strings
  // lexically, and '…00.000Z' sorts before '…00Z', so a millisecond-precision
  // fixture would read as older than it is.
  const isoSeconds = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, 'Z');
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

    /**
     * The two halves of derived liveness, which `current_session_id` alone
     * could not tell apart.
     *
     * A registered session keeps `current_session_id` set and leaves
     * `readiness` at the 'resumable' it was given at registration — nothing
     * moves that column unless the agent calls `agent_listen`. So before
     * presence was derived, a hard-killed wrapper was indistinguishable from a
     * working one, and its branch stayed locked until the binding was reaped on
     * `bridge_expires_at`: 900s, restamped every 15s. These two cases pin both
     * directions of the fix, because a reclaim that is merely *eager* would be
     * a worse bug than the one it replaces.
     */
    const bindLiveSession = async (heartbeatAt: string) => {
      const addressId = randomUUID();
      const sessionId = randomUUID();
      const now = isoSeconds(new Date());
      await exec(
        `INSERT INTO agent_bus_addresses
           (id, address, host_id, engine, username, cwd, cwd_hash, enabled, readiness,
            current_session_id, last_seen_at, created_at, updated_at)
         VALUES ('${addressId}', 'agent:${addressId}', ${host.id}, 'claude', 'chris', '${MAIN_WT}',
                 SHA2('${MAIN_WT}', 256), 1, 'resumable', '${sessionId}', '${now}', '${now}', '${now}')`,
      );
      await exec(
        `INSERT INTO agent_sessions
           (id, host_id, engine, username, cwd, agent_bus_address_id, invocation_kind, status,
            host_auth_fingerprint, bridge_token_hash, bridge_expires_at, started_at, heartbeat_at,
            created_at, updated_at)
         VALUES ('${sessionId}', ${host.id}, 'claude', 'chris', '${MAIN_WT}', '${addressId}',
                 'interactive', 'active', SHA2('fp', 256), SHA2('tok', 256),
                 '${isoSeconds(new Date(Date.now() + 900_000))}', '${now}', '${heartbeatAt}',
                 '${now}', '${now}')`,
      );
      await exec(
        `UPDATE git_worktrees SET agent_bus_address_id = '${addressId}' WHERE worktree_path = '${MAIN_WT}'`,
      );
      return { addressId, sessionId };
    };

    const cleanupBinding = async (ids: { addressId: string; sessionId: string }) => {
      await exec(`DELETE FROM agent_sessions WHERE id = '${ids.sessionId}'`);
      await exec(`DELETE FROM agent_bus_addresses WHERE id = '${ids.addressId}'`);
    };

    it('reclaims a bound holder whose heartbeat stopped, without waiting out the TTL', async () => {
      await register(MAIN_WT);
      await register(LINKED_WT);
      const granted = (await requestMerge(MAIN_WT, ['api/a.ts'])) as Record<string, unknown>;
      expect(granted['verdict']).toBe('allow');

      // Registered and still bound — `current_session_id` is set and `readiness`
      // reads 'resumable' — but the wrapper died ten minutes ago. The old
      // blocklist called this alive and held the branch.
      const ids = await bindLiveSession(isoSeconds(new Date(Date.now() - 600_000)));

      const after = (await requestMerge(LINKED_WT, ['api/a.ts'])) as Record<string, unknown>;
      expect(after['verdict']).toBe('allow');

      const holder = rowsOf(
        await exec(`SELECT status FROM git_worktrees WHERE worktree_path = '${MAIN_WT}'`),
      )[0]!;
      // 'abandoned', not 'expired': the fleet saw the agent go, it did not
      // merely run out of clock. The two words mean different things in `stale`.
      expect(holder['status']).toBe('abandoned');
      const reclaimed = rowsOf(
        await exec(`SELECT verdict, reason FROM git_merge_requests WHERE id = '${granted['request_id']}'`),
      )[0]!;
      expect(reclaimed['verdict']).toBe('expired');
      expect(String(reclaimed['reason'])).toContain('no longer registered');

      await cleanupBinding(ids);
    });

    it('leaves a heartbeating holder alone, however quiet it has been', async () => {
      await register(MAIN_WT);
      await register(LINKED_WT);
      await requestMerge(MAIN_WT, ['api/a.ts']);

      // Same shape, one field different: the wrapper is still ticking. An agent
      // thinking its way through a long tool call must not lose its branch.
      const ids = await bindLiveSession(isoSeconds(new Date()));

      const after = (await requestMerge(LINKED_WT, ['api/a.ts'])) as Record<string, unknown>;
      expect(after['verdict']).toBe('wait');

      const holder = rowsOf(
        await exec(`SELECT status FROM git_worktrees WHERE worktree_path = '${MAIN_WT}'`),
      )[0]!;
      expect(holder['status']).toBe('active');

      await cleanupBinding(ids);
    });

    it('keeps an agent alive while it only watches, which is what polling looks like', async () => {
      await register(MAIN_WT);
      const past = new Date(Date.now() - 86_400_000).toISOString();
      await exec(`UPDATE git_worktrees SET expires_at = '${past}' WHERE worktree_path = '${MAIN_WT}'`);

      // The shape this feature exists for: an agent mid-task polling git_list to
      // notice a peer. It touches no other tool for an hour, and reaping it for
      // "silence" while it is looking straight at us would be exactly wrong.
      const listed = (await svc.list({ scope: 'host', worktree_path: MAIN_WT }, host)) as Record<string, unknown>;
      const clone = (listed['clones'] as Array<Record<string, unknown>>)[0]!;
      expect((clone['worktrees'] as unknown[])).toHaveLength(1);

      const row = rowsOf(
        await exec(`SELECT status, expires_at FROM git_worktrees WHERE worktree_path = '${MAIN_WT}'`),
      )[0]!;
      expect(row['status']).toBe('active');
      expect(String(row['expires_at']) > past).toBe(true);
    });

    it('lets an unregistered path look around without erroring', async () => {
      // git_list is how an agent looks BEFORE it registers; refusing an unknown
      // worktree_path would invert the order the guidance tells it to work in.
      const listed = (await svc.list({ scope: 'host', worktree_path: '/srv/ztest-gd/never-seen' }, host)) as Record<
        string,
        unknown
      >;
      expect(listed['scope']).toBe('host');
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

  it('re-decides a waiting request in place instead of minting a row per poll', async () => {
    await register(MAIN_WT);
    await register(LINKED_WT);
    await requestMerge(MAIN_WT, ['api/a.ts']);
    const waiting = (await requestMerge(LINKED_WT, ['api/a.ts'])) as Record<string, unknown>;
    const requestId = String(waiting['request_id']);

    const first = (await svc.mergeStatus({ request_id: requestId }, host)) as Record<string, unknown>;
    const second = (await svc.mergeStatus({ request_id: requestId }, host)) as Record<string, unknown>;

    // The id the caller was handed has to stay valid, or an agent following the
    // tool description polls a row that stops being updated.
    expect(first['request_id']).toBe(requestId);
    expect(second['request_id']).toBe(requestId);
    expect(second['verdict']).toBe('wait');

    // And each poll must not read as another contender. Left unchecked, the
    // queue shown to the arbiter grew the longer somebody waited.
    const rows = rowsOf(
      await exec(
        `SELECT id FROM git_merge_requests
          WHERE worktree_id = (SELECT id FROM git_worktrees WHERE worktree_path = '${LINKED_WT}')`,
      ),
    );
    expect(rows).toHaveLength(1);
    expect(Number(second['queue_depth'] ?? 0)).toBe(0);
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
