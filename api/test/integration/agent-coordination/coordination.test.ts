import { registerCoordinationRoutes } from '../../../src/routes/agent-messaging/coordination.js';
import { GitDirectorService } from '../../../src/services/git-director.js';
import { SettingsService } from '../../../src/services/settings.js';
import { guardGitMutation } from '../../../src/services/agent-coordination/git-guard.js';
import { runMigrations } from '../../../src/db/migrator.js';
import type { GitClone, GitWorktree } from '../../../src/db/schema.js';
import { randomBytes, randomUUID } from 'node:crypto';
import { isNull, and, eq, inArray, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/mysql2';
import * as schema from '../../../src/db/schema.js';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  agentScopes,
  agentScopeMembers,
  agentScopeEvents,
  agentResourceClaims,
  agentSessions,
  agentBusMessages,
  adminEvents,
  agentNamePool,
  hosts,
  versions,
} from '../../../src/db/schema.js';
import { AgentMessagingService } from '../../../src/services/agent-messaging.js';
import { AgentCoordination } from '../../../src/services/agent-coordination/index.js';
import { getTestDb } from '../../helpers/test-db.js';
import { loadTestEnv, testKeyring } from '../../helpers/test-keyring.js';
import { decrypt, encrypt } from '../../../src/security/secret-box.js';
import { repositoryIdentity } from '../../../src/services/agent-coordination/model.js';
import { sessionTaskTitles } from '../../../src/services/agent-messaging/task-titles.js';
import { coordinationTickInput } from '../../../src/services/agent-coordination/idle-tick.js';
import { readFile } from 'node:fs/promises';
import { splitSqlStatements } from '../../../src/db/migration-sql.js';
import { registerAgentPortalAdminHostRoutes } from '../../../src/routes/agent-portal/admin-host.js';
import { buildRouteApp } from '../../helpers/build-route-app.js';
import { UnauthorizedError, ConflictError } from '../../../src/http/errors.js';
import { wsPublisher } from '../../../src/ws/publisher.js';
const handle = await getTestDb();
describe.skipIf(!handle)('scope coordination with real MySQL transactions', { timeout: 120000 }, () => {
  const env = loadTestEnv(),
    keyring = testKeyring();
  let bus: AgentMessagingService, service: AgentCoordination;
  let host: typeof hosts.$inferSelect;
  const sessions: string[] = [];
  const suffix = randomUUID();
  beforeAll(async () => {
    // This suite is runnable on its own; self/remote-Git requires the seeded name leases.
    await runMigrations(handle!.pool);
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
    // Historical addresses are intentionally retained by the service. A test
    // must remove its own fleet records rather than polluting later discovery.
    await db.execute(sql`UPDATE agent_name_pool SET current_session_id = NULL WHERE current_session_id IN (SELECT id FROM agent_sessions WHERE host_id = ${host.id})`);
    await db.execute(sql`DELETE FROM agent_name_leases WHERE address_id IN (SELECT id FROM agent_bus_addresses WHERE host_id = ${host.id})`);
    await db.execute(sql`DELETE FROM agent_bus_messages WHERE sender_address_id IN (SELECT id FROM agent_bus_addresses WHERE host_id = ${host.id}) OR target_address_id IN (SELECT id FROM agent_bus_addresses WHERE host_id = ${host.id})`);
    await db.execute(sql`DELETE FROM agent_bus_conversations WHERE address_a_id IN (SELECT id FROM agent_bus_addresses WHERE host_id = ${host.id}) OR address_b_id IN (SELECT id FROM agent_bus_addresses WHERE host_id = ${host.id})`);
    await db.execute(sql`DELETE FROM agent_events WHERE session_id IN (SELECT id FROM agent_sessions WHERE host_id = ${host.id})`);
    await db.execute(sql`DELETE FROM agent_messages WHERE session_id IN (SELECT id FROM agent_sessions WHERE host_id = ${host.id})`);
    await db.execute(sql`DELETE FROM agent_prompts WHERE session_id IN (SELECT id FROM agent_sessions WHERE host_id = ${host.id})`);
    await db.delete(agentSessions).where(eq(agentSessions.hostId, host.id));
    await db.execute(sql`DELETE FROM agent_bus_addresses WHERE host_id = ${host.id}`);
    await db.delete(hosts).where(eq(hosts.id, host.id));
    await handle!.pool.end();
  });
  it('binds remote Git to the originating claim and fences traversal, wrong branches and foreign requests', async () => {
    const a = await register('codex');
    const fqdn = `remote-${randomUUID()}.test`;
    const now = new Date().toISOString();
    await handle!.db.insert(hosts).values({ fqdn, apiKey: randomBytes(32).toString('hex'), status: 'active', secure: 1, engines: 'codex', createdAt: now, updatedAt: now });
    const target = (await handle!.db.select().from(hosts).where(eq(hosts.fqdn, fqdn)))[0]!;
    const path = `/srv/remote-${suffix}`, common = path + '/.git';
    const claim = await service.claims.acquire(a.id, a.token, { client_request_id: randomUUID(), purpose: 'remote Git proof', resources: [
      { kind: 'path', host_id: target.id, path }, { kind: 'git', host_id: target.id, common_dir: common, branch: 'main' },
    ] });
    const app = await buildRouteApp();
    registerCoordinationRoutes(app, { db: handle!.db, env, keyring }, bus);
    const settings = new SettingsService(handle!.db);
    await settings.setFlag('git_director_enabled', true);
    const call = (operation: string, args: Record<string, unknown> = {}, overrides: Record<string, unknown> = {}) => app.inject({ method: 'POST',
      url: `/host/agent-sessions/${a.id}/agent-messaging/git/remote`, headers: { 'x-agent-bridge-token': a.token },
      payload: { target_host_id: target.id, claim_id: claim.id, common_dir: common, branch: 'main', operation,
        args: { worktree_path: path, ...args }, ...overrides } });
    try {
      for (const invalid of [path + '/../foreign', path + '//../foreign', path + '/bad\0path']) {
        const response = await call('register', { worktree_path: invalid });
        expect(response.statusCode, response.body).toBe(422);
      }
      expect((await call('register', {}, { claim_id: randomUUID() })).statusCode).toBe(409);
      const registered = await call('register', { branch: 'main', head_sha: 'a'.repeat(40), repo_root: path });
      expect(registered.statusCode, registered.body).toBe(200);
      expect(registered.json()).toMatchObject({ agent_address_bound: true });
      expect((await call('join', { target_branch: 'main', paths: ['fix.ts'], task: 'remote proof' })).statusCode).toBe(200);
      for (const enabled of [true, false]) {
        await service.setEnabled(enabled);
        expect((await call('merge_request', { target_branch: 'release', client_request_id: randomUUID(), changed_paths: ['fix.ts'] })).statusCode).toBe(403);
      }
      await service.setEnabled(true);
      const granted = await call('merge_request', { target_branch: 'main', client_request_id: randomUUID(), base_sha: 'a'.repeat(40), head_sha: 'a'.repeat(40), changed_paths: ['fix.ts'] });
      expect(granted.statusCode, granted.body).toBe(200);
      expect(granted.json()).toMatchObject({ verdict: 'allow' });
      const coexist = await service.claims.acquire(a.id, a.token, { client_request_id: randomUUID(), purpose: 'same-session lease coexistence',
        resources: [{ kind: 'path', host_id: target.id, path }, { kind: 'git', host_id: target.id, common_dir: common, branch: 'main' }] });
      expect(coexist).toMatchObject({ state: 'active', blockers: [] });
      await service.claims.release(a.id, a.token, { claim_id: coexist.id, outcome: 'completed', reason: 'coexistence verified' });
      // Reusing an address never makes a different binding's live lease ours.
      await handle!.db.update(schema.gitWorktrees).set({ agentBindingGeneration: 2 })
        .where(eq(schema.gitWorktrees.worktreePath, path));
      const staleLease = await service.claims.acquire(a.id, a.token, { client_request_id: randomUUID(), purpose: 'foreign binding fence',
        resources: [{ kind: 'git', host_id: target.id, common_dir: common, branch: 'main' }] });
      expect(staleLease).toMatchObject({ state: 'waiting', blockers: [{ state: 'legacy_merge_lease' }] });
      await service.claims.release(a.id, a.token, { claim_id: staleLease.id, outcome: 'canceled', reason: 'binding fence verified' });
      await handle!.db.update(schema.gitWorktrees).set({ agentBindingGeneration: 1 })
        .where(eq(schema.gitWorktrees.worktreePath, path));
      expect((await call('release', { request_id: randomUUID() })).statusCode).toBe(403);
      expect((await call('release', { request_id: granted.json().request_id, outcome: 'aborted', deregister: true })).statusCode).toBe(200);
      await service.claims.release(a.id, a.token, { claim_id: claim.id, outcome: 'completed', reason: 'test finished' });
      expect((await call('register')).statusCode).toBe(409);
    } finally {
      await app.close();
      await bus.finishSession(a.id, a.token, 'completed');
      await service.setEnabled(true);
      await handle!.db.execute(sql`DELETE FROM git_merge_requests WHERE clone_id IN (SELECT id FROM git_clones WHERE host_id=${target.id})`);
      await handle!.db.execute(sql`DELETE FROM git_worktrees WHERE host_id=${target.id}`);
      await handle!.db.execute(sql`DELETE FROM git_clones WHERE host_id=${target.id}`);
      await handle!.db.delete(hosts).where(eq(hosts.id, target.id));
    }
  });
  it('joins all three engines once, separates host/project, and reads a durable idempotent chat', async () => {
    const agents = await Promise.all([register('codex'), register('claude'), register('grok')]);
    const a = agents[0]!;
    const queries: string[] = [];
    const measuredDb = drizzle(handle!.pool, { schema, mode: 'default', logger: { logQuery(query) { queries.push(query); } } });
    const measured = new AgentCoordination(measuredDb, env, keyring, new AgentMessagingService(measuredDb, env, keyring));
    const snapshot = await measured.context(a.id, a.token);
    expect(snapshot.rooms).toHaveLength(2);
    for (const room of snapshot.rooms) expect(room.member_count).toBe(3);
    queries.length = 0;
    const again = await measured.context(a.id, a.token);
    expect(queries.filter(query => /from `agent_scopes` where `agent_scopes`.`scope_key`/.test(query))).toHaveLength(1);
    expect(queries.filter(query => /from `agent_scope_bindings` where `agent_scope_bindings`.`repository_key`/.test(query))).toHaveLength(1);
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
  it('keeps own and peer presence durable without model mail, including presence mixed with claims and chat', async () => {
    const peers = await Promise.all([register('codex'), register('claude'), register('grok')]);
    const a = peers[0]!, b = peers[1]!;
    const snapshot = await service.context(a.id, a.token);
    const room = snapshot.rooms.find((r) => r.kind === 'project')!;
    const mail = () => handle!.db.select().from(agentBusMessages)
      .where(inArray(agentBusMessages.targetSessionId, peers.map((p) => p.id)));
    const payload = (message: typeof agentBusMessages.$inferSelect) => {
      const content = decrypt(message.contentEnc, keyring);
      return JSON.parse(content.slice(content.indexOf('\n{') + 1)) as { events: Array<{ id: string; kind: string }>; members: unknown[] };
    };
    const presence = await service.run(a.id, a.token, async (tx) => {
      const own = await service.event(tx, room.id, 'presence', a.id, { action: 'joined' });
      const other = await service.event(tx, room.id, 'presence', b.id, { action: 'updated', task_title: 'Peer task' });
      await service.dispatch(tx, [own]);
      await service.dispatch(tx, [other]);
      return [own, other];
    });
    expect(await mail()).toHaveLength(0);
    await handle!.db.update(agentScopeEvents)
      .set({ createdAt: new Date(Date.now() - 3000).toISOString(), dispatched: 0 })
      .where(inArray(agentScopeEvents.id, presence.map((e) => e.id)));
    const publish = vi.spyOn(wsPublisher, 'publish');
    try {
      await service.tick();
      expect(publish).toHaveBeenCalledWith('agent_coordination.changed', {});
    } finally { publish.mockRestore(); }
    expect(await mail()).toHaveLength(0);
    const durable = await service.read(a.id, a.token, { scope_id: room.id });
    expect(durable.events.filter((e) => presence.some((p) => p.id === e.id)).map((e) => e.kind))
      .toEqual(['presence', 'presence']);
    expect(durable.cursor).toBeGreaterThanOrEqual(presence[1]!.sequence);
    const stored = await handle!.db.select().from(agentScopeEvents)
      .where(inArray(agentScopeEvents.id, presence.map((e) => e.id)));
    expect(stored.every((e) => e.dispatched === 1)).toBe(true);

    const claim = await service.run(a.id, a.token, async (tx) => {
      const routine = await service.event(tx, room.id, 'presence', a.id, { action: 'updated' });
      const event = await service.event(tx, room.id, 'claim', a.id, { action: 'active', claim_id: randomUUID() });
      await service.dispatch(tx, [routine, event]);
      return event;
    });
    const claimMail = await mail();
    expect(claimMail).toHaveLength(0);
    expect((await service.read(a.id, a.token, { scope_id: room.id })).events)
      .toContainEqual(expect.objectContaining({ id: claim.id, kind: 'claim' }));

    const chat = await service.run(a.id, a.token, async (tx) => {
      const routine = await service.event(tx, room.id, 'presence', b.id, { action: 'updated' });
      const event = await service.event(tx, room.id, 'chat', a.id, { content: 'Substantive room coordination', name: 'Sender' });
      await service.dispatch(tx, [routine, event]);
      return event;
    });
    const chatMail = (await mail()).filter((m) => !claimMail.some((before) => before.id === m.id));
    expect(chatMail).toHaveLength(2);
    expect(chatMail.every((m) => m.targetSessionId !== a.id)).toBe(true);
    for (const message of chatMail)
      expect(payload(message).events).toEqual([expect.objectContaining({ id: chat.id, kind: 'chat' })]);
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
    const reconcile = vi.spyOn(service, 'reconcile');
    try {
      const renewed = await service.claims.status(owner.id, owner.token, { claim_id: held.id, renew: true });
      expect(renewed).toMatchObject({ state: 'active', session_id: owner.id, generation: held.generation });
      expect(Date.parse(String(renewed.expires_at))).toBeGreaterThanOrEqual(Date.parse(String(held.expires_at)));
      expect(reconcile).not.toHaveBeenCalled();
      await expect(service.claims.status(waiter.id, waiter.token, { claim_id: held.id, renew: true }))
        .rejects.toThrow('another session');
    } finally { reconcile.mockRestore(); }
    const ownerMail = await handle!.db.select().from(agentBusMessages)
      .where(eq(agentBusMessages.targetSessionId, owner.id));
    const conflictNotices = ownerMail.filter((m) => decrypt(m.contentEnc, keyring).startsWith('CLAIM/1\n'));
    expect(conflictNotices).toHaveLength(1);
    expect(Date.parse(String(waiting.expires_at)) - Date.parse(waiting.created_at)).toBeGreaterThanOrEqual(180000);
    expect(await service.claims.status(waiter.id, waiter.token, { claim_id: waiting.id, renew: true })).toMatchObject({ state: 'waiting' });
    expect(waiting.blockers).toEqual(expect.arrayContaining([expect.objectContaining({ id: held.id, purpose: expect.any(String), owner_address: expect.stringMatching(/^agent:/), resources })]));
    expect(decrypt(conflictNotices[0]!.contentEnc, keyring)).toContain(waiting.id);
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
      service.event(tx, room.id, 'chat', 'operator:1', { content: 'restart_test' }),
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
  it('names an unbound registration as the merge blocker and allows the same request after binding', async () => {
    const launch = `/tmp/unbound-launch-${suffix}`,
      worktreePath = `/tmp/unbound-wt-${suffix}`,
      commonDir = launch + '/.git';
    // Session started in the original checkout; the agent then works in a linked worktree.
    const a = await register('codex', launch);
    const db = handle!.db;
    await db
      .insert(versions)
      .values({ name: 'git_director_enabled', version: '1', updatedAt: new Date().toISOString() })
      .onDuplicateKeyUpdate({ set: { version: '1' } });
    const director = new GitDirectorService({ db, settings: new SettingsService(db) });
    const registration = {
      worktree_path: worktreePath,
      clone_dir: commonDir,
      repo_root: launch,
      username: a.id,
      engine: 'codex',
      branch: 'feature',
      head_sha: 'b'.repeat(40),
    };
    const unbound = await director.register(registration, host);
    expect(unbound).toMatchObject({ registered: true, agent_address_bound: false });
    expect(String(unbound.binding_hint)).toContain('agent_context_update');
    const claim = await service.claims.acquire(a.id, a.token, {
      purpose: 'merge from unbound worktree',
      client_request_id: randomUUID(),
      resources: [
        { kind: 'path', host_id: host.id, path: worktreePath },
        { kind: 'git', host_id: host.id, common_dir: commonDir, branch: 'main' },
      ],
    });
    expect(claim.state).toBe('active');
    const args = {
      worktree_path: worktreePath,
      target_branch: 'main',
      client_request_id: randomUUID(),
      base_sha: 'a'.repeat(40),
      head_sha: 'b'.repeat(40),
      changed_paths: ['a.ts'],
    };
    const rejected = director.requestMerge(args, host);
    await expect(rejected).rejects.toMatchObject({
      code: 'resource_claim_conflict',
      extra: { reason: 'registration_unbound', agent_address_bound: false, claim_ids: [claim.id] },
    });
    await expect(rejected).rejects.toThrow(/agent_address_bound=false.*git_register.*same client_request_id/);

    // Supported repair: move the session scope to the worktree, re-register, retry the same request.
    await service.update(a.id, a.token, {
      workspace: {
        cwd: worktreePath,
        git_status: 'repository',
        git_root: worktreePath,
        git_common_dir: commonDir,
        origin_url: `ssh://git@example.org/scopes-${suffix}.git`,
      },
    });
    const bound = await director.register(registration, host);
    expect(bound).toMatchObject({ rebound: true, agent_address_bound: true });
    expect(bound).not.toHaveProperty('binding_hint');

    // Binding does not weaken the guard: a genuinely foreign live claim still blocks generically.
    const foreign = randomUUID(),
      now = new Date().toISOString();
    await db.execute(sql`INSERT INTO agent_resource_claims
      (id,session_id,generation,request_id,purpose,resources,state,blockers,expires_at,created_at,updated_at)
      VALUES (${foreign},${randomUUID()},1,${randomUUID()},'foreign hold',
      ${JSON.stringify([{ kind: 'path', host_id: host.id, path: worktreePath + '/a.ts' }])},'active','[]',
      ${new Date(Date.now() + 60000).toISOString()},${now},${now})`);
    try {
      await expect(director.requestMerge(args, host)).rejects.toThrow(
        'Resources are reserved or uncertain; coordinate with owners before merging',
      );
    } finally {
      await db.execute(sql`DELETE FROM agent_resource_claims WHERE id=${foreign}`);
    }
    const result = await director.requestMerge(args, host);
    expect(result.verdict).toBe('allow');
    await director.release({ worktree_path: worktreePath }, host);
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
  it('keeps the setting and its audit atomic and returns state independently of room snapshots', async () => {
    const db = handle!.db;
    const hiddenAudit = `scope_audit_${suffix.replaceAll('-', '')}`;
    await service.setEnabled(true);
    await handle!.pool.query(`RENAME TABLE admin_events TO ${hiddenAudit}`);
    try {
      await expect(service.setEnabled(false, 999999)).rejects.toMatchObject({ cause: { code: 'ER_NO_SUCH_TABLE' } });
      expect(await service.state()).toEqual({ enabled: true, protocol: 1, shell_enforcement: false });
    } finally { await handle!.pool.query(`RENAME TABLE ${hiddenAudit} TO admin_events`); }
    try {
      expect(await service.setEnabled(false, 999998)).toEqual({ enabled: false, protocol: 1, shell_enforcement: false });
      expect(await service.state()).toMatchObject({ enabled: false });
      const audit = await db.select().from(adminEvents).where(eq(adminEvents.type, 'agent_coordination.state'));
      expect(audit.some((event) => (event.payload as { admin_user_id?: number })?.admin_user_id === 999998)).toBe(true);
      expect(audit.some((event) => (event.payload as { admin_user_id?: number })?.admin_user_id === 999999)).toBe(false);
    } finally {
      await db.execute(sql`DELETE FROM admin_events WHERE type='agent_coordination.state' AND JSON_EXTRACT(payload, '$.admin_user_id') IN (999998, 999999)`);
      await service.setEnabled(true);
    }
  });
  it('preserves confirmed registration through a broken optional scope join, then restores full context after migration', async () => {
    const a = await register('codex');
    await service.context(a.id, a.token);
    const [columnRows] = await handle!.pool.query<import('mysql2/promise').RowDataPacket[]>(
      `SELECT COLLATION_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE()
       AND TABLE_NAME='agent_sessions' AND COLUMN_NAME='id'`);
    const mismatch = columnRows[0]!.COLLATION_NAME === 'utf8mb4_unicode_ci' ? 'utf8mb4_0900_ai_ci' : 'utf8mb4_unicode_ci';
    const migration = splitSqlStatements(await readFile(new URL('../../../src/db/migrations/0089_coordination_session_collation.sql', import.meta.url), 'utf8'));
    const app = await buildRouteApp();
    await registerAgentPortalAdminHostRoutes(app, { db: handle!.db, env, keyring });
    const names = Array.from({ length: 10 }, (_, index) => `Scope-${suffix.slice(0, 8)}-${index}`);
    await handle!.db.insert(agentNamePool).values(names.map((name) => ({ nameKey: name.toLowerCase(), name })));
    const launch = async (engine: 'codex' | 'claude' | 'grok' = 'codex') => {
      const id = randomUUID();
      sessions.push(id);
      return app.inject({ method: 'POST', url: '/host/agent-sessions', headers: { 'x-api-key': host.apiKey }, payload: {
        session_id: id, bridge_token: randomBytes(32).toString('base64url'), engine, username: id,
        cwd: `/tmp/registration-${id}`, invocation_kind: 'interactive',
        adapter_capabilities: { scope_protocol_version: 1, execution_contract_version: 2, launch_identity_version: 1 },
      } });
    };
    try {
      await handle!.pool.query(`ALTER TABLE agent_scope_members MODIFY session_id CHAR(36) CHARACTER SET utf8mb4 COLLATE ${mismatch} NOT NULL`);
      await expect(service.context(a.id, a.token)).rejects.toMatchObject({ cause: { code: 'ER_CANT_AGGREGATE_2COLLATIONS' } });
      expect(await service.state()).toMatchObject({ enabled: true });
      for (const engine of ['codex', 'claude', 'grok'] as const) {
        const degraded = await launch(engine);
        expect(degraded.statusCode, degraded.body).toBe(200);
        expect(degraded.json()).toMatchObject({ enabled: true, name_status: 'assigned',
          agent_address: { name: expect.any(String) },
          scope_context: { enabled: true, available: false, reason: 'snapshot_unavailable' } });
      }
      for (const statement of migration) await handle!.pool.query(statement);
      for (const engine of ['codex', 'claude', 'grok'] as const) {
        const restored = await launch(engine);
        expect(restored.statusCode, restored.body).toBe(200);
        expect(restored.json()).toMatchObject({ enabled: true, name_status: 'assigned',
          scope_context: { enabled: true, rooms: expect.any(Array) } });
      }
      expect((await service.context(a.id, a.token)).rooms.length).toBeGreaterThan(0);
      const context = vi.spyOn(AgentCoordination.prototype, 'context');
      try {
        context.mockRejectedValueOnce(new UnauthorizedError('Credential revoked', 'agent_bridge_unauthorized'));
        expect((await launch()).statusCode).toBe(401);
        context.mockRejectedValueOnce(new ConflictError('Binding changed', 'agent_messaging_binding_stale'));
        expect((await launch()).statusCode).toBe(409);
      } finally { context.mockRestore(); }
    } finally {
      for (const statement of migration) await handle!.pool.query(statement);
      await handle!.db.delete(agentNamePool).where(inArray(agentNamePool.nameKey, names.map((name) => name.toLowerCase())));
      await app.close();
    }
  });
  it('keeps server-owned advisor sessions outside scope coordination instead of demanding unreachable claims', async () => {
    const db = handle!.db,
      now = new Date().toISOString(),
      fqdn = `advisor-${suffix}.internal`;
    await db.insert(hosts).values({
      fqdn,
      apiKey: randomBytes(32).toString('hex'),
      status: 'active',
      secure: 1,
      engines: 'codex,claude,grok',
      internalRole: 'advisor',
      createdAt: now,
      updatedAt: now,
    });
    const [advisor] = await db.select().from(hosts).where(eq(hosts.fqdn, fqdn));
    const app = await buildRouteApp();
    await registerAgentPortalAdminHostRoutes(app, { db, env, keyring });
    const advisorSessions: string[] = [];
    const names = Array.from({ length: 6 }, (_, index) => `Advisor-${suffix.slice(0, 8)}-${index}`);
    await db.insert(agentNamePool).values(names.map((name) => ({ nameKey: name.toLowerCase(), name })));
    try {
      for (const engine of ['codex', 'claude', 'grok'] as const) {
        const id = randomUUID(),
          token = randomBytes(32).toString('base64url');
        advisorSessions.push(id);
        await bus.registerSession(advisor!, {
          sessionId: id,
          bridgeToken: token,
          engine,
          username: id,
          cwd: '/work',
          invocationKind: 'interactive',
          workspace: { cwd: '/work', git_status: 'none', git_root: null, git_common_dir: null },
          adapterCapabilities: { scope_protocol_version: 1, execution_contract_version: 2 },
        });
        const context = await service.context(id, token);
        expect(context).toMatchObject({ enabled: false, reason: 'internal_host', rooms: [], claims: [] });
        await expect(
          service.claims.acquire(id, token, {
            purpose: 'fetch transfer',
            resources: [{ kind: 'path', host_id: advisor!.id, path: `/work/${id}.diff` }],
            client_request_id: randomUUID(),
          }),
        ).rejects.toMatchObject({ code: 'agent_coordination_not_applicable' });
        // Nor may an advisor claim a fleet host it cannot see: it is not a scope member.
        await expect(
          service.claims.acquire(id, token, {
            purpose: 'fetch transfer',
            resources: [{ kind: 'path', host_id: host.id, path: `/tmp/${id}` }],
            client_request_id: randomUUID(),
          }),
        ).rejects.toMatchObject({ code: 'agent_coordination_not_applicable' });
        // Registration omits scope_context, so the wrapper adds no claim-before-write instruction.
        const launchId = randomUUID();
        advisorSessions.push(launchId);
        const launched = await app.inject({
          method: 'POST',
          url: '/host/agent-sessions',
          headers: { 'x-api-key': advisor!.apiKey },
          payload: {
            session_id: launchId,
            bridge_token: randomBytes(32).toString('base64url'),
            engine,
            username: launchId,
            cwd: '/work',
            invocation_kind: 'interactive',
            adapter_capabilities: { scope_protocol_version: 1, execution_contract_version: 2, launch_identity_version: 1 },
          },
        });
        expect(launched.statusCode, launched.body).toBe(200);
        expect(launched.json()).toMatchObject({ enabled: true });
        expect(launched.json()).not.toHaveProperty('scope_context');
      }
      // A fleet session on the same server keeps the full contract.
      const fleet = await register('codex');
      expect(await service.context(fleet.id, fleet.token)).toMatchObject({ enabled: true });
      expect(await service.context(fleet.id, fleet.token)).not.toHaveProperty('reason');
    } finally {
      await app.close();
      await db.delete(agentResourceClaims).where(inArray(agentResourceClaims.sessionId, advisorSessions));
      await db.execute(sql`UPDATE agent_name_pool SET current_session_id = NULL WHERE current_session_id IN (SELECT id FROM agent_sessions WHERE host_id = ${advisor!.id})`);
      await db.execute(sql`DELETE FROM agent_name_leases WHERE address_id IN (SELECT id FROM agent_bus_addresses WHERE host_id = ${advisor!.id})`);
      await db.execute(sql`DELETE FROM agent_events WHERE session_id IN (SELECT id FROM agent_sessions WHERE host_id = ${advisor!.id})`);
      await db.delete(agentSessions).where(eq(agentSessions.hostId, advisor!.id));
      await db.execute(sql`DELETE FROM agent_bus_addresses WHERE host_id = ${advisor!.id}`);
      await db.delete(hosts).where(eq(hosts.id, advisor!.id));
      await db.delete(agentNamePool).where(inArray(agentNamePool.nameKey, names.map((name) => name.toLowerCase())));
    }
  });
  it('keeps stable background ticks lock-free but detects fresh heartbeat expiry and concurrent host changes', async () => {
    const a = await register('codex');
    const snapshot = await service.context(a.id, a.token);
    const scopeIds = snapshot.rooms.map((room) => room.id);
    await handle!.db
      .update(agentScopeEvents)
      .set({ dispatched: 1 })
      .where(inArray(agentScopeEvents.scopeId, scopeIds));
    // Hold the presence boundary steady while proving an unchanged idle tick.
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now());
    await service.tick();
    // Reconciliation can itself change the certified rows; settle that change
    // before measuring the no-op fast path.
    await service.tick();
    const connection = vi.spyOn(handle!.pool, 'getConnection');
    const query = vi.spyOn(handle!.pool, 'query');
    try {
      await service.tick();
      expect(connection).not.toHaveBeenCalled();
      expect(query).toHaveBeenCalledTimes(1);
      // Renewed timestamps remain the same live-presence state.
      await handle!.db
        .update(agentSessions)
        .set({ heartbeatAt: new Date(Date.now()).toISOString() })
        .where(eq(agentSessions.id, a.id));
      query.mockClear();
      await service.tick();
      expect(connection).not.toHaveBeenCalled();
      expect(query).toHaveBeenCalledTimes(1);
      await handle!.db
        .update(agentSessions)
        .set({ heartbeatAt: '2000-01-01T00:00:00Z' })
        .where(eq(agentSessions.id, a.id));
      await service.tick();
      expect(connection).toHaveBeenCalledTimes(1);
      expect(
        await handle!.db
          .select()
          .from(agentScopeMembers)
          .where(and(eq(agentScopeMembers.sessionId, a.id), eq(agentScopeMembers.state, 'active'))),
      ).toHaveLength(0);
    } finally {
      clock.mockRestore();
      connection.mockRestore();
      query.mockRestore();
    }
    await handle!.db
      .update(agentSessions)
      .set({ heartbeatAt: new Date().toISOString() })
      .where(eq(agentSessions.id, a.id));
    const reconcile = service.reconcile.bind(service);
    const changedDuring = vi.spyOn(service, 'reconcile').mockImplementationOnce(async (tx, now) => {
      await reconcile(tx, now);
      await handle!.db.update(hosts).set({ status: 'inactive' }).where(eq(hosts.id, host.id));
    });
    try {
      await service.tick();
      // A post-transaction observation would incorrectly absorb this mutation.
      await service.tick();
      expect(
        await handle!.db
          .select()
          .from(agentScopeMembers)
          .where(and(eq(agentScopeMembers.sessionId, a.id), eq(agentScopeMembers.state, 'active'))),
      ).toHaveLength(0);
    } finally {
      changedDuring.mockRestore();
      await handle!.db.update(hosts).set({ status: 'active' }).where(eq(hosts.id, host.id));
    }
  });
  it('certifies the reconciled transaction snapshot rather than external A across an A-B-A race', async () => {
    const a = await register('grok');
    const snapshot = await service.context(a.id, a.token);
    await handle!.db
      .update(agentScopeEvents)
      .set({ dispatched: 1 })
      .where(
        inArray(
          agentScopeEvents.scopeId,
          snapshot.rooms.map((room) => room.id),
        ),
      );
    // A needs removal; B, observed only inside reconciliation, needs no write.
    await handle!.db.update(hosts).set({ status: 'inactive' }).where(eq(hosts.id, host.id));
    const transaction = bus.coordinationTransaction.bind(bus);
    const flip = vi.spyOn(bus, 'coordinationTransaction').mockImplementationOnce(async (...args) => {
      await handle!.db.update(hosts).set({ status: 'active' }).where(eq(hosts.id, host.id));
      return transaction(...args);
    });
    try {
      await service.tick();
      expect(
        await handle!.db
          .select()
          .from(agentScopeMembers)
          .where(and(eq(agentScopeMembers.sessionId, a.id), eq(agentScopeMembers.state, 'active'))),
      ).toHaveLength(2);
      await handle!.db.update(hosts).set({ status: 'inactive' }).where(eq(hosts.id, host.id));
      await service.tick();
      expect(
        await handle!.db
          .select()
          .from(agentScopeMembers)
          .where(and(eq(agentScopeMembers.sessionId, a.id), eq(agentScopeMembers.state, 'active'))),
      ).toHaveLength(0);
    } finally {
      flip.mockRestore();
      await handle!.db.update(hosts).set({ status: 'active' }).where(eq(hosts.id, host.id));
    }
  });
  it('ignores live claim renewals but reacts to titles, repository bindings and claim expiry', async () => {
    const a = await register('claude');
    await service.context(a.id, a.token);
    const held = await service.claims.acquire(a.id, a.token, {
      client_request_id: randomUUID(),
      purpose: 'idle tick',
      resources: [{ kind: 'service', host_id: host.id, service: `idle-${suffix}` }],
    });
    const settle = async () => {
      // Earlier cases leave members in several rooms. Keep the fixture's other
      // live sessions away from the 45-second boundary, and settle their own
      // pending events before attributing a transaction to this claim renewal.
      await handle!.db.update(agentSessions).set({ heartbeatAt: new Date().toISOString() })
        .where(and(eq(agentSessions.hostId, host.id), isNull(agentSessions.endedAt)));
      for (let attempt = 0; attempt < 3; attempt++) {
        const rooms = await handle!.db.select({ id: agentScopeMembers.scopeId })
          .from(agentScopeMembers).innerJoin(agentSessions, eq(agentScopeMembers.sessionId, agentSessions.id))
          .where(eq(agentSessions.hostId, host.id));
        if (rooms.length) await handle!.db.update(agentScopeEvents).set({ dispatched: 1 })
          .where(inArray(agentScopeEvents.scopeId, rooms.map(room => room.id)));
        await service.tick();
      }
    };
    await settle();
    await handle!.db
      .update(agentResourceClaims)
      .set({ expiresAt: new Date(Date.now() + 90000).toISOString() })
      .where(eq(agentResourceClaims.id, held.id));
    const connection = vi.spyOn(handle!.pool, 'getConnection');
    try {
      await service.tick();
      expect(connection).not.toHaveBeenCalled();
    } finally {
      connection.mockRestore();
    }
    const before = (
      await handle!.db
        .select()
        .from(agentScopeMembers)
        .where(and(eq(agentScopeMembers.sessionId, a.id), eq(agentScopeMembers.state, 'active')))
    )[0]!.contextHash;
    const inputBefore = await coordinationTickInput(handle!.db, env);
    const [session] = await handle!.db.select().from(agentSessions).where(eq(agentSessions.id, a.id));
    await handle!.db
      .insert(schema.agentEvents)
      .values({
        sessionId: a.id,
        clientEventId: randomUUID(),
        eventType: 'session_named',
        source: 'test',
        payloadEnc: encrypt(
          JSON.stringify({ native_session_id: session!.upstreamSessionId, name: 'Changed task' }),
          keyring,
        ),
        createdAt: new Date().toISOString(),
      });
    expect((await sessionTaskTitles(handle!.db, keyring, [session!])).get(a.id)).toBe('Changed task');
    expect((await coordinationTickInput(handle!.db, env))!.fingerprint).not.toBe(inputBefore!.fingerprint);
    const reconciliation = vi.spyOn(service, 'reconcile');
    await service.tick();
    expect(reconciliation).toHaveBeenCalledTimes(1);
    reconciliation.mockRestore();
    expect(
      (
        await handle!.db
          .select()
          .from(agentScopeMembers)
          .where(and(eq(agentScopeMembers.sessionId, a.id), eq(agentScopeMembers.state, 'active')))
      )[0]!.contextHash,
    ).not.toBe(before);
    await settle();
    const key = repositoryIdentity(session!);
    const [prior] = await handle!.db
      .select()
      .from(schema.agentScopeBindings)
      .where(eq(schema.agentScopeBindings.repositoryKey, key));
    try {
      await handle!.db
        .insert(schema.agentScopeBindings)
        .values({ repositoryKey: key, projectSlug: `idle-${suffix}`, updatedAt: new Date().toISOString() })
        .onDuplicateKeyUpdate({ set: { projectSlug: `idle-${suffix}` } });
      await service.tick();
      const [project] = await handle!.db
        .select()
        .from(agentScopes)
        .where(eq(agentScopes.scopeKey, `project:idle-${suffix}`));
      expect(
        await handle!.db
          .select()
          .from(agentScopeMembers)
          .where(
            and(
              eq(agentScopeMembers.sessionId, a.id),
              eq(agentScopeMembers.scopeId, project!.id),
              eq(agentScopeMembers.state, 'active'),
            ),
          ),
      ).toHaveLength(1);
      await handle!.db
        .update(agentResourceClaims)
        .set({ expiresAt: '2000-01-01T00:00:00Z' })
        .where(eq(agentResourceClaims.id, held.id));
      await service.tick();
      expect(
        (await handle!.db.select().from(agentResourceClaims).where(eq(agentResourceClaims.id, held.id)))[0]!
          .state,
      ).toBe('uncertain');
    } finally {
      if (prior)
        await handle!.db
          .update(schema.agentScopeBindings)
          .set({ projectSlug: prior.projectSlug })
          .where(eq(schema.agentScopeBindings.repositoryKey, key));
      else
        await handle!.db
          .delete(schema.agentScopeBindings)
          .where(eq(schema.agentScopeBindings.repositoryKey, key));
    }
  });
  it('honors certified engine flags when secondary reads fall back to all enabled', async () => {
    const a = await register('codex');
    await service.context(a.id, a.token);
    await handle!.db.insert(versions).values({ name: 'codex_engine_disabled', version: '1', updatedAt: new Date().toISOString() }).onDuplicateKeyUpdate({ set: { version: '1' } });
    const engineSwitch = await import('../../../src/services/engine-switch.js');
    const fallback = vi.spyOn(engineSwitch, 'readFleetEngineState').mockResolvedValue({ codex: true, claude: true, grok: true });
    try {
      const reconciled = vi.spyOn(service, 'reconcile');
      await service.tick();
      expect(reconciled.mock.calls.at(-1)?.[2]).toEqual({ codex: false, claude: true, grok: true });
      reconciled.mockRestore();
      expect(await handle!.db.select().from(agentScopeMembers).where(and(eq(agentScopeMembers.sessionId, a.id), eq(agentScopeMembers.state, 'active')))).toHaveLength(0);
    } finally {
      fallback.mockRestore();
      await handle!.db.update(versions).set({ version: '0' }).where(eq(versions.name, 'codex_engine_disabled'));
    }
  });

  it('observes ended active members but omits retired historical sessions', async () => {
    const a = await register('grok');
    await service.context(a.id, a.token);
    await handle!.db.update(agentSessions).set({ endedAt: new Date().toISOString() })
      .where(eq(agentSessions.id, a.id));
    const before = await coordinationTickInput(handle!.db, env);
    await handle!.db.update(agentSessions).set({ launchName: 'Ended active member' })
      .where(eq(agentSessions.id, a.id));
    const changed = await coordinationTickInput(handle!.db, env);
    expect(changed!.fingerprint).not.toBe(before!.fingerprint);
    await service.tick();
    expect(await handle!.db.select().from(agentScopeMembers).where(and(eq(agentScopeMembers.sessionId, a.id), eq(agentScopeMembers.state, 'active')))).toHaveLength(0);
    const retired = await coordinationTickInput(handle!.db, env);
    await handle!.db.update(agentSessions).set({ launchName: 'Ignored historical member' })
      .where(eq(agentSessions.id, a.id));
    expect((await coordinationTickInput(handle!.db, env))!.fingerprint).toBe(retired!.fingerprint);
  });

  it('uses the exact inclusive insecure-window boundary in the idle input proof', async () => {
    const deadline = Math.ceil(Date.now() / 1000) * 1000 + 5000;
    await handle!.db
      .update(hosts)
      .set({ secure: 0, insecureEnabledUntil: new Date(deadline) })
      .where(eq(hosts.id, host.id));
    try {
      const before = await coordinationTickInput(handle!.db, env, { now: deadline - 1 });
      const at = await coordinationTickInput(handle!.db, env, { now: deadline });
      const after = await coordinationTickInput(handle!.db, env, { now: deadline + 1 });
      expect(before!.fingerprint).toBe(at!.fingerprint);
      expect(after!.fingerprint).not.toBe(at!.fingerprint);
    } finally {
      await handle!.db
        .update(hosts)
        .set({ secure: 1, insecureEnabledUntil: null })
        .where(eq(hosts.id, host.id));
    }
  });
  it('coordinates an unmanaged canonical FQDN globally without a synthetic fleet host', async () => {
    const a = await register('codex'), b = await register('claude');
    const acquire = (actor: typeof a, fqdn: string) => service.claims.acquire(actor.id, actor.token, {
      client_request_id: randomUUID(), purpose: 'unmanaged SSH maintenance', resources: [{ kind: 'remote', fqdn, service: 'mail' }],
    });
    const owned = await acquire(a, 'MX1.Example.org.');
    const waiting = await acquire(b, 'mx1.example.org');
    const independent = await acquire(b, 'alias.example.org');
    expect(owned.state).toBe('active');
    expect(waiting.state).toBe('waiting');
    expect(independent.state).toBe('active');
    expect(owned.resources).toEqual([{ kind: 'remote', fqdn: 'mx1.example.org', service: 'mail' }]);
    await service.claims.release(a.id, a.token, { claim_id: owned.id, outcome: 'completed', reason: 'test ended' });
    await service.claims.release(b.id, b.token, { claim_id: waiting.id, outcome: 'canceled', reason: 'test ended' });
    await service.claims.release(b.id, b.token, { claim_id: independent.id, outcome: 'completed', reason: 'test ended' });
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
