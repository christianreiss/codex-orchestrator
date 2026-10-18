import { GitDirectorService } from '../../../src/services/git-director.js';
import { SettingsService } from '../../../src/services/settings.js';
import { guardGitMutation } from '../../../src/services/agent-coordination/git-guard.js';
import { runMigrations } from '../../../src/db/migrator.js';
import type { GitClone, GitWorktree } from '../../../src/db/schema.js';
import { randomBytes, randomUUID } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  agentScopes,
  agentScopeMembers,
  agentScopeEvents,
  agentResourceClaims,
  agentSessions,
  agentBusMessages,
  hosts,
  versions,
} from '../../../src/db/schema.js';
import { AgentMessagingService } from '../../../src/services/agent-messaging.js';
import { AgentCoordination } from '../../../src/services/agent-coordination/index.js';
import { getTestDb } from '../../helpers/test-db.js';
import { loadTestEnv, testKeyring } from '../../helpers/test-keyring.js';
import { decrypt } from '../../../src/security/secret-box.js';
const handle = await getTestDb();
describe.skipIf(!handle)('scope coordination with real MySQL transactions', { timeout: 120000 }, () => {
  const env = loadTestEnv(),
    keyring = testKeyring();
  let bus: AgentMessagingService, service: AgentCoordination;
  let host: typeof hosts.$inferSelect;
  const sessions: string[] = [];
  const suffix = randomUUID();
  beforeAll(async () => {
    const db = handle!.db,
      now = new Date().toISOString();
    await db.insert(hosts).values({
      fqdn: `scope-${suffix}.example`,
      apiKey: randomBytes(32).toString('hex'),
      status: 'active',
      secure: 1,
      engines: 'codex,claude,grok',
      createdAt: now,
      updatedAt: now,
    });
    host = (
      await db
        .select()
        .from(hosts)
        .where(eq(hosts.fqdn, `scope-${suffix}.example`))
    )[0]!;
    bus = new AgentMessagingService(db, env, keyring);
    service = new AgentCoordination(db, env, keyring, bus);
    await db
      .insert(versions)
      .values({ name: 'agent_messaging_enabled', version: '1', updatedAt: now })
      .onDuplicateKeyUpdate({ set: { version: '1' } });
    await service.setEnabled(true);
  });
  async function register(engine: 'codex' | 'claude' | 'grok', root = `/tmp/scopes-${suffix}`) {
    const id = randomUUID(),
      token = randomBytes(32).toString('base64url');
    sessions.push(id);
    await bus.registerSession(host, {
      sessionId: id,
      bridgeToken: token,
      engine,
      username: id,
      cwd: root,
      invocationKind: 'interactive',
      workspace: {
        cwd: root,
        git_status: 'repository',
        git_root: root,
        git_common_dir: `${root}/.git`,
        origin_url: `ssh://git@example.org/scopes-${suffix}.git`,
      },
      adapterCapabilities: { scope_protocol_version: 1, execution_contract_version: 2 },
    });
    return { id, token };
  }
  afterAll(async () => {
    const db = handle!.db;
    if (!host) {
      await handle!.pool.end();
      return;
    }
    const scopes = await db
      .select()
      .from(agentScopes)
      .where(inArray(agentScopes.scopeKey, [`host:${host.id}`]));
    const memberships = await db
      .select()
      .from(agentScopeMembers)
      .where(inArray(agentScopeMembers.sessionId, sessions));
    const scopeIds = [...new Set([...scopes.map((s) => s.id), ...memberships.map((m) => m.scopeId)])];
    if (scopeIds.length) {
      await db.delete(agentScopeEvents).where(inArray(agentScopeEvents.scopeId, scopeIds));
      await db.delete(agentScopeMembers).where(inArray(agentScopeMembers.scopeId, scopeIds));
      await db.delete(agentScopes).where(inArray(agentScopes.id, scopeIds));
    }
    await db.delete(agentResourceClaims).where(inArray(agentResourceClaims.sessionId, sessions));
    await db
      .update(agentSessions)
      .set({ endedAt: new Date().toISOString() })
      .where(inArray(agentSessions.id, sessions));
    await service.setEnabled(false);
    await handle!.pool.end();
  });
  it('joins all three engines once, separates host/project, and reads a durable idempotent chat', async () => {
    const agents = await Promise.all([register('codex'), register('claude'), register('grok')]);
    const a = agents[0]!;
    const snapshot = await service.context(a.id, a.token);
    expect(snapshot.rooms).toHaveLength(2);
    for (const room of snapshot.rooms) expect(room.member_count).toBe(3);
    const again = await service.context(a.id, a.token);
    expect(again.rooms.map((r) => r.cursor)).toEqual(snapshot.rooms.map((r) => r.cursor));
    const room = snapshot.rooms.find((r) => r.kind === 'project')!;
    const body = {
      scope_id: room.id,
      content: 'coordinate the shared checkout',
      client_request_id: randomUUID(),
    };
    const first = await service.send(a.id, a.token, body);
    expect(await service.send(a.id, a.token, body)).toEqual(first);
    await expect(service.send(a.id, a.token, { ...body, content: 'changed' })).rejects.toThrow('Request ID');
    const history = await service.read(agents[1]!.id, agents[1]!.token, { scope_id: room.id });
    expect(history.events.filter((e) => e.kind === 'chat')).toHaveLength(1);
    const mail = await handle!.db
      .select()
      .from(agentBusMessages)
      .where(eq(agentBusMessages.targetSessionId, agents[1]!.id));
    expect(mail.some((m) => decrypt(m.contentEnc, keyring).includes(body.content))).toBe(true);
    expect(mail.every((m) => m.kind === 'presence_notice')).toBe(true);
  });
  it('pushes a changed member context once without changing room membership', async () => {
    const a = await register('codex');
    const before = await service.context(a.id, a.token);
    await handle!.db.update(agentSessions).set({ launchName: 'Jeanette' }).where(eq(agentSessions.id, a.id));
    const after = await service.context(a.id, a.token);
    expect(after.rooms.map((r) => r.id)).toEqual(before.rooms.map((r) => r.id));
    for (const room of after.rooms) {
      expect(room.cursor).toBe(before.rooms.find((r) => r.id === room.id)!.cursor + 1);
      const history = await service.read(a.id, a.token, { scope_id: room.id });
      expect(history.events.at(-1)).toMatchObject({
        kind: 'presence',
        body: { action: 'updated', name: 'Jeanette' },
      });
    }
    expect((await service.context(a.id, a.token)).rooms.map((r) => r.cursor)).toEqual(
      after.rooms.map((r) => r.cursor),
    );
  });
  it('atomically grants one overlapping writer, retains uncertain claims, and rejects stale generations', async () => {
    const [a, b] = await Promise.all([register('codex'), register('claude')]);
    const resources = [{ kind: 'path' as const, host_id: host.id, path: `/tmp/claims-${suffix}` }];
    const [x, y] = await Promise.all([
      service.claims.acquire(a!.id, a!.token, {
        resources,
        purpose: 'writer A',
        client_request_id: randomUUID(),
      }),
      service.claims.acquire(b!.id, b!.token, {
        resources,
        purpose: 'writer B',
        client_request_id: randomUUID(),
      }),
    ]);
    expect([x.state, y.state].sort()).toEqual(['active', 'waiting']);
    const owner = x.state === 'active' ? a! : b!,
      waiter = x.state === 'active' ? b! : a!;
    const held = x.state === 'active' ? x : y,
      waiting = x.state === 'active' ? y : x;
    await handle!.db
      .update(agentResourceClaims)
      .set({ createdAt: new Date(Date.now() - 121000).toISOString() })
      .where(eq(agentResourceClaims.id, waiting.id));
    expect(
      (await service.claims.status(waiter.id, waiter.token, { claim_id: waiting.id })).isolation_available,
    ).toBe(true);
    await service.claims.status(owner.id, owner.token, { claim_id: waiting.id, response: 'wait' });
    expect(
      (await service.claims.status(waiter.id, waiter.token, { claim_id: waiting.id })).isolation_available,
    ).toBe(false);
    await handle!.db
      .update(agentResourceClaims)
      .set({ expiresAt: new Date(Date.now() - 1000).toISOString() })
      .where(eq(agentResourceClaims.id, held.id));
    const uncertain = await service.claims.status(owner.id, owner.token, { claim_id: held.id });
    expect(uncertain.state).toBe('uncertain');
    await expect(
      service.claims.status(owner.id, owner.token, { claim_id: held.id, renew: true }),
    ).rejects.toThrow('Only a live claim');
    expect((await service.claims.status(waiter.id, waiter.token, { claim_id: waiting.id })).state).toBe(
      'waiting',
    );
    await service.claims.release(owner.id, owner.token, {
      claim_id: held.id,
      outcome: 'completed',
      reason: 'process confirmed ended',
    });
    expect((await service.claims.status(waiter.id, waiter.token, { claim_id: waiting.id })).state).toBe(
      'active',
    );
    await handle!.db
      .update(agentResourceClaims)
      .set({ generation: 999 })
      .where(eq(agentResourceClaims.id, waiting.id));
    await expect(
      service.claims.status(waiter.id, waiter.token, { claim_id: waiting.id, renew: true }),
    ).rejects.toThrow('older binding');
  });
  it('forbids unrelated room reads and removes ended sessions without waking replacements', async () => {
    const a = await register('grok');
    const snapshot = await service.context(a.id, a.token);
    const room = snapshot.rooms.find((r) => r.kind === 'project')!;
    await service.update(a.id, a.token, {
      workspace: { cwd: `/tmp/other-${suffix}`, git_status: 'none', git_root: null, git_common_dir: null },
    });
    await expect(service.read(a.id, a.token, { scope_id: room.id })).rejects.toThrow('not a member');
    await bus.finishSession(a.id, a.token, 'completed');
    await service.tick();
    const active = await handle!.db
      .select()
      .from(agentScopeMembers)
      .where(and(eq(agentScopeMembers.sessionId, a.id), eq(agentScopeMembers.state, 'active')));
    expect(active).toHaveLength(0);
  });
  it('paginates more than 64 peers and dispatches persisted events after a service restart', async () => {
    const peers = [];
    for (let i = 0; i < 65; i++)
      peers.push(await register(i % 3 === 0 ? 'codex' : i % 3 === 1 ? 'claude' : 'grok'));
    const a = peers[0]!;
    const snapshot = await service.context(a.id, a.token);
    const room = snapshot.rooms.find((r) => r.kind === 'project')!;
    expect(room.member_count).toBeGreaterThanOrEqual(65);
    const ids = new Set<string>();
    let offset: number | null = 0;
    while (offset !== null) {
      const page = await service.read(a.id, a.token, { scope_id: room.id, member_offset: offset });
      page.members.forEach((m) => ids.add(m.session_id));
      offset = page.next_member_offset;
    }
    expect(ids.size).toBe(room.member_count);
    const event = await service.run(a.id, a.token, (tx) =>
      service.event(tx, room.id, 'presence', a.id, { action: 'restart_test' }),
    );
    await handle!.db
      .update(agentScopeEvents)
      .set({ createdAt: new Date(Date.now() - 3000).toISOString() })
      .where(eq(agentScopeEvents.id, event.id));
    const restarted = new AgentCoordination(
      handle!.db,
      env,
      keyring,
      new AgentMessagingService(handle!.db, env, keyring),
    );
    await restarted.tick();
    const [stored] = await handle!.db
      .select()
      .from(agentScopeEvents)
      .where(eq(agentScopeEvents.id, event.id));
    expect(stored!.dispatched).toBe(1);
    const messages = await handle!.db
      .select()
      .from(agentBusMessages)
      .where(
        inArray(
          agentBusMessages.targetSessionId,
          peers.map((p) => p.id),
        ),
      );
    expect(
      new Set(
        messages
          .filter((m) => decrypt(m.contentEnc, keyring).includes('restart_test'))
          .map((m) => m.targetSessionId),
      ).size,
    ).toBe(65);
  });
  it('requires path and target branch claims at the Git Director mutation gate', async () => {
    const a = await register('codex', `/tmp/guard-${suffix}`);
    const [session] = await handle!.db.select().from(agentSessions).where(eq(agentSessions.id, a.id));
    const clone = { hostId: host.id, cloneDir: `/tmp/guard-${suffix}/.git` } as GitClone;
    const worktree = {
      agentBusAddressId: session!.agentBusAddressId,
      worktreePath: `/tmp/guard-${suffix}`,
    } as GitWorktree;
    const check = () =>
      service.run(a.id, a.token, (tx) => guardGitMutation(tx, clone, worktree, 'main', ['src/a.ts']));
    await expect(check()).rejects.toThrow('Acquire live path');
    const claim = await service.claims.acquire(a.id, a.token, {
      purpose: 'guarded merge',
      client_request_id: randomUUID(),
      resources: [
        { kind: 'path', host_id: host.id, path: `/tmp/guard-${suffix}/src` },
        { kind: 'git', host_id: host.id, common_dir: clone.cloneDir, branch: 'main' },
      ],
    });
    expect(claim.state).toBe('active');
    await expect(check()).resolves.toBeUndefined();
    await handle!.db
      .update(agentResourceClaims)
      .set({ expiresAt: new Date(Date.now() - 1).toISOString() })
      .where(eq(agentResourceClaims.id, claim.id));
    await expect(check()).rejects.toThrow('reserved or uncertain');
  });
  it('binds the Git Director to an explicitly moved worktree and guards the real merge request', async () => {
    const source = `/tmp/move-source-${suffix}`,
      target = `/tmp/move-target-${suffix}`;
    const a = await register('codex', source);
    await service.update(a.id, a.token, {
      workspace: {
        cwd: target,
        git_status: 'repository',
        git_root: target,
        git_common_dir: source + '/.git',
        origin_url: `ssh://git@example.org/scopes-${suffix}.git`,
      },
    });
    const db = handle!.db;
    await db
      .insert(versions)
      .values({ name: 'git_director_enabled', version: '1', updatedAt: new Date().toISOString() })
      .onDuplicateKeyUpdate({ set: { version: '1' } });
    const director = new GitDirectorService({ db, settings: new SettingsService(db) });
    await director.register(
      {
        worktree_path: target,
        clone_dir: source + '/.git',
        repo_root: source,
        username: a.id,
        engine: 'codex',
        branch: 'feature',
      },
      host,
    );
    const args = {
      worktree_path: target,
      target_branch: 'main',
      client_request_id: randomUUID(),
      base_sha: 'a'.repeat(40),
      head_sha: 'b'.repeat(40),
      changed_paths: ['a.ts'],
    };
    await expect(director.requestMerge(args, host)).rejects.toThrow('Acquire live path');
    const claim = await service.claims.acquire(a.id, a.token, {
      purpose: 'merge moved worktree',
      client_request_id: randomUUID(),
      resources: [
        { kind: 'path', host_id: host.id, path: target },
        { kind: 'git', host_id: host.id, common_dir: source + '/.git', branch: 'main' },
      ],
    });
    expect(claim.state).toBe('active');
    const result = await director.requestMerge(args, host);
    expect(result.verdict).toBe('allow');
    await director.release({ worktree_path: target }, host);
    await service.claims.release(a.id, a.token, {
      claim_id: claim.id,
      outcome: 'completed',
      reason: 'test completed',
    });
  });
  it('reapplies migration 0078 safely through the canonical runner', async () => {
    const { mkdtemp, copyFile, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const directory = await mkdtemp(join(tmpdir(), 'scope-migration-'));
    try {
      await copyFile(
        'src/db/migrations/0078_agent_scope_coordination.sql',
        join(directory, '0078_agent_scope_coordination.sql'),
      );
      await runMigrations(handle!.pool, { dir: directory, appliedBy: 'scope-test' });
      const result = await runMigrations(handle!.pool, {
        dir: directory,
        appliedBy: 'scope-test-reapply',
        reapply: ['0078'],
      });
      expect(result.drifted).toHaveLength(0);
      expect(result.outcomes).toHaveLength(1);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  it('keeps an ended owners uncertain claim reachable through its empty room', async () => {
    const a = await register('codex', `/tmp/ended-${suffix}`);
    await service.update(a.id, a.token, {
      workspace: { cwd: `/tmp/ended-${suffix}`, git_status: 'none', git_root: null, git_common_dir: null },
    });
    const before = await service.context(a.id, a.token);
    const project = before.rooms.find((r) => r.kind === 'project')!;
    const claim = await service.claims.acquire(a.id, a.token, {
      purpose: 'unfinished',
      client_request_id: randomUUID(),
      resources: [{ kind: 'service', host_id: host.id, service: 'ended-owner' }],
    });
    await handle!.db
      .update(agentSessions)
      .set({ endedAt: new Date().toISOString() })
      .where(eq(agentSessions.id, a.id));
    const snapshot = await service.context(null, null);
    expect(snapshot.rooms.find((r) => r.id === project.id)?.member_count).toBe(0);
    expect(snapshot.claims.find((c) => c.id === claim.id)).toMatchObject({
      state: 'uncertain',
      scope_ids: expect.arrayContaining([project.id]),
    });
  });
  it('feature off rejects new work but permits releasing claims', async () => {
    const a = await register('codex');
    const claim = await service.claims.acquire(a.id, a.token, {
      purpose: 'service op',
      resources: [{ kind: 'service', host_id: host.id, service: suffix }],
      client_request_id: randomUUID(),
    });
    await service.setEnabled(false);
    await expect(
      service.claims.acquire(a.id, a.token, {
        purpose: 'new',
        resources: [{ kind: 'service', host_id: host.id, service: 'new' }],
        client_request_id: randomUUID(),
      }),
    ).rejects.toThrow('disabled');
    expect(
      (
        await service.claims.release(a.id, a.token, {
          claim_id: claim.id,
          outcome: 'completed',
          reason: 'done',
        })
      ).state,
    ).toBe('released');
    await service.setEnabled(true);
  });
});
