import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  adminEvents,
  agentBusAddresses,
  agentBusMessages,
  agentSessions,
  gitClones,
  gitMergeRequests,
  gitWorktrees,
  hosts,
  versions,
  type Host,
} from '../../../src/db/schema.js';
import { GitDirectorService } from '../../../src/services/git-director.js';
import { GitDirectorNotifications } from '../../../src/services/git-director/notifications.js';
import { AgentMessagingService } from '../../../src/services/agent-messaging.js';
import { SettingsService } from '../../../src/services/settings.js';
import { splitSqlStatements } from '../../../src/db/migration-sql.js';
import { decrypt } from '../../../src/security/secret-box.js';
import { wsPublisher } from '../../../src/ws/publisher.js';
import { getTestDb } from '../../helpers/test-db.js';
import { loadTestEnv, testKeyring } from '../../helpers/test-keyring.js';

const handle = await getTestDb();
const keyring = testKeyring();
const suffix = randomUUID();
const now = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
type Peer = { sessionId: string; path: string; addressId: string; common: string };

describe.skipIf(!handle)('Git Director transactional agent notifications', () => {
  let host: Host;
  let bus: AgentMessagingService;
  let director: GitDirectorService;
  const peers: Peer[] = [];
  const db = handle?.db;
  const root = `/tmp/git-notices-${suffix}`;

  beforeAll(async () => {
    // Apply the new migration twice: existing installations and retries agree.
    for (const name of ['0087_git_worktree_notice_binding.sql', '0088_git_merge_reported_outcome.sql']) {
      const migration = readFileSync(new URL(`../../../src/db/migrations/${name}`, import.meta.url), 'utf8');
      for (let i = 0; i < 2; i++)
        for (const statement of splitSqlStatements(migration)) await db!.execute(sql.raw(statement));
    }
    const stamp = now();
    await db!.insert(hosts).values({
      fqdn: `git-notices-${suffix}.example`,
      apiKey: randomBytes(32).toString('hex'),
      status: 'active',
      secure: 1,
      engines: 'codex,claude,grok',
      createdAt: stamp,
      updatedAt: stamp,
    });
    host = (
      await db!
        .select()
        .from(hosts)
        .where(eq(hosts.fqdn, `git-notices-${suffix}.example`))
    )[0]!;
    await db!
      .insert(versions)
      .values({ name: 'agent_messaging_enabled', version: '1', updatedAt: stamp })
      .onDuplicateKeyUpdate({ set: { version: '1' } });
    bus = new AgentMessagingService(db!, loadTestEnv(), keyring);
    director = new GitDirectorService({
      db: db!,
      settings: new SettingsService(db!),
      notifications: new GitDirectorNotifications(bus),
      now,
    });
  });

  async function peer(
    engine: 'codex' | 'claude' | 'grok' = 'codex',
    common = `${root}/.git`,
    remote = `ssh://git@example.test/${suffix}.git`,
  ) {
    const path = `${root}/wt-${peers.length}`;
    const sessionId = randomUUID();
    const result = await bus.registerSession(host, {
      sessionId,
      bridgeToken: randomBytes(32).toString('base64url'),
      engine,
      username: sessionId,
      cwd: path,
      invocationKind: 'interactive',
      workspace: {
        cwd: path,
        git_status: 'repository',
        git_root: path,
        git_common_dir: common,
        branch: 'topic',
        origin_url: remote,
      },
      adapterCapabilities: { execution_contract_version: 2 },
    });
    const p = { sessionId, path, common, addressId: (result.address as { id: string }).id };
    peers.push(p);
    await director.register(
      {
        worktree_path: path,
        clone_dir: common,
        repo_root: root,
        remote_url: remote,
        branch: 'topic',
        engine,
        username: sessionId,
      },
      host,
    );
    return p;
  }
  async function messages(p: Peer) {
    const rows = await db!
      .select()
      .from(agentBusMessages)
      .where(eq(agentBusMessages.targetSessionId, p.sessionId));
    return rows
      .map((row) => ({ row, text: decrypt(row.contentEnc, keyring) }))
      .filter((m) => m.text.startsWith('GIT-DIRECTOR/1'))
      .map((m) => ({ ...m, event: JSON.parse(m.text.split('\n').at(-1)!) as Record<string, unknown> }))
      .sort((a, b) => Number(a.event.revision) - Number(b.event.revision));
  }
  const merge = (p: Peer, target = 'main', clientId = randomUUID()) =>
    director.requestMerge(
      {
        worktree_path: p.path,
        target_branch: target,
        changed_paths: ['shared.ts'],
        client_request_id: clientId,
      },
      host,
    );
  const join = (p: Peer, paths: string[], target = 'main') =>
    director.join({ worktree_path: p.path, target_branch: target, paths }, host);

  it('notifies live Codex, Claude and Grok peers about substantive scope changes once', async () => {
    const a = await peer('codex'),
      b = await peer('claude'),
      c = await peer('grok');
    const outsider = await peer('codex', `${root}/other/.git`, 'ssh://git@example.test/unrelated.git');
    await join(b, ['shared.ts']);
    await join(c, ['shared.ts']);
    const before = (await messages(b)).length;
    await join(a, ['shared.ts']);
    expect((await messages(b)).length).toBe(before + 1);
    expect((await messages(c)).at(-1)!.event.kind).toBe('work_scope_changed');
    expect(await messages(outsider)).toHaveLength(0);
    const count = (await messages(b)).length;
    await join(a, ['shared.ts']);
    await director.list({ worktree_path: a.path, head_sha: 'a'.repeat(40) }, host);
    expect((await messages(b)).length).toBe(count);
    const notice = (await messages(b)).at(-1)!;
    expect(notice.row).toMatchObject({ kind: 'presence_notice', targetBindingGeneration: 1 });
    expect(notice.event.revision).toEqual(expect.any(Number));
  });

  it('notifies only affected waiters on release and keeps polling authoritative', async () => {
    const common = `${root}/release/.git`;
    const holder = await peer('codex', common),
      waiter = await peer('claude', common),
      otherBranch = await peer('grok', common),
      remotePeer = await peer('codex', `${root}/remote/.git`);
    await join(holder, ['shared.ts']);
    await join(waiter, ['shared.ts']);
    await join(otherBranch, ['shared.ts'], 'develop');
    await join(remotePeer, ['shared.ts']);
    const held = await merge(holder),
      waiting = await merge(waiter);
    expect(held.verdict).toBe('allow');
    expect(waiting.verdict).toBe('wait');
    const branchBefore = (await messages(otherBranch)).length,
      remoteBefore = (await messages(remotePeer)).length;
    await director.release({ request_id: held.request_id }, host);
    expect((await messages(waiter)).at(-1)!.event).toMatchObject({
      kind: 'merge_released',
      merge_outcome: 'unknown',
      recheck_required: true,
    });
    expect((await messages(otherBranch)).length).toBe(branchBefore);
    expect((await messages(remotePeer)).length).toBe(remoteBefore);
    const count = (await messages(waiter)).length;
    await director.release({ request_id: held.request_id }, host);
    expect((await messages(waiter)).length).toBe(count);
    expect((await director.mergeStatus({ request_id: waiting.request_id }, host)).verdict).toBe('allow');
  });

  it('suppresses identical merge retries and unchanged wait polls', async () => {
    const common = `${root}/retry/.git`,
      holder = await peer('codex', common),
      waiter = await peer('claude', common);
    await join(holder, ['shared.ts']);
    await join(waiter, ['shared.ts']);
    await merge(holder);
    const id = randomUUID(),
      waiting = await merge(waiter, 'main', id);
    const count = (await messages(holder)).length;
    await merge(waiter, 'main', id);
    await director.mergeStatus({ request_id: waiting.request_id }, host);
    expect((await messages(holder)).length).toBe(count);
  });

  it('reports an expired live lease once to its exact owner and waiting peer', async () => {
    const common = `${root}/expiry/.git`,
      holder = await peer('codex', common),
      waiter = await peer('claude', common);
    const grant = await merge(holder);
    await merge(waiter);
    await db!
      .update(gitMergeRequests)
      .set({ leaseExpiresAt: '2000-01-01T00:00:00Z' })
      .where(eq(gitMergeRequests.id, grant.request_id as string));
    await director.list({ scope: 'host' }, host);
    const notice = (await messages(holder)).at(-1)!;
    expect(notice.event.kind).toBe('lease_expired');
    expect(notice.row.deliveryClass).toBe('coordination');
    expect((await messages(waiter)).at(-1)!.event.kind).toBe('lease_expired');
    const count = (await messages(holder)).length;
    await director.list({}, host);
    expect((await messages(holder)).length).toBe(count);
  });

  it('notifies forced decisions and eviction without inventing revocation of other grants', async () => {
    const common = `${root}/admin/.git`,
      holder = await peer('codex', common),
      waiter = await peer('claude', common);
    const grant = await merge(holder);
    const pending = await merge(waiter);
    await expect(director.adminDecide(pending.request_id as string, 'allow', 'operator review'))
      .rejects.toMatchObject({ code: 'git_director_lease_held' });
    expect((await messages(waiter)).some((message) => message.event.kind === 'operator_decision')).toBe(false);
    await director.release({ request_id: grant.request_id }, host);
    await director.adminDecide(pending.request_id as string, 'allow', 'operator review');
    expect((await messages(waiter)).at(-1)!.event).toMatchObject({
      kind: 'operator_decision',
      other_leases_revoked: false,
    });
    expect((await messages(holder)).some((message) => message.event.kind === 'operator_decision')).toBe(false);
    const [worktree] = await db!
      .select()
      .from(gitWorktrees)
      .where(eq(gitWorktrees.worktreePath, holder.path));
    await director.adminEvictWorktree(worktree!.id);
    expect((await messages(holder)).at(-1)!.event.kind).toBe('operator_eviction');
  });

  it('does not retarget ownership notices to a later binding', async () => {
    const holder = await peer('codex', `${root}/binding/.git`);
    const grant = await merge(holder);
    await db!
      .update(agentBusAddresses)
      .set({ bindingGeneration: 2 })
      .where(eq(agentBusAddresses.id, holder.addressId));
    await db!
      .update(agentSessions)
      .set({ bindingGeneration: 2 })
      .where(eq(agentSessions.id, holder.sessionId));
    await db!
      .update(gitMergeRequests)
      .set({ leaseExpiresAt: '2000-01-01T00:00:00Z' })
      .where(eq(gitMergeRequests.id, grant.request_id as string));
    const count = (await messages(holder)).length;
    await director.list({}, host);
    expect((await messages(holder)).length).toBe(count);
  });

  it('isolates a notification failure without losing the Director mutation or leaking a partial notice', async () => {
    const common = `${root}/failure/.git`,
      a = await peer('codex', common),
      b = await peer('claude', common);
    const failing = new GitDirectorService({
      db: db!,
      settings: new SettingsService(db!),
      notifications: new GitDirectorNotifications({
        coordinationNotice: async (tx, session, content) => {
          const key = randomUUID();
          await bus.coordinationNotice(tx, session, content, false, key);
          return bus.coordinationNotice(tx, session, content, false, key);
        },
      }),
      now,
    });
    const count = (await messages(b)).length;
    await failing.join({ worktree_path: a.path, target_branch: 'main', paths: ['changed.ts'] }, host);
    const [worktree] = await db!.select().from(gitWorktrees).where(eq(gitWorktrees.worktreePath, a.path));
    expect(worktree!.declaredPaths).toEqual(['changed.ts']);
    expect((await messages(b)).length).toBe(count);
    const audit = await db!.select().from(adminEvents).where(eq(adminEvents.hostId, host.id));
    expect(
      audit.some((row) => (row.payload as Record<string, unknown>)?.reason === 'notification_failed'),
    ).toBe(true);
  });

  it('rolls back queued notices with state and emits no pre-commit invalidation', async () => {
    const common = `${root}/rollback/.git`,
      a = await peer('codex', common),
      b = await peer('claude', common);
    const [clone] = await db!.select().from(gitClones).where(eq(gitClones.cloneDir, common));
    const [worktree] = await db!.select().from(gitWorktrees).where(eq(gitWorktrees.worktreePath, a.path));
    const count = (await messages(b)).length;
    await expect(
      db!.transaction(async (tx) => {
        await new GitDirectorNotifications(bus).enqueue(
          tx,
          { kind: 'test_rollback', clone, worktree, audience: 'repository' },
          now(),
        );
        throw new Error('rollback');
      }),
    ).rejects.toThrow('rollback');
    expect((await messages(b)).length).toBe(count);
    const emitted: string[] = [];
    const original = bus.coordinationNotice.bind(bus);
    const spy = vi.spyOn(bus, 'coordinationNotice').mockImplementation(async (...args) => {
      // Other DB connections cannot see uncommitted messages.
      expect(emitted).toHaveLength(0);
      return original(...args);
    });
    const unsubscribe = wsPublisher.subscribe((event) => {
      if (event.type === 'agent_messaging.message.changed') emitted.push(event.type);
    });
    try {
      await join(a, ['commit.ts']);
      expect(emitted.length).toBeGreaterThan(0);
    } finally {
      spy.mockRestore();
      unsubscribe();
    }
  });

  it('keeps Director operations usable with messaging disabled and does not wake ended sessions', async () => {
    const common = `${root}/off/.git`,
      a = await peer('codex', common),
      b = await peer('claude', common);
    await db!.update(agentSessions).set({ endedAt: now() }).where(eq(agentSessions.id, b.sessionId));
    const count = (await messages(b)).length;
    await join(a, ['ended.ts']);
    expect((await messages(b)).length).toBe(count);
    await db!.update(versions).set({ version: '0' }).where(eq(versions.name, 'agent_messaging_enabled'));
    try {
      await expect(join(a, ['offline.ts'])).resolves.toMatchObject({ joined: true });
    } finally {
      await db!.update(versions).set({ version: '1' }).where(eq(versions.name, 'agent_messaging_enabled'));
    }
  });

  it('requires a target SHA for reported completion and labels it as an agent report', async () => {
    const common = `${root}/completion/.git`,
      a = await peer('codex', common),
      b = await peer('claude', common);
    await join(b, ['shared.ts']);
    const grant = await merge(a);
    await expect(
      director.release({ request_id: grant.request_id, worktree_path: a.path, outcome: 'merged' }, host),
    ).rejects.toThrow('target_head_sha');
    await director.release(
      {
        request_id: grant.request_id,
        worktree_path: a.path,
        outcome: 'merged',
        target_head_sha: 'b'.repeat(40),
      },
      host,
    );
    expect((await messages(b)).at(-1)!.event).toMatchObject({
      kind: 'merge_reported',
      merge_outcome: 'merged',
      target_head_sha: 'b'.repeat(40),
      evidence: 'agent_reported',
    });
  });

  it('notifies both old and new branch peers about scope removal without treating declarations as locks', async () => {
    const common = `${root}/scope-switch/.git`,
      a = await peer('codex', common),
      oldPeer = await peer('claude', common),
      newPeer = await peer('grok', common);
    await join(oldPeer, ['docs'], 'main');
    await join(newPeer, ['api'], 'develop');
    const overlap = await join(a, ['docs/x.md', 'api/x.ts']);
    expect(overlap.peer_overlap).toEqual(
      expect.arrayContaining([expect.objectContaining({ worktree_path: oldPeer.path })]),
    );
    const oldCount = (await messages(oldPeer)).length,
      newCount = (await messages(newPeer)).length;
    await join(a, ['api/x.ts'], 'develop');
    expect((await messages(oldPeer)).length).toBe(oldCount + 1);
    expect((await messages(newPeer)).length).toBe(newCount + 1);
    expect((await messages(oldPeer)).at(-1)!.event.previous_paths).toContain('docs/x.md');
    const count = (await messages(newPeer)).length;
    await director.join({ worktree_path: a.path, task: 'new title only' }, host);
    expect((await messages(newPeer)).length).toBe(count);
  });

  it('suppresses registration and deregistration retries and exposes superseded requests in the reply', async () => {
    const common = `${root}/supersede/.git`,
      a = await peer('codex', common),
      b = await peer('claude', common);
    await merge(a);
    const pending = await merge(b);
    const registered = await director.register(
      {
        worktree_path: b.path,
        clone_dir: `${common}-corrected`,
        branch: 'topic',
        engine: 'claude',
        username: b.sessionId,
      },
      host,
    );
    expect(registered.superseded_registrations).toEqual([
      expect.objectContaining({ withdrawn_request_ids: [pending.request_id] }),
    ]);
    await director.release({ worktree_path: b.path, deregister: true }, host);
    await director.release({ worktree_path: b.path, deregister: true }, host);
    const [worktree] = await db!
      .select()
      .from(gitWorktrees)
      .where(and(eq(gitWorktrees.worktreePath, b.path), eq(gitWorktrees.status, 'released')));
    expect(worktree).toBeDefined();
  });

  it('delivers module Off/On transitions once and exposes a revision watermark', async () => {
    const a = await peer('codex', `${root}/toggle/.git`);
    await director.setEnabled(true);
    await director.setEnabled(false);
    const count = (await messages(a)).length;
    await director.setEnabled(false);
    expect((await messages(a)).length).toBe(count);
    const snapshot = await director.list({}, host);
    expect(snapshot.coordination_revision).toBeGreaterThanOrEqual(
      Number((await messages(a)).at(-1)!.event.revision),
    );
  });

  it('propagates transaction failures instead of returning false success', async () => {
    const common = `${root}/db-error/.git`,
      a = await peer('codex', common);
    await peer('claude', common);
    const failing = new GitDirectorService({
      db: db!,
      settings: new SettingsService(db!),
      notifications: new GitDirectorNotifications({
        coordinationNotice: async () => {
          throw Object.assign(new Error('database unavailable'), { code: 'ER_LOCK_DEADLOCK' });
        },
      }),
      now,
    });
    await expect(failing.join({ worktree_path: a.path, paths: ['rollback.ts'] }, host)).rejects.toThrow(
      'database unavailable',
    );
    const [worktree] = await db!.select().from(gitWorktrees).where(eq(gitWorktrees.worktreePath, a.path));
    expect(worktree!.declaredPaths).toBeNull();
  });

  it('backfills a legacy same-owner registration without invalidating its live lease', async () => {
    const holder = await peer('codex', `${root}/legacy-binding/.git`);
    const grant = await merge(holder);
    await db!
      .update(gitWorktrees)
      .set({ agentSessionId: null, agentBindingGeneration: null })
      .where(eq(gitWorktrees.worktreePath, holder.path));
    const registered = await director.register(
      {
        worktree_path: holder.path,
        clone_dir: holder.common,
        branch: 'topic',
        engine: 'codex',
        username: holder.sessionId,
      },
      host,
    );
    expect(registered.rebound).toBe(false);
    expect((await director.mergeStatus({ request_id: grant.request_id }, host)).verdict).toBe('allow');
    const [worktree] = await db!
      .select()
      .from(gitWorktrees)
      .where(eq(gitWorktrees.worktreePath, holder.path));
    expect(worktree!.agentSessionId).toBe(holder.sessionId);
  });

  it('withdraws old waiting requests on a real binding change instead of inheriting them', async () => {
    const common = `${root}/real-rebind/.git`,
      holder = await peer('codex', common),
      waiter = await peer('claude', common);
    await merge(holder);
    const pending = await merge(waiter);
    await db!
      .update(agentBusAddresses)
      .set({ bindingGeneration: 2 })
      .where(eq(agentBusAddresses.id, waiter.addressId));
    await db!
      .update(agentSessions)
      .set({ bindingGeneration: 2 })
      .where(eq(agentSessions.id, waiter.sessionId));
    const registered = await director.register(
      {
        worktree_path: waiter.path,
        clone_dir: common,
        branch: 'topic',
        engine: 'claude',
        username: waiter.sessionId,
      },
      host,
    );
    expect(registered).toMatchObject({ rebound: true, withdrawn_request_ids: [pending.request_id] });
    expect((await director.mergeStatus({ request_id: pending.request_id }, host)).verdict).toBe('withdrawn');
  });

  it('does not deliver old-owner notices to the replacement binding during register', async () => {
    const common = `${root}/notice-rebind/.git`,
      holder = await peer('codex', common),
      waiter = await peer('claude', common);
    await merge(holder);
    await merge(waiter);
    await db!
      .update(agentBusAddresses)
      .set({ bindingGeneration: 2 })
      .where(eq(agentBusAddresses.id, waiter.addressId));
    await db!
      .update(agentSessions)
      .set({ bindingGeneration: 2 })
      .where(eq(agentSessions.id, waiter.sessionId));
    const count = (await messages(waiter)).length;
    await director.register(
      {
        worktree_path: waiter.path,
        clone_dir: common,
        branch: 'topic',
        engine: 'claude',
        username: waiter.sessionId,
      },
      host,
    );
    expect((await messages(waiter)).length).toBe(count);
  });

  it('does not supersede an already superseded mapping again on register retry', async () => {
    const a = await peer('codex', `${root}/supersede-once/.git`);
    const args = {
      worktree_path: a.path,
      clone_dir: `${a.common}-new`,
      branch: 'topic',
      engine: 'codex',
      username: a.sessionId,
    };
    await director.register(args, host);
    const count = (await messages(a)).length;
    const auditCount = (
      await db!.select().from(adminEvents).where(eq(adminEvents.type, 'git_director.notifications'))
    ).length;
    expect((await director.register(args, host)).superseded_registrations).toEqual([]);
    expect((await messages(a)).length).toBe(count);
    expect(
      (await db!.select().from(adminEvents).where(eq(adminEvents.type, 'git_director.notifications'))).length,
    ).toBe(auditCount);
  });

  it('includes queued waiters in completion notices even after their declared target changes', async () => {
    const common = `${root}/completion-waiter/.git`,
      a = await peer('codex', common),
      b = await peer('claude', common);
    const grant = await merge(a);
    await merge(b);
    await join(b, ['shared.ts'], 'develop');
    await director.release(
      {
        request_id: grant.request_id,
        worktree_path: a.path,
        outcome: 'merged',
        target_head_sha: 'c'.repeat(40),
      },
      host,
    );
    expect((await messages(b)).at(-1)!.event).toMatchObject({
      kind: 'merge_reported',
      merge_outcome: 'merged',
      recheck_required: true,
    });
  });

  it('persists and notifies the first completion after lease expiry without reviving it', async () => {
    const common = `${root}/late-completion/.git`,
      a = await peer('codex', common),
      b = await peer('claude', common);
    const grant = await merge(a);
    await merge(b);
    await db!
      .update(gitMergeRequests)
      .set({ leaseExpiresAt: '2000-01-01T00:00:00Z' })
      .where(eq(gitMergeRequests.id, grant.request_id as string));
    const args = {
      request_id: grant.request_id,
      worktree_path: a.path,
      outcome: 'merged',
      target_head_sha: 'd'.repeat(40),
    };
    expect(await director.release(args, host)).toMatchObject({ released: 0, reported: true });
    expect((await messages(b)).at(-1)!.event.kind).toBe('merge_reported');
    const count = (await messages(b)).length;
    expect(await director.release(args, host)).toMatchObject({ released: 0, reported: false });
    expect((await messages(b)).length).toBe(count);
    expect(await director.mergeStatus({ request_id: grant.request_id }, host)).toMatchObject({
      verdict: 'expired',
      reported_outcome: 'merged',
      reported_target_head_sha: 'd'.repeat(40),
    });
    await expect(director.release({ ...args, outcome: 'aborted' }, host)).rejects.toThrow(
      'different outcome',
    );
  });

  it('checks report path and prior grant and permits refinement of an unknown outcome', async () => {
    const common = `${root}/report-checks/.git`,
      a = await peer('codex', common),
      b = await peer('claude', common);
    const grant = await merge(a),
      waiting = await merge(b);
    await expect(
      director.release(
        {
          request_id: grant.request_id,
          worktree_path: b.path,
          outcome: 'merged',
          target_head_sha: 'a'.repeat(40),
        },
        host,
      ),
    ).rejects.toThrow('worktree_path');
    await expect(
      director.release(
        {
          request_id: waiting.request_id,
          worktree_path: b.path,
          outcome: 'merged',
          target_head_sha: 'a'.repeat(40),
        },
        host,
      ),
    ).rejects.toThrow('held a lease');
    await director.release({ request_id: grant.request_id, worktree_path: a.path, outcome: 'unknown' }, host);
    expect(
      await director.release(
        {
          request_id: grant.request_id,
          worktree_path: a.path,
          outcome: 'merged',
          target_head_sha: 'a'.repeat(40),
        },
        host,
      ),
    ).toMatchObject({ reported: true });
  });

  afterAll(async () => {
    if (!host) {
      await handle?.pool.end();
      return;
    }
    const ids = peers.map((p) => p.sessionId);
    await db!.delete(gitMergeRequests).where(
      inArray(
        gitMergeRequests.worktreeId,
        (await db!.select().from(gitWorktrees).where(eq(gitWorktrees.hostId, host.id))).map((w) => w.id),
      ),
    );
    await db!.delete(gitWorktrees).where(eq(gitWorktrees.hostId, host.id));
    await db!.delete(gitClones).where(eq(gitClones.hostId, host.id));
    await db!.delete(adminEvents).where(eq(adminEvents.hostId, host.id));
    await db!.execute(
      sql`UPDATE agent_name_pool SET current_session_id = NULL WHERE current_session_id IN (SELECT id FROM agent_sessions WHERE host_id = ${host.id})`,
    );
    await db!.execute(
      sql`DELETE FROM agent_name_leases WHERE address_id IN (SELECT id FROM agent_bus_addresses WHERE host_id = ${host.id})`,
    );
    await db!.execute(
      sql`DELETE FROM agent_bus_messages WHERE target_address_id IN (SELECT id FROM agent_bus_addresses WHERE host_id = ${host.id}) OR sender_address_id IN (SELECT id FROM agent_bus_addresses WHERE host_id = ${host.id})`,
    );
    await db!.execute(
      sql`DELETE FROM agent_bus_conversations WHERE address_a_id IN (SELECT id FROM agent_bus_addresses WHERE host_id = ${host.id}) OR address_b_id IN (SELECT id FROM agent_bus_addresses WHERE host_id = ${host.id})`,
    );
    for (const table of ['agent_events', 'agent_messages', 'agent_prompts'])
      await db!.execute(
        sql.raw(`DELETE FROM ${table} WHERE session_id IN (${ids.map((id) => `'${id}'`).join(',')})`),
      );
    await db!.delete(agentSessions).where(eq(agentSessions.hostId, host.id));
    await db!.delete(agentBusAddresses).where(eq(agentBusAddresses.hostId, host.id));
    await db!.delete(hosts).where(eq(hosts.id, host.id));
    await handle!.pool.end();
  });
});
