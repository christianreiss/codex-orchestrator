import Fastify from 'fastify';
import { envelopePlugin } from '../../../src/http/plugins/envelope.js';
import { registerAgentMessagingRoutes } from '../../../src/routes/agent-messaging/index.js';
import type { RouteContext } from '../../../src/routes/index.js';
import { AgentPortalService } from '../../../src/services/agent-portal.js';
import { encrypt } from '../../../src/security/secret-box.js';
import { randomBytes, randomUUID } from 'node:crypto';
import { eq, inArray, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  agentBusAddresses,
  agentBusMessages,
  agentEvents,
  agentNameLeases,
  agentNamePool,
  agentSessions,
  hosts,
} from '../../../src/db/schema.js';
import { runMigrations, loadMigrations } from '../../../src/db/migrator.js';
import { AgentMessagingService } from '../../../src/services/agent-messaging.js';
import { bindNativeMessagingIdentityLocked } from '../../../src/services/agent-messaging/native-identity.js';
import { releaseAgentMessagingBindingsLocked } from '../../../src/services/agent-messaging/bindings.js';
import { agentNameKey, namedSessionTitle } from '../../../src/services/agent-messaging/names.js';
import { isoOffsetSeconds, nowIso } from '../../../src/util/timestamp.js';
import type { Engine } from '../../../src/util/engine.js';
import { getTestDb } from '../../helpers/test-db.js';
import { loadTestEnv, testKeyring } from '../../helpers/test-keyring.js';

const handle = await getTestDb();
describe.skipIf(!handle)('German launch name leases on MySQL', { timeout: 120_000 }, () => {
  const db = handle?.db;
  let host: typeof hosts.$inferSelect;
  let service: AgentMessagingService;
  const sentinel = randomUUID();
  const identities: Array<{ sessionId: string; token: string }> = [];
  const exec = async (query: string) => await db!.execute(sql.raw(query));

  async function cleanup() {
    if (!host) return;
    const ids = (await db!.select().from(agentSessions).where(eq(agentSessions.hostId, host.id))).map(
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
    await db!
      .update(agentNamePool)
      .set({ currentSessionId: null })
      .where(eq(agentNamePool.currentSessionId, sentinel));
    const scope = `SELECT id FROM agent_bus_addresses WHERE host_id = ${host.id}`;
    await exec(`DELETE FROM agent_bus_conference_members WHERE address_id IN (${scope})`);
    await exec(`DELETE FROM agent_bus_conferences WHERE owner_address_id IN (${scope})`);
    await exec(
      `DELETE FROM agent_bus_messages WHERE sender_address_id IN (${scope}) OR target_address_id IN (${scope})`,
    );
    await exec(
      `DELETE FROM agent_bus_conversations WHERE address_a_id IN (${scope}) OR address_b_id IN (${scope})`,
    );
    await db!.delete(agentSessions).where(eq(agentSessions.hostId, host.id));
    await db!.delete(agentBusAddresses).where(eq(agentBusAddresses.hostId, host.id));
    identities.length = 0;
  }
  beforeAll(async () => {
    await runMigrations(handle!.pool);
    await db!
      .insert(hosts)
      .values({
        fqdn: `ztest-names-${randomUUID()}.example`,
        apiKey: 'a'.repeat(64),
        secure: 1,
        status: 'active',
        engines: 'codex,claude,grok',
        createdAt: nowIso(),
        updatedAt: nowIso(),
      });
    [host] = (await db!
      .select()
      .from(hosts)
      .where(eq(hosts.apiKey, 'a'.repeat(64)))
      .orderBy(sql`${hosts.id} DESC`)
      .limit(1)) as [typeof host];
    service = new AgentMessagingService(db!, loadTestEnv(), testKeyring());
    await exec(
      "INSERT INTO versions (name,version,updated_at) VALUES ('agent_messaging_enabled','1','2026-10-08T00:00:00Z') ON DUPLICATE KEY UPDATE version='1'",
    );
  });
  beforeEach(cleanup);
  afterEach(cleanup);
  afterAll(async () => {
    await cleanup();
    await db!.delete(hosts).where(eq(hosts.id, host.id));
    await handle?.pool.end();
  });

  async function launch(
    engine: Engine = 'codex',
    resume?: { address: string; native: string; username: string },
  ) {
    const sessionId = randomUUID(),
      token = randomBytes(32).toString('base64url');
    identities.push({ sessionId, token });
    const input = {
      sessionId,
      bridgeToken: token,
      engine,
      username: resume?.username ?? randomUUID(),
      cwd: '/tmp/cxx-names',
      invocationKind: 'interactive' as const,
      upstreamSessionId: resume?.native ?? randomUUID(),
      requestedAddress: resume?.address,
    };
    const result = await service.registerSession(host, input);
    const address = result.address as { id: string; address: string; name: string | null };
    return { sessionId, token, input, address };
  }
  async function onlyClaudia() {
    await db!.update(agentNamePool).set({ currentSessionId: sentinel });
    await db!
      .update(agentNamePool)
      .set({ currentSessionId: null })
      .where(eq(agentNamePool.nameKey, 'claudia'));
  }
  async function expireCooldown(id: string) {
    await db!
      .update(agentNameLeases)
      .set({ endedAt: isoOffsetSeconds(-172800), cooldownUntil: nowIso() })
      .where(eq(agentNameLeases.sessionId, id));
  }

  it('seeds at least 500 distinct German names and re-applies without resetting an assignment', async () => {
    const pool = await db!.select().from(agentNamePool);
    expect(pool.length).toBeGreaterThanOrEqual(500);
    for (const name of ['Claudia', 'Tanja', 'Jessica', 'Paula', 'Bärbel', 'Dörte', 'Heidrun'])
      expect(pool.some((row) => row.name === name)).toBe(true);
    expect(new Set(pool.map((row) => row.nameKey)).size).toBe(pool.length);
    const agent = await launch();
    const migration = (await loadMigrations()).find((m) => m.filename === '0045_agent_launch_names.sql')!;
    for (const statement of migration.statements) await exec(statement);
    expect((await service.translate(agent.address.name!)).uuid).toBe(agent.address.id);
  });
  it('allocates unique names across concurrent launches and all three engines', async () => {
    const agents = await Promise.all(
      Array.from({ length: 12 }, (_, i) => launch((['codex', 'claude', 'grok'] as const)[i % 3])),
    );
    expect(new Set(agents.map((a) => a.address.name)).size).toBe(12);
    for (const agent of agents) {
      const retry = await service.registerSession(host, agent.input);
      expect((retry.address as { name: string }).name).toBe(agent.address.name);
      expect((await service.translate(agent.address.name!.toUpperCase())).uuid).toBe(agent.address.id);
      expect((await service.translate(agent.address.id)).name).toBe(agent.address.name);
      expect((await service.translate(agent.address.address)).name).toBe(agent.address.name);
    }
  });
  it('holds a name for 24h after exit, reports pool exhaustion and reuses exactly at the boundary', async () => {
    await onlyClaudia();
    const first = await launch();
    expect(first.address.name).toBe('Claudia');
    await service.finishSession(first.sessionId, first.token, 'completed');
    const ended = await service.translate('claudia');
    expect(ended.status).toBe('ended');
    const until = ended.cooldown_until;
    await service.finishSession(first.sessionId, first.token, 'completed');
    expect((await service.translate('claudia')).cooldown_until).toBe(until);
    expect((await launch('claude')).address.name).toBeNull();
    await expireCooldown(first.sessionId);
    await expect(service.translate('Claudia')).rejects.toMatchObject({ code: 'agent_name_not_found' });
    const next = await launch('grok');
    expect(next.address.name).toBe('Claudia');
    expect((await service.translate('claudia')).uuid).toBe(next.address.id);
    expect((await service.translate(first.address.id)).name).toBe('Claudia');
  });
  it('preserves the receiver UUID and historical name when a named send is retried after reuse', async () => {
    const sender = await launch();
    await onlyClaudia();
    const first = await launch('claude');
    const clientMessageId = randomUUID();
    const input = { to: 'Claudia', content: 'Review the API', clientMessageId };
    const receipt = await service.sendMessage(sender.sessionId, sender.token, input);
    await service.finishSession(first.sessionId, first.token, 'completed');
    await expireCooldown(first.sessionId);
    const next = await launch('grok');
    expect(next.address.name).toBe('Claudia');
    const retry = await service.sendMessage(sender.sessionId, sender.token, input);
    expect(retry.created).toBe(false);
    expect(retry.message).toEqual(receipt.message);
    const [stored] = await db!
      .select()
      .from(agentBusMessages)
      .where(eq(agentBusMessages.clientMessageId, clientMessageId));
    expect(stored?.targetAddressId).toBe(first.address.id);
    expect(stored?.targetName).toBe('Claudia');
    const fresh = await service.sendMessage(sender.sessionId, sender.token, {
      ...input,
      clientMessageId: randomUUID(),
    });
    expect((fresh.message as Record<string, unknown>).target).toMatchObject({ id: next.address.id });
  });
  it('pins conference invitations to their first resolved UUID', async () => {
    const chair = await launch();
    await onlyClaudia();
    const first = await launch('claude');
    const conference = await service.openConference(chair.sessionId, chair.token, {
      topic: 'Review',
      purpose: 'Discuss the API',
    });
    const id = String(conference.conference_id);
    const invite = await service.inviteToConference(chair.sessionId, chair.token, {
      conferenceId: id,
      to: ['Claudia'],
    });
    expect(invite.results).toMatchObject([{ delivered: true, address: first.address.address }]);
    await service.finishSession(first.sessionId, first.token, 'completed');
    await expireCooldown(first.sessionId);
    const next = await launch('grok');
    const repeat = await service.inviteToConference(chair.sessionId, chair.token, {
      conferenceId: id,
      to: ['Claudia'],
    });
    expect(repeat.results).toMatchObject([
      { delivered: false, error: 'agent_messaging_conference_already_member' },
    ]);
    const messages = await db!
      .select()
      .from(agentBusMessages)
      .where(eq(agentBusMessages.targetAddressId, next.address.id));
    expect(messages).toHaveLength(0);
  });
  it('ends expired leases via the reaper and preserves names across brief offline periods', async () => {
    const agent = await launch();
    await db!
      .update(agentSessions)
      .set({ heartbeatAt: isoOffsetSeconds(-300) })
      .where(eq(agentSessions.id, agent.sessionId));
    expect((await service.translate(agent.address.name!)).status).toBe('active');
    await db!
      .update(agentSessions)
      .set({ bridgeExpiresAt: isoOffsetSeconds(-30) })
      .where(eq(agentSessions.id, agent.sessionId));
    await db!.transaction((tx) => releaseAgentMessagingBindingsLocked(tx, [agent.sessionId]));
    expect((await service.translate(agent.address.name!)).status).toBe('ended');
    // Re-registration of this same, non-terminal lifecycle during quarantine can recover it.
    const recovered = await service.registerSession(host, agent.input);
    expect((recovered.address as { name: string }).name).toBe(agent.address.name);
  });
  it('resumed native sessions keep the UUID but receive a new launch name', async () => {
    const first = await launch();
    await service.finishSession(first.sessionId, first.token, 'completed');
    const resumed = await launch('codex', {
      address: first.address.address,
      native: first.input.upstreamSessionId,
      username: first.input.username,
    });
    expect(resumed.address.id).toBe(first.address.id);
    expect(resumed.address.name).not.toBe(first.address.name);
    expect((await service.translate(first.address.id)).name).toBe(resumed.address.name);
    expect(
      (await db!.select().from(agentSessions).where(eq(agentSessions.id, first.sessionId)))[0]?.launchName,
    ).toBe(first.address.name);
  });
  it('moves the name when native identity changes inside a launch', async () => {
    const agent = await launch();
    const moved = await db!.transaction(async (tx) => {
      const [session] = await tx
        .select()
        .from(agentSessions)
        .where(eq(agentSessions.id, agent.sessionId))
        .for('update');
      return await bindNativeMessagingIdentityLocked(tx, session!, randomUUID(), nowIso());
    });
    expect(moved.id).not.toBe(agent.address.id);
    expect(moved.launchName).toBe(agent.address.name);
    expect((await service.translate(agent.address.name!)).uuid).toBe(moved.id);
  });
  it('reserves pool names from manual aliases and blocks existing conflicting aliases', async () => {
    const agent = await launch();
    await expect(service.setAddressAlias(agent.address.id, 'Claudia')).rejects.toMatchObject({
      code: 'agent_messaging_alias_reserved',
    });
    await service.setAddressAlias(agent.address.id, 'build-bot');
    await db!
      .update(agentBusAddresses)
      .set({ displayAlias: 'agent:claudia' })
      .where(eq(agentBusAddresses.id, agent.address.id));
    await onlyClaudia();
    expect((await launch()).address.name).toBeNull();
  });
  it('serves authenticated host, session and admin translation without registering another launch', async () => {
    const agent = await launch();
    const app = Fastify({ logger: false });
    await app.register(envelopePlugin);
    app.decorate('requireAdmin', async () => {});
    app.decorate('resolveAdmin', async () => null);
    await registerAgentMessagingRoutes(app, {
      db: db!,
      env: loadTestEnv(),
      keyring: testKeyring(),
    } as RouteContext);
    try {
      const before = identities.length;
      const sessionUrl = `/host/agent-sessions/${agent.sessionId}/agent-messaging/translate`;
      const denied = await app.inject({
        method: 'POST',
        url: sessionUrl,
        payload: { value: agent.address.name },
      });
      expect(denied.statusCode).toBe(403);
      const session = await app.inject({
        method: 'POST',
        url: sessionUrl,
        headers: { 'x-agent-bridge-token': agent.token },
        payload: { value: agent.address.name },
      });
      expect(session.statusCode).toBe(200);
      expect(session.json()).toMatchObject({ uuid: agent.address.id });
      const hostLookup = await app.inject({
        method: 'POST',
        url: '/host/agent-messaging/translate',
        headers: { 'x-api-key': host.apiKey! },
        payload: { value: agent.address.id },
      });
      expect(hostLookup.statusCode).toBe(200);
      expect(hostLookup.json()).toMatchObject({ name: agent.address.name });
      const adminLookup = await app.inject({
        method: 'GET',
        url: `/admin/agent-messaging/translate?value=${agent.address.id}`,
      });
      expect(adminLookup.statusCode).toBe(200);
      expect(adminLookup.json()).toMatchObject({ name: agent.address.name });
      expect(identities.length).toBe(before);
      expect(await db!.select().from(agentSessions).where(eq(agentSessions.hostId, host.id))).toHaveLength(1);
    } finally {
      await app.close();
    }
  });
  it('renders assigned names and fresh task titles in actual session snapshots', async () => {
    const agent = await launch();
    const portal = new AgentPortalService(db!, loadTestEnv(), testKeyring());
    const insertName = async (name: string, nativeId: string) =>
      await db!
        .insert(agentEvents)
        .values({
          sessionId: agent.sessionId,
          clientEventId: randomUUID(),
          eventType: 'session_named',
          source: 'engine',
          payloadEnc: encrypt(JSON.stringify({ name, native_session_id: nativeId }), testKeyring()),
          createdAt: nowIso(),
        });
    expect((await portal.listAgentsSnapshot()).sessions.find((s) => s.id === agent.sessionId)).toMatchObject({
      session_name: `(${agent.address.name})`,
      task_title: null,
    });
    await insertName('API review', agent.input.upstreamSessionId);
    expect((await portal.listAgentsSnapshot()).sessions.find((s) => s.id === agent.sessionId)).toMatchObject({
      session_name: `(${agent.address.name}) API review`,
      task_title: 'API review',
    });
    await insertName('Fix tests', agent.input.upstreamSessionId);
    expect((await portal.listAgentsSnapshot()).sessions.find((s) => s.id === agent.sessionId)).toMatchObject({
      session_name: `(${agent.address.name}) Fix tests`,
    });
    await insertName('Wrong transcript', randomUUID());
    expect((await portal.listAgentsSnapshot()).sessions.find((s) => s.id === agent.sessionId)).toMatchObject({
      session_name: `(${agent.address.name})`,
      task_title: null,
    });
  });
  it('composes task titles without changing old launch identities', async () => {
    const agent = await launch();
    expect(namedSessionTitle(agent.address.name, 'Review')).toBe(`(${agent.address.name}) Review`);
    expect(agentNameKey(' BÄRBEL ')).toBe('baerbel');
  });
});
