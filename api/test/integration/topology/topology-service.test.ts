import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { adminUsers, hostDaemonPortalBindings, hostDaemonSessions, hosts } from '../../../src/db/schema.js';
import { AgentPortalService, type PortalActor } from '../../../src/services/agent-portal.js';
import { CommunicatorRegistry } from '../../../src/services/topology/communicator-registry.js';
import { TopologyService } from '../../../src/services/topology/service.js';
import { getTestDb } from '../../helpers/test-db.js';
import { loadTestEnv, testKeyring } from '../../helpers/test-keyring.js';

const handle = await getTestDb();
const PREFIX = 'ztest-topology';

describe.skipIf(!handle)('topology service against MySQL', () => {
  const db = handle?.db;
  let host: typeof hosts.$inferSelect;
  let other: typeof hosts.$inferSelect;
  let actor: PortalActor;
  let portal: AgentPortalService;
  let registry: CommunicatorRegistry;
  let topology: TopologyService;
  const exec = async (text: string) => await db!.execute(sql.raw(text));

  const clean = async () => {
    for (const h of [host, other]) {
      if (!h) continue;
      await exec(`DELETE FROM host_daemon_portal_bindings WHERE portal_session_id IN (SELECT id FROM agent_sessions WHERE host_id = ${h.id})`);
      await exec(`DELETE FROM host_daemon_sessions WHERE host_id = ${h.id}`);
      await exec(`DELETE FROM agent_messages WHERE session_id IN (SELECT id FROM agent_sessions WHERE host_id = ${h.id})`);
      await exec(`DELETE FROM agent_prompts WHERE session_id IN (SELECT id FROM agent_sessions WHERE host_id = ${h.id})`);
      await exec(`DELETE FROM agent_events WHERE session_id IN (SELECT id FROM agent_sessions WHERE host_id = ${h.id})`);
      await exec(`DELETE FROM agent_sessions WHERE host_id = ${h.id}`);
    }
  };

  beforeAll(async () => {
    const now = new Date().toISOString();
    for (const name of ['a', 'b']) {
      await exec(`INSERT INTO hosts (fqdn, api_key, status, engines, created_at, updated_at)
        VALUES ('${PREFIX}-${name}.example', '${(name === 'a' ? 'b' : 'c').repeat(64)}', 'active', 'codex,claude', '${now}', '${now}')`);
    }
    host = (await db!.select().from(hosts).where(eq(hosts.fqdn, `${PREFIX}-a.example`)))[0]!;
    other = (await db!.select().from(hosts).where(eq(hosts.fqdn, `${PREFIX}-b.example`)))[0]!;
    await exec(`INSERT INTO admin_users (name, username, email, password_hash, access_level, active, created_at, updated_at)
      VALUES ('Topology operator', '${PREFIX}', '${PREFIX}@example.test', 'x', 'owner', 1, '${now}', '${now}')`);
    const admin = (await db!.select().from(adminUsers).where(eq(adminUsers.username, PREFIX)))[0]!;
    actor = { kind: 'admin', user: { id: admin.id, displayName: admin.name } };
    const env = { ...loadTestEnv(), PUBLIC_BASE_URL: 'https://orch.example', AGENT_PORTAL_HEARTBEAT_FRESH_SECONDS: 45, AGENT_PORTAL_RELAY_FRESH_SECONDS: 30 };
    portal = new AgentPortalService(db!, env, testKeyring());
    await portal.setEnabled(true);
    registry = new CommunicatorRegistry();
    topology = new TopologyService({ db: db!, env, keyring: testKeyring() }, registry);
  });

  beforeEach(async () => {
    await clean();
    registry.reset();
    topology.invalidate();
  });

  afterAll(async () => {
    await clean();
    await exec(`DELETE FROM hosts WHERE fqdn LIKE '${PREFIX}-%'`);
    await exec(`DELETE FROM admin_users WHERE username = '${PREFIX}'`);
    await portal?.setEnabled(false);
    await handle?.pool.end();
  });

  async function live(h: typeof hosts.$inferSelect, engine: 'codex' | 'claude', relay = true) {
    const registered = await portal.registerAgent(h, { engine, username: 'topo', cwd: `/srv/${engine}`, invocationKind: 'interactive' });
    if (!registered.enabled) throw new Error('portal disabled in fixture');
    await portal.heartbeatAgent(registered.session_id, registered.bridge_token, relay ? { relayAction: 'poll' } : {}, h.id);
    return registered;
  }
  const connect = (id: string, h: typeof hosts.$inferSelect, username = 'topo') =>
    registry.register(
      { id, host_id: h.id, username, version: '0.9.74', connected_at: new Date().toISOString(), sessions: 0, requests: 0, synced_at: null },
      { close: () => undefined, remoteAddress: '192.0.2.7' },
    );

  it('parents sessions by traffic evidence and leaves the rest direct, with real names and hosts', async () => {
    const a = await live(host, 'claude');
    const b = await live(host, 'codex');
    const c = await live(other, 'claude');
    connect('conn-1', host);
    connect('conn-2', other);
    registry.observeDispatch('conn-1', 'POST', `/host/agent-sessions/${a.session_id}/heartbeat`, 200);
    // Same host and OS user as conn-1, but nothing proves b rides on it.
    registry.observeDispatch('conn-2', 'POST', `/host/agent-sessions/${c.session_id}/heartbeat`, 200);
    // A foreign host's evidence for a session of another host is not honoured.
    registry.observeDispatch('conn-2', 'POST', `/host/agent-sessions/${b.session_id}/heartbeat`, 200);

    const snapshot = await topology.snapshot();
    expect(snapshot.server).toMatchObject({ label: 'orch.example', portal_enabled: true });
    expect(snapshot.communicators.map((n) => [n.id, n.host])).toEqual(
      expect.arrayContaining([['conn-1', `${PREFIX}-a.example`], ['conn-2', `${PREFIX}-b.example`]]),
    );
    const byId = Object.fromEntries(snapshot.agents.map((n) => [n.id, n.association]));
    expect(byId[a.session_id]).toMatchObject({ state: 'attributed', parent_id: 'conn-1' });
    expect(byId[b.session_id]).toMatchObject({ state: 'unattributed', parent_id: 'server' });
    expect(byId[c.session_id]).toMatchObject({ state: 'attributed', parent_id: 'conn-2' });
    expect(snapshot.agents.find((n) => n.id === a.session_id)).toMatchObject({ engine: 'claude', presence: 'listening', host: `${PREFIX}-a.example` });
  });

  it('drops a session from the tree once it has finished', async () => {
    const a = await live(host, 'claude');
    connect('conn-1', host);
    registry.observeDispatch('conn-1', 'POST', `/host/agent-sessions/${a.session_id}/heartbeat`, 200);
    expect((await topology.snapshot()).agents.map((n) => n.id)).toContain(a.session_id);
    await portal.finishAgent(a.session_id, a.bridge_token, { status: 'completed' }, host.id);
    topology.invalidate();
    const after = await topology.snapshot();
    expect(after.agents.map((n) => n.id)).not.toContain(a.session_id);
    expect(after.communicators[0]!.agent_ids).toEqual([]);
  });

  it('knows which sessions a host daemon launched, and offers a process stop only for those', async () => {
    const managed = await live(host, 'claude');
    const interactive = await live(host, 'claude');
    const daemonSessionId = randomUUID();
    const now = new Date().toISOString();
    await db!.insert(hostDaemonSessions).values({
      id: daemonSessionId, hostId: host.id, owner: 'admin:1', engine: 'claude', username: 'topo', cwd: '/srv/claude',
      title: 'daemon task', status: 'running', lastActivityAt: now, createdAt: now,
    });
    await db!.insert(hostDaemonPortalBindings).values({ portalSessionId: managed.session_id, daemonSessionId });

    const snapshot = await topology.snapshot();
    const byId = Object.fromEntries(snapshot.agents.map((n) => [n.id, n]));
    expect(byId[managed.session_id]!.daemon).toEqual({ session_id: daemonSessionId, status: 'running' });
    expect(byId[managed.session_id]!.actions.stop_process).toEqual({ allowed: true, reason: null });
    expect(byId[interactive.session_id]!.daemon).toBeNull();
    expect(byId[interactive.session_id]!.actions.stop_process).toEqual({ allowed: false, reason: 'not_daemon_managed' });
  });

  it('reflects a queued cooperative close and an agent that is not listening', async () => {
    const quiet = await live(host, 'codex', false);
    const listening = await live(host, 'claude');
    let snapshot = await topology.snapshot();
    let byId = Object.fromEntries(snapshot.agents.map((n) => [n.id, n]));
    expect(byId[quiet.session_id]!.actions.request_close).toEqual({ allowed: false, reason: 'agent_not_listening' });
    expect(byId[listening.session_id]!.actions.request_close.allowed).toBe(true);

    await portal.requestClose(actor, { sessionId: listening.session_id, clientMessageId: randomUUID(), note: 'wrap up' });
    topology.invalidate();
    snapshot = await topology.snapshot();
    byId = Object.fromEntries(snapshot.agents.map((n) => [n.id, n]));
    expect(byId[listening.session_id]!.close).toMatchObject({ state: 'pending' });
    expect(byId[listening.session_id]!.actions.request_close).toEqual({ allowed: false, reason: 'close_already_requested' });
    expect(byId[listening.session_id]!.actions.end_record.allowed).toBe(true);
  });

  it('serves a coalesced snapshot to concurrent readers', async () => {
    await live(host, 'claude');
    const [first, second] = await Promise.all([topology.snapshot(), topology.snapshot()]);
    expect(second).toBe(first);
  });

  it('reports portal-disabled honestly instead of an empty-looking tree', async () => {
    await portal.setEnabled(false);
    topology.invalidate();
    try {
      const snapshot = await topology.snapshot();
      expect(snapshot.server.portal_enabled).toBe(false);
      expect(snapshot.agents).toEqual([]);
    } finally {
      await portal.setEnabled(true);
    }
  });
});
