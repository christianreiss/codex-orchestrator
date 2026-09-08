import Fastify, { type FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { adminUsers, agentEvents, agentMessages, agentPrompts, agentSessions, hosts } from '../../../src/db/schema.js';
import { AgentPortalService, type PortalActor, type RegisterAgentInput } from '../../../src/services/agent-portal.js';
import { registerAgentPortalAdminHostRoutes } from '../../../src/routes/agent-portal/admin-host.js';
import { wsPublisher } from '../../../src/ws/publisher.js';
import { getTestDb } from '../../helpers/test-db.js';
import { loadTestEnv, testKeyring } from '../../helpers/test-keyring.js';

const handle = await getTestDb();
const PREFIX = 'ztest-active-clients';

describe.skipIf(!handle)('Active Clients presence and recovery against MySQL', () => {
  const db = handle?.db;
  let host: typeof hosts.$inferSelect;
  let actor: PortalActor;
  let service: AgentPortalService;
  let app: FastifyInstance;
  const exec = async (text: string) => await db!.execute(sql.raw(text));
  const cleanSessions = async () => {
    if (!host) return;
    await exec(`DELETE FROM agent_messages WHERE session_id IN (SELECT id FROM agent_sessions WHERE host_id = ${host.id})`);
    await exec(`DELETE FROM agent_prompts WHERE session_id IN (SELECT id FROM agent_sessions WHERE host_id = ${host.id})`);
    await exec(`DELETE FROM agent_events WHERE session_id IN (SELECT id FROM agent_sessions WHERE host_id = ${host.id})`);
    await exec(`DELETE FROM agent_sessions WHERE host_id = ${host.id}`);
  };

  beforeAll(async () => {
    const now = new Date().toISOString();
    await exec(`INSERT INTO hosts (fqdn, api_key, status, engines, created_at, updated_at)
      VALUES ('${PREFIX}.example', '${'b'.repeat(64)}', 'active', 'codex,claude', '${now}', '${now}')`);
    host = (await db!.select().from(hosts).where(eq(hosts.fqdn, `${PREFIX}.example`)))[0]!;
    await exec(`INSERT INTO admin_users (name, username, email, password_hash, access_level, active, created_at, updated_at)
      VALUES ('Presence operator', '${PREFIX}', '${PREFIX}@example.test', 'x', 'owner', 1, '${now}', '${now}')`);
    const admin = (await db!.select().from(adminUsers).where(eq(adminUsers.username, PREFIX)))[0]!;
    actor = { kind: 'admin', user: { id: admin.id, displayName: admin.name } };
    const env = {
      ...loadTestEnv(), PUBLIC_BASE_URL: 'https://portal.example',
      AGENT_PORTAL_HEARTBEAT_FRESH_SECONDS: 45, AGENT_PORTAL_RELAY_FRESH_SECONDS: 30,
      AGENT_PORTAL_BRIDGE_TTL_SECONDS: 900,
    };
    service = new AgentPortalService(db!, env, testKeyring());
    app = Fastify({ logger: false });
    app.decorate('requireAdmin', async () => {});
    await registerAgentPortalAdminHostRoutes(app, { db: db!, env, keyring: testKeyring() });
    await app.ready();
    await service.setEnabled(true);
  });

  beforeEach(async () => {
    await cleanSessions();
    await db!.update(hosts).set({ status: 'active', engines: 'codex,claude', apiKey: host.apiKey }).where(eq(hosts.id, host.id));
  });

  afterAll(async () => {
    await app?.close();
    await cleanSessions();
    await exec(`DELETE FROM hosts WHERE fqdn = '${PREFIX}.example'`);
    await exec(`DELETE FROM admin_users WHERE username = '${PREFIX}'`);
    await service?.setEnabled(false);
    await handle?.pool.end();
  });

  async function live(engine: 'codex' | 'claude') {
    const input: RegisterAgentInput = { engine, username: 'presence-test', cwd: '/tmp/presence-test', invocationKind: 'interactive' };
    const registered = await service.registerAgent(host, input);
    if (!registered.enabled) throw new Error('portal disabled in fixture');
    await service.heartbeatAgent(registered.session_id, registered.bridge_token, { relayAction: 'poll' }, host.id);
    return { ...registered, input: { ...input, sessionId: registered.session_id, bridgeToken: registered.bridge_token } };
  }

  async function row(id: string, at?: number) {
    return (await service.listAgents(at)).find((item) => item.id === id)!;
  }
  const send = (id: string) => service.enqueueMessage(actor, { sessionId: id, clientMessageId: randomUUID(), content: 'check in' });

  describe.each(['codex', 'claude'] as const)('%s', (engine) => {
    it('provides raw relay clocks and ages listening independently of wrapper liveness', async () => {
      const session = await live(engine);
      expect(await row(session.session_id)).toMatchObject({ engine, presence: 'listening', relay_enabled: true, relay_ready: true });
      expect((await row(session.session_id)).relay_heartbeat_at).toBeTruthy();
      expect(service.timings()).toMatchObject({ heartbeat_fresh_seconds: 45, relay_fresh_seconds: 30, working_fresh_seconds: 300 });
      await db!.update(agentSessions).set({ relayHeartbeatAt: new Date(Date.now() - 40_000).toISOString() }).where(eq(agentSessions.id, session.session_id));
      expect(await row(session.session_id)).toMatchObject({ presence: 'idle', relay_ready: false });
      await expect(send(session.session_id)).rejects.toMatchObject({ code: 'agent_relay_unavailable' });
    });

    it.each(['not-a-date', '2026-02-30T12:00:00Z', '2099-01-01T00:00:00Z'])('never treats %s as a live heartbeat', async (heartbeatAt) => {
      const session = await live(engine);
      await db!.update(agentSessions).set({ heartbeatAt }).where(eq(agentSessions.id, session.session_id));
      expect(await row(session.session_id)).toMatchObject({ presence: 'offline', relay_ready: false });
      await expect(send(session.session_id)).rejects.toMatchObject({ code: 'agent_relay_unavailable' });
    });

    it('uses timestamp instants, including fractions and offsets at the freshness boundary', async () => {
      const session = await live(engine);
      const now = Date.now();
      // Non-UTC representation of a fresh instant, deliberately not lexically comparable.
      const offset = new Date(now + 3_600_000 - 10_000).toISOString().replace('Z', '+01:00');
      await db!.update(agentSessions).set({ heartbeatAt: offset, relayHeartbeatAt: offset }).where(eq(agentSessions.id, session.session_id));
      expect(await row(session.session_id, now)).toMatchObject({ presence: 'listening' });
      await db!.update(agentSessions).set({ heartbeatAt: new Date(now - 45_000).toISOString() }).where(eq(agentSessions.id, session.session_id));
      expect(await row(session.session_id, now)).toMatchObject({ presence: 'offline' });
    });

    it('renews an expired bridge without creating another session and cannot revive a finished one', async () => {
      const session = await live(engine);
      await db!.update(agentSessions).set({ bridgeExpiresAt: new Date(Date.now() - 1000).toISOString() }).where(eq(agentSessions.id, session.session_id));
      expect(await row(session.session_id)).toMatchObject({ presence: 'offline' });
      await expect(send(session.session_id)).rejects.toMatchObject({ code: 'agent_relay_unavailable' });
      await expect(service.heartbeatAgent(session.session_id, session.bridge_token, {}, host.id)).rejects.toMatchObject({ code: 'agent_bridge_expired' });
      expect(await service.registerAgent(host, session.input)).toMatchObject({ session_id: session.session_id, bridge_token: session.bridge_token });
      expect(await row(session.session_id)).toMatchObject({ presence: 'listening' });
      await service.finishAgent(session.session_id, session.bridge_token, { status: 'completed' }, host.id);
      await expect(service.registerAgent(host, session.input)).rejects.toMatchObject({ code: 'agent_session_finished' });
      expect(await row(session.session_id)).toMatchObject({ presence: 'ended', read_only: true });
    });

    it.each([
      { patch: { status: 'disabled' }, code: 'agent_bridge_host_inactive' },
      { patch: { engines: engine === 'codex' ? 'claude' : 'codex' }, code: 'engine_disabled' },
      { patch: { apiKey: 'c'.repeat(64) }, code: 'agent_bridge_host_auth_changed' },
    ])('removes reachability and rejects delayed registration after $code', async ({ patch, code }) => {
      const session = await live(engine);
      await db!.update(hosts).set(patch).where(eq(hosts.id, host.id));
      expect(await row(session.session_id)).toMatchObject({ presence: 'offline', relay_ready: false, read_only: false });
      await expect(send(session.session_id)).rejects.toMatchObject({ code: 'agent_relay_unavailable' });
      await expect(service.registerAgent(host, session.input)).rejects.toMatchObject({ code });
    });

    it('resolves its own notice while preserving the active turn, relay and unanswered prompt', async () => {
      const session = await live(engine);
      const other = await live(engine === 'codex' ? 'claude' : 'codex');
      const promptId = randomUUID();
      const publish = (type: 'attention' | 'attention_resolved' | 'waiting_input', payload: Record<string, unknown>) =>
        service.addAgentEvent(session.session_id, session.bridge_token, { clientEventId: randomUUID(), type, source: 'engine', payload }, host.id);
      await publish('waiting_input', { prompt_id: promptId, question: 'Approve this change?', options: ['Yes', 'No'] });
      await service.heartbeatAgent(session.session_id, session.bridge_token, { activeTurnId: 'current-turn' }, host.id);
      await publish('attention', { summary: 'Status was accidentally marked as attention' });
      await service.addAgentEvent(other.session_id, other.bridge_token, { clientEventId: randomUUID(), type: 'attention', source: 'engine', payload: { summary: 'Other session still needs help' } }, host.id);
      const beforeSession = (await db!.select().from(agentSessions).where(eq(agentSessions.id, session.session_id)))[0]!;
      const beforePrompt = (await db!.select().from(agentPrompts).where(eq(agentPrompts.id, promptId)))[0]!;
      const resolutionPayload = { client_event_id: randomUUID(), type: 'attention_resolved', payload: { summary: '  Continuing normally  ', prompt_id: promptId, question: 'Should be ignored', answer: 'Yes', author: 'Operator' } };
      // Exercise the real route allowlist and bridge scoping, not only the service.
      const denied = await app.inject({ method: 'POST', url: `/host/agent-sessions/${other.session_id}/events`, headers: { 'x-agent-bridge-token': session.bridge_token }, payload: resolutionPayload });
      expect(denied.statusCode).toBe(401);
      const response = await app.inject({ method: 'POST', url: `/host/agent-sessions/${session.session_id}/events`, headers: { 'x-agent-bridge-token': session.bridge_token }, payload: resolutionPayload });
      expect(response.statusCode).toBe(200);
      const resolved = response.json<Record<string, unknown>>();
      expect(resolved).toMatchObject({ type: 'attention_resolved', source: 'engine', payload: { summary: 'Continuing normally' } });
      expect(resolved.payload).toEqual({ summary: 'Continuing normally' });
      expect(await row(session.session_id)).toMatchObject({ attention: null, pending_prompt: { id: promptId, question: 'Approve this change?' } });
      expect(await row(other.session_id)).toMatchObject({ attention: { summary: 'Other session still needs help' } });
      expect((await db!.select().from(agentSessions).where(eq(agentSessions.id, session.session_id)))[0]).toEqual(beforeSession);
      expect((await db!.select().from(agentPrompts).where(eq(agentPrompts.id, promptId)))[0]).toEqual(beforePrompt);
      expect(beforePrompt).toMatchObject({ status: 'open', answeredAt: null, answerMessageId: null });
      expect(await db!.select().from(agentMessages).where(eq(agentMessages.sessionId, session.session_id))).toEqual([]);
      const timeline = await service.listEvents(session.session_id);
      expect(timeline.events.map((event) => event.type)).toContain('attention');
      expect(timeline.events.map((event) => event.type)).toContain('attention_resolved');
    });

    it('keeps later attention raised when an older resolution is retried', async () => {
      const session = await live(engine);
      const event = { clientEventId: randomUUID(), type: 'attention_resolved' as const, source: 'engine' as const, payload: { summary: 'Withdraw accidental notice' } };
      await service.addAgentEvent(session.session_id, session.bridge_token, { clientEventId: randomUUID(), type: 'attention', source: 'engine', payload: { summary: 'First notice' } }, host.id);
      const first = await service.addAgentEvent(session.session_id, session.bridge_token, event, host.id);
      expect(await row(session.session_id)).toMatchObject({ attention: null });
      await service.addAgentEvent(session.session_id, session.bridge_token, { clientEventId: randomUUID(), type: 'attention', source: 'engine', payload: { summary: 'A new genuine request' } }, host.id);
      const replay = await service.addAgentEvent(session.session_id, session.bridge_token, event, host.id);
      expect(replay).toEqual(first);
      expect(await row(session.session_id)).toMatchObject({ attention: { summary: 'A new genuine request' } });
      const resolutions = (await db!.select().from(agentEvents).where(eq(agentEvents.sessionId, session.session_id))).filter((item) => item.eventType === 'attention_resolved');
      expect(resolutions).toHaveLength(1);
      await expect(service.addAgentEvent(session.session_id, session.bridge_token, { ...event, payload: { summary: 'Different reason' } }, host.id)).rejects.toMatchObject({ code: 'client_event_id_conflict' });
    });

    it('permits empty resolution summaries and bounds Unicode text without broken characters', async () => {
      const session = await live(engine);
      const bare = await service.addAgentEvent(session.session_id, session.bridge_token, { clientEventId: randomUUID(), type: 'attention_resolved', source: 'engine' }, host.id);
      expect(bare.payload).toEqual({});
      const bounded = await service.addAgentEvent(session.session_id, session.bridge_token, { clientEventId: randomUUID(), type: 'attention_resolved', source: 'engine', payload: { summary: 'a'.repeat(999) + '🙂' } }, host.id);
      const summary = (bounded.payload as { summary: string }).summary;
      expect(summary).toBe('a'.repeat(999));
      expect(Buffer.byteLength(summary, 'utf8')).toBeLessThanOrEqual(1000);
    });

    it('publishes committed transitions and transcript updates without publishing ordinary heartbeats', async () => {
      const session = await live(engine);
      const seen: string[] = [];
      const stop = wsPublisher.subscribe((event) => {
        if (event.type === 'agent_portal.sessions.changed') seen.push((event.payload as { session_id: string }).session_id);
      });
      try {
        await service.heartbeatAgent(session.session_id, session.bridge_token, {}, host.id);
        await service.heartbeatAgent(session.session_id, session.bridge_token, { relayAction: 'poll' }, host.id);
        expect(seen).toEqual([]);
        await service.heartbeatAgent(session.session_id, session.bridge_token, { relayAction: 'close' }, host.id);
        expect(seen).toEqual([session.session_id]);
        await service.addAgentEvent(session.session_id, session.bridge_token, { clientEventId: randomUUID(), type: 'progress', source: 'engine', payload: { text: 'proof' } }, host.id);
        expect(seen).toEqual([session.session_id, session.session_id]);
      } finally { stop(); }
    });
  });

  it('queries only the selected session and preserves its global event cursor', async () => {
    const codex = await live('codex');
    const claude = await live('claude');
    const page = await service.listEventsAfter(0, 250, claude.session_id);
    expect(page.events.length).toBeGreaterThan(0);
    expect(page.events.every((event) => event.session_id === claude.session_id)).toBe(true);
    expect(page.events.some((event) => event.session_id === codex.session_id)).toBe(false);
    expect(await service.listEventsAfter(page.next_cursor, 250, claude.session_id)).toEqual({ events: [], next_cursor: page.next_cursor });
  });
});
