import Fastify from 'fastify';
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { agentSessions, hosts } from '../../../src/db/schema.js';
import { AgentPortalService } from '../../../src/services/agent-portal.js';
import { registerAgentPortalAdminHostRoutes } from '../../../src/routes/agent-portal/admin-host.js';
import { getTestDb } from '../../helpers/test-db.js';
import { loadTestEnv, testKeyring } from '../../helpers/test-keyring.js';
import { wsPublisher } from '../../../src/ws/publisher.js';
const handle = await getTestDb();
describe.skipIf(!handle)('native activity persistence and authenticated HTTP', () => {
  const db = handle?.db;
  let host: typeof hosts.$inferSelect;
  let service: AgentPortalService;
  const app = Fastify();
  const ids: string[] = [];
  beforeAll(async () => {
    const now = new Date().toISOString();
    await db!.execute(
      sql`INSERT INTO hosts (fqdn,api_key,status,engines,created_at,updated_at) VALUES ('ztest-native-activity.example',${'c'.repeat(64)},'active','codex,claude,grok',${now},${now})`,
    );
    host = (await db!.select().from(hosts).where(eq(hosts.fqdn, 'ztest-native-activity.example')))[0]!;
    const env = loadTestEnv();
    service = new AgentPortalService(db!, env, testKeyring());
    app.decorate('requireAdmin', async () => {});
    app.setErrorHandler((error, _req, reply) =>
      reply
        .code((error as { status?: number }).status ?? 500)
        .send({ code: (error as { code?: string }).code }),
    );
    await registerAgentPortalAdminHostRoutes(app, { db: db!, env, keyring: testKeyring() });
    await app.ready();
    await service.setEnabled(true);
  });
  afterAll(async () => {
    await app.close();
    for (const id of ids) await db!.delete(agentSessions).where(eq(agentSessions.id, id));
    if (host) await db!.delete(hosts).where(eq(hosts.id, host.id));
    await service?.setEnabled(false);
    await handle?.pool.end();
  });
  it.each(['codex', 'claude', 'grok'] as const)(
    '%s reports terminal work without a portal turn',
    async (engine) => {
      const registered = await service.registerAgent(host, {
        engine,
        username: 'activity-test',
        cwd: '/tmp',
        invocationKind: 'interactive',
      });
      if (!registered.enabled) throw new Error('portal disabled');
      const id = registered.session_id;
      ids.push(id);
      const generation = randomUUID();
      const native = randomUUID();
      const now = new Date().toISOString();
      await db!
        .update(agentSessions)
        .set({
          upstreamSessionId: native,
          bindingGeneration: 2,
          receiver: {
            generation,
            native_session_id: native,
            protocol:
              engine === 'codex' ? 'codex-queue-v1' : engine === 'grok' ? 'grok-acp-v1' : 'claude-channel-v1',
            heartbeat_at: now,
            failure: null,
            probes: { portal: {} },
          },
        })
        .where(eq(agentSessions.id, id));
      const body = {
        generation,
        binding_generation: 2,
        native_session_id: native,
        sequence: 1,
        state: 'working',
        wait_reason: null,
        source: { codex: 'codex-thread', claude: 'claude-hooks', grok: 'grok-session' }[engine],
        evidence_age_ms: 0,
      };
      const request = (payload = body, token = registered.bridge_token) =>
        app.inject({
          method: 'POST',
          url: `/host/agent-sessions/${id}/activity`,
          headers: { 'x-agent-bridge-token': token },
          payload,
        });
      const publish = vi.spyOn(wsPublisher, 'publish');
      expect((await request()).json()).toMatchObject({ accepted: true });
      expect(publish).toHaveBeenCalledWith('agent_portal.sessions.changed', { session_id: id });
      publish.mockClear();
      expect((await request()).json()).toMatchObject({ accepted: false });
      expect(publish).not.toHaveBeenCalled();
      const [stored] = await db!.select().from(agentSessions).where(eq(agentSessions.id, id));
      expect(stored!.activeTurnId).toBeNull();
      expect((await service.listAgents()).find((a) => a.id === id)).toMatchObject({
        activity: { state: 'working' },
        active_turn_id: null,
      });
      expect((await request({ ...body, binding_generation: 1, sequence: 2 })).statusCode).toBe(409);
      expect((await request(body, 'bad-token')).statusCode).toBe(401);
      expect((await request({ ...body, sequence: 2, state: 'idle' })).json()).toMatchObject({
        accepted: true,
      });
      expect((await service.listAgents()).find((a) => a.id === id)).toMatchObject({
        activity: { state: 'idle' },
      });
      expect((await request(body)).json()).toMatchObject({ accepted: false });
      publish.mockRestore();
    },
  );
});
