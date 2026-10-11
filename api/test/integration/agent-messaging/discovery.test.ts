import Fastify from 'fastify';
import { randomBytes, randomUUID } from 'node:crypto';
import { eq, inArray, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  agentBusAddresses,
  agentEvents,
  agentNameLeases,
  agentNamePool,
  agentSessions,
  hosts,
} from '../../../src/db/schema.js';
import { loadMigrations, runMigrations } from '../../../src/db/migrator.js';
import { envelopePlugin } from '../../../src/http/plugins/envelope.js';
import { registerAgentMessagingRoutes } from '../../../src/routes/agent-messaging/index.js';
import type { RouteContext } from '../../../src/routes/index.js';
import { encrypt } from '../../../src/security/secret-box.js';
import { AgentMessagingService } from '../../../src/services/agent-messaging.js';
import type { AgentDiscoveryFilters } from '../../../src/services/agent-messaging/discovery.js';
import type { WorkspaceInput } from '../../../src/services/agent-messaging/workspace.js';
import { nowIso, isoOffsetSeconds } from '../../../src/util/timestamp.js';
import { getTestDb } from '../../helpers/test-db.js';
import { loadTestEnv, testKeyring } from '../../helpers/test-keyring.js';

const handle = await getTestDb();
const workspace = (
  cwd = '/repo',
  root = '/repo',
  common = '/repo/.git',
  origin = 'git@example.org:team/repo.git',
): WorkspaceInput => ({
  cwd,
  git_status: 'repository',
  git_root: root,
  git_common_dir: common,
  origin_url: origin,
});

describe.skipIf(!handle)('directory and project discovery on MySQL', { timeout: 120_000 }, () => {
  const db = handle?.db;
  const testHosts: (typeof hosts.$inferSelect)[] = [];
  let service: AgentMessagingService;
  async function cleanup() {
    if (!testHosts.length) return;
    const hostIds = testHosts.map((h) => h.id);
    const ids = (await db!.select().from(agentSessions).where(inArray(agentSessions.hostId, hostIds))).map(
      (s) => s.id,
    );
    if (ids.length) {
      await db!
        .update(agentNamePool)
        .set({ currentSessionId: null })
        .where(inArray(agentNamePool.currentSessionId, ids));
      await db!.delete(agentNameLeases).where(inArray(agentNameLeases.sessionId, ids));
      await db!.delete(agentEvents).where(inArray(agentEvents.sessionId, ids));
    }
    await db!.delete(agentSessions).where(inArray(agentSessions.hostId, hostIds));
    await db!.delete(agentBusAddresses).where(inArray(agentBusAddresses.hostId, hostIds));
  }
  beforeAll(async () => {
    // Exercise the upgrade path as well as the generated fresh-install schema.
    const connection = await handle!.pool.getConnection();
    try {
      const [columns] = await connection.query("SHOW COLUMNS FROM agent_sessions LIKE 'workspace'");
      if ((columns as unknown[]).length)
        await connection.query('ALTER TABLE agent_sessions DROP COLUMN workspace');
      const migration = (await loadMigrations()).find((m) => m.filename === '0059_agent_workspace.sql')!;
      for (const statement of migration.statements) await connection.query(statement);
    } finally {
      connection.release();
    }
    await runMigrations(handle!.pool);
    service = new AgentMessagingService(db!, loadTestEnv(), testKeyring());
    for (let i = 0; i < 2; i++) {
      const fqdn = `ztest-discovery-${randomUUID()}.example`;
      await db!
        .insert(hosts)
        .values({
          fqdn,
          apiKey: randomBytes(32).toString('hex'),
          secure: 1,
          status: 'active',
          engines: 'codex,claude,grok',
          createdAt: nowIso(),
          updatedAt: nowIso(),
        });
      testHosts.push((await db!.select().from(hosts).where(eq(hosts.fqdn, fqdn)))[0]!);
    }
    await db!.execute(
      sql`INSERT INTO versions (name,version,updated_at) VALUES ('agent_messaging_enabled','1',${nowIso()}) ON DUPLICATE KEY UPDATE version='1'`,
    );
  }, 120_000);
  beforeEach(cleanup);
  afterAll(async () => {
    await cleanup();
    if (testHosts.length)
      await db!.delete(hosts).where(
        inArray(
          hosts.id,
          testHosts.map((h) => h.id),
        ),
      );
    await handle?.pool.end();
  });
  async function launch(
    ws: WorkspaceInput | undefined = workspace(),
    host = testHosts[0]!,
    engine: 'codex' | 'claude' | 'grok' = 'codex',
    cwd = '/repo',
  ) {
    const input = {
      sessionId: randomUUID(),
      bridgeToken: randomBytes(32).toString('base64url'),
      engine,
      username: 'same-user',
      cwd: ws?.cwd ?? cwd,
      workspace: ws,
      invocationKind: 'interactive' as const,
      upstreamSessionId: randomUUID(),
    };
    const result = await service.registerSession(host, input);
    return { input, host, address: result.address as { id: string; address: string; name: string } };
  }
  async function list(agent: Awaited<ReturnType<typeof launch>>, filters: AgentDiscoveryFilters = {}) {
    return (await service.listAddresses(agent.input.sessionId, agent.input.bridgeToken, filters)) as {
      addresses: Array<{
        address: string;
        cwd: string;
        task_title: string | null;
        match_reason: string;
        presence: string;
      }>;
      total: number;
      next_offset?: number;
      effective_scope: string;
      coverage: { limited: boolean; peers_without_workspace: number };
    };
  }

  it('lists every session in one directory and combines subdirectories, worktrees and cross-host clones before paging', async () => {
    const caller = await launch();
    const same = await launch();
    const sub = await launch(workspace('/repo/api'), testHosts[0], 'claude');
    const linked = await launch(workspace('/linked', '/linked', '/repo/.git', ''), testHosts[0], 'grok');
    const remote = await launch(
      workspace('/other', '/other', '/other/.git', 'https://u:secret@example.org/team/repo.git?token=secret'),
      testHosts[1],
    );
    await launch(workspace('/unrelated', '/unrelated', '/unrelated/.git', 'git@example.org:other/repo.git'));
    expect((await list(caller, { scope: 'directory' })).addresses.map((p) => p.address)).toEqual([
      same.address.address,
    ]);
    const all = await list(caller, { scope: 'project', includeOffline: false });
    expect(all.total).toBe(4);
    expect(new Set(all.addresses.map((p) => p.address))).toEqual(
      new Set([same, sub, linked, remote].map((a) => a.address.address)),
    );
    expect(all.addresses.find((p) => p.address === remote.address.address)?.match_reason).toBe(
      'same_repository',
    );
    expect(all.addresses.find((p) => p.address === linked.address.address)?.match_reason).toBe('same_clone');
    const first = await list(caller, { scope: 'project', limit: 2 });
    const last = await list(caller, { scope: 'project', limit: 2, offset: first.next_offset });
    expect(new Set([...first.addresses, ...last.addresses].map((p) => p.address)).size).toBe(4);
    expect(
      (await list(caller, { scope: 'project', engine: 'claude' })).addresses.map((p) => p.address),
    ).toEqual([sub.address.address]);
    expect((await list(caller, { scope: 'project', name: linked.address.name })).total).toBe(1);
    const [stored] = await db!
      .select()
      .from(agentSessions)
      .where(eq(agentSessions.id, remote.input.sessionId));
    expect(JSON.stringify(stored!.workspace)).not.toMatch(/secret|origin_url|example.org/);
  });

  it('returns native-bound task titles and drops stale, ended and disabled-engine peers from online discovery', async () => {
    const caller = await launch();
    const peer = await launch(workspace(), testHosts[1], 'grok');
    await db!
      .insert(agentEvents)
      .values({
        sessionId: peer.input.sessionId,
        clientEventId: randomUUID(),
        eventType: 'session_named',
        source: 'engine',
        payloadEnc: encrypt(
          JSON.stringify({ name: 'Review workspace', native_session_id: peer.input.upstreamSessionId }),
          testKeyring(),
        ),
        createdAt: nowIso(),
      });
    expect((await list(caller, { scope: 'project', includeOffline: false })).addresses[0]?.task_title).toBe(
      'Review workspace',
    );
    await db!
      .update(agentSessions)
      .set({ upstreamSessionId: randomUUID() })
      .where(eq(agentSessions.id, peer.input.sessionId));
    expect((await list(caller, { scope: 'project' })).addresses[0]?.task_title).toBeNull();
    await db!
      .update(agentSessions)
      .set({ heartbeatAt: isoOffsetSeconds(-3600) })
      .where(eq(agentSessions.id, peer.input.sessionId));
    expect((await list(caller, { scope: 'project', includeOffline: false })).total).toBe(0);
    expect((await list(caller, { scope: 'project' })).addresses[0]?.presence).toBe('resumable');
    await db!
      .update(agentSessions)
      .set({ heartbeatAt: nowIso(), endedAt: nowIso() })
      .where(eq(agentSessions.id, peer.input.sessionId));
    expect((await list(caller, { scope: 'project', includeOffline: false })).total).toBe(0);
    await db!.update(hosts).set({ engines: 'codex,claude' }).where(eq(hosts.id, peer.host.id));
    try {
      expect((await list(caller, { scope: 'project' })).total).toBe(0);
    } finally {
      await db!.update(hosts).set({ engines: 'codex,claude,grok' }).where(eq(hosts.id, peer.host.id));
    }
  });

  it('marks partial coverage, falls back for non-Git callers and refreshes metadata on registration retry and resume', async () => {
    const caller = await launch();
    const legacy = await launch();
    await db!
      .update(agentSessions)
      .set({ workspace: null })
      .where(eq(agentSessions.id, legacy.input.sessionId));
    expect(await list(caller, { scope: 'project' })).toMatchObject({
      total: 1,
      coverage: { limited: true, peers_without_workspace: 1 },
    });
    expect(await list(legacy, { scope: 'project' })).toMatchObject({
      total: 1,
      effective_scope: 'directory',
      coverage: { limited: true },
    });
    const nonGit = { cwd: '/repo', git_status: 'none' as const, git_root: null, git_common_dir: null };
    await service.registerSession(legacy.host, { ...legacy.input, workspace: nonGit });
    expect(await list(legacy, { scope: 'project' })).toMatchObject({
      total: 1,
      effective_scope: 'directory',
      coverage: { limited: false },
    });
    await service.finishSession(legacy.input.sessionId, legacy.input.bridgeToken, 'completed');
    const resumedInput = {
      ...legacy.input,
      sessionId: randomUUID(),
      bridgeToken: randomBytes(32).toString('base64url'),
      resumed: true,
      workspace: workspace('/repo', '/repo', '/repo/.git', 'git@example.org:new/project.git'),
    };
    const resumed = await service.registerSession(legacy.host, resumedInput);
    expect((resumed.address as { address: string }).address).toBe(legacy.address.address);
    const [stored] = await db!
      .select()
      .from(agentSessions)
      .where(eq(agentSessions.id, resumedInput.sessionId));
    expect(stored!.workspace).toMatchObject({ git_status: 'repository', cwd: '/repo' });
    const migration = (await loadMigrations()).find((m) => m.filename === '0059_agent_workspace.sql')!;
    const connection = await handle!.pool.getConnection();
    try {
      for (let pass = 0; pass < 2; pass++)
        for (const statement of migration.statements) await connection.query(statement);
    } finally {
      connection.release();
    }
    expect(
      (await db!.select().from(agentSessions).where(eq(agentSessions.id, resumedInput.sessionId)))[0]!
        .workspace,
    ).toEqual(stored!.workspace);
  });

  it('authenticates the scoped HTTP endpoint and preserves the fleet default', async () => {
    const caller = await launch();
    const same = await launch();
    await launch(workspace('/other', '/other', '/other/.git', 'git@example.org:other/repo.git'));
    const app = Fastify({ logger: false });
    await app.register(envelopePlugin);
    app.decorate('requireAdmin', async () => {});
    app.decorate('resolveAdmin', async () => null);
    await registerAgentMessagingRoutes(app, {
      db: db!,
      env: loadTestEnv(),
      keyring: testKeyring(),
    } as RouteContext);
    const url = `/host/agent-sessions/${caller.input.sessionId}/agent-messaging/list`;
    try {
      expect((await app.inject({ method: 'POST', url, payload: { scope: 'project' } })).statusCode).toBe(403);
      const headers = { 'x-agent-bridge-token': caller.input.bridgeToken };
      const scoped = await app.inject({ method: 'POST', url, headers, payload: { scope: 'directory' } });
      expect(scoped.statusCode).toBe(200);
      expect(scoped.json()).toMatchObject({
        scope: 'directory',
        total: 1,
        addresses: [{ address: same.address.address }],
      });
      expect((await app.inject({ method: 'POST', url, headers, payload: {} })).json()).toMatchObject({
        scope: 'fleet',
        total: 2,
      });
      expect(
        (await app.inject({ method: 'POST', url, headers, payload: { scope: 'wrong' } })).statusCode,
      ).toBe(422);
    } finally {
      await app.close();
    }
  });
});
