/**
 * The lifecycle edges an operator actually hits, against a real database.
 *
 * Each case here corresponds to a way the portal used to strand somebody: a
 * dead agent that could not be ended, a notice that could never be cleared, an
 * instruction accepted and then silently thrown away, and a busy agent that
 * reported itself unreachable. `durability.test.ts` covers the happy paths and
 * the storage guarantees; this file covers what happens when the agent stops
 * behaving.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { eq, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { agentEvents, agentMessages, agentSessions, hosts } from '../../../src/db/schema.js';
import { splitSqlStatements } from '../../../src/db/migration-sql.js';
import type { Env } from '../../../src/env.js';
import {
  AGENT_PORTAL_ENABLED_KEY,
  AgentPortalService,
  type PortalIdentity,
} from '../../../src/services/agent-portal.js';
import { getTestDb, type TestDb } from '../../helpers/test-db.js';
import { loadTestEnv, testKeyring } from '../../helpers/test-keyring.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = [
  join(HERE, '../../../src/db/migrations/0008_add_agent_portal.sql'),
  join(HERE, '../../../src/db/migrations/0009_drop_agent_portal_matrix.sql'),
  join(HERE, '../../../src/db/migrations/0015_add_agent_session_close_request.sql'),
];
const PREFIX = 'ztest-portal-lifecycle';
const HOST_FQDN = `${PREFIX}.example`;
const HOST_KEY = 'b'.repeat(64);
const RELAY_FRESH_SECONDS = 60;
/** Mirrors AGENT_PORTAL_WORKING_RELAY_MULTIPLE. */
const WORKING_MAX_SECONDS = RELAY_FRESH_SECONDS * 10;
const handle = await getTestDb();

interface World {
  service: AgentPortalService;
  identity: PortalIdentity;
  sessionId: string;
  bridgeToken: string;
}

describe.skipIf(!handle)('agent portal lifecycle edges', { timeout: 120_000 }, () => {
  let db: TestDb;
  let env: Env;
  let host: typeof hosts.$inferSelect;

  const exec = async (query: string) => await db.execute(sql.raw(query));

  const cleanup = async (): Promise<void> => {
    await exec(`DELETE FROM agent_messages WHERE portal_user_id IN (
      SELECT id FROM agent_portal_users WHERE display_name LIKE '${PREFIX}%'
    )`);
    for (const table of ['agent_prompts', 'agent_events']) {
      await exec(`DELETE FROM ${table} WHERE session_id IN (
        SELECT id FROM agent_sessions WHERE host_id = ${host?.id ?? 0}
      )`);
    }
    await exec(`DELETE FROM agent_sessions WHERE host_id = ${host?.id ?? 0}`);
    await exec(`DELETE FROM agent_portal_browser_sessions WHERE user_id IN (
      SELECT id FROM agent_portal_users WHERE display_name LIKE '${PREFIX}%'
    )`);
    await exec(`DELETE FROM agent_portal_users WHERE display_name LIKE '${PREFIX}%'`);
    await exec(
      `INSERT INTO versions (name, version, updated_at)
       VALUES ('${AGENT_PORTAL_ENABLED_KEY}', '0', '1970-01-01T00:00:00.000Z')
       ON DUPLICATE KEY UPDATE version = '0', updated_at = VALUES(updated_at)`,
    );
  };

  beforeAll(async () => {
    db = handle!.db;
    for (const migration of MIGRATIONS) {
      for (const statement of splitSqlStatements(readFileSync(migration, 'utf8'))) {
        await exec(statement);
      }
    }
    await exec(`DELETE FROM hosts WHERE fqdn = '${HOST_FQDN}'`);
    const now = new Date().toISOString();
    await exec(
      `INSERT INTO hosts (fqdn, api_key, status, engines, created_at, updated_at)
       VALUES ('${HOST_FQDN}', '${HOST_KEY}', 'active', 'codex', '${now}', '${now}')`,
    );
    host = (await db.select().from(hosts).where(eq(hosts.fqdn, HOST_FQDN)).limit(1))[0]!;
    env = {
      ...loadTestEnv(),
      PUBLIC_BASE_URL: 'https://portal.example',
      AGENT_PORTAL_BRIDGE_TTL_SECONDS: 900,
      AGENT_PORTAL_RETENTION_HOURS: 24,
      AGENT_PORTAL_SESSION_TTL_HOURS: 24,
      AGENT_PORTAL_HEARTBEAT_FRESH_SECONDS: 45,
      AGENT_PORTAL_RELAY_FRESH_SECONDS: RELAY_FRESH_SECONDS,
    } as Env;
  });

  beforeEach(cleanup);
  afterEach(cleanup);
  afterAll(async () => {
    await cleanup();
    await exec(`DELETE FROM hosts WHERE fqdn = '${HOST_FQDN}'`);
    await handle?.pool.end();
  });

  async function makeWorld(label: string = randomUUID()): Promise<World> {
    const service = new AgentPortalService(db, env, testKeyring());
    await service.setEnabled(true);
    const created = await service.createUser({ displayName: `${PREFIX}-${label}` });
    const token = decodeURIComponent(new URL(created.magic_url).hash.slice(3));
    const login = await service.exchangeMagicLink({ publicId: created.user.public_id, token });
    const registered = await service.registerAgent(host, {
      engine: 'codex',
      username: 'portal-test',
      cwd: '/tmp/portal-test',
      invocationKind: 'interactive',
    });
    if (!registered.enabled) throw new Error('portal unexpectedly disabled');
    await service.heartbeatAgent(
      registered.session_id,
      registered.bridge_token,
      { relayAction: 'poll' },
      host.id,
    );
    return {
      service,
      identity: login.identity,
      sessionId: registered.session_id,
      bridgeToken: registered.bridge_token,
    };
  }

  const agentOf = async (world: World) =>
    (await world.service.listAgents()).find((agent) => agent['id'] === world.sessionId)!;

  const eventTypes = async (sessionId: string) =>
    (await db.select({ type: agentEvents.eventType }).from(agentEvents).where(eq(agentEvents.sessionId, sessionId)))
      .map((row) => row.type);

  const raiseAttention = async (world: World, summary: string) =>
    await world.service.addAgentEvent(
      world.sessionId,
      world.bridgeToken,
      { clientEventId: randomUUID(), type: 'attention', source: 'bridge', payload: { summary } },
      host.id,
    );

  /** Ages the relay heartbeat without touching liveness, i.e. the agent is up but not polling. */
  const staleRelay = async (sessionId: string) =>
    await db
      .update(agentSessions)
      .set({ relayHeartbeatAt: new Date(Date.now() - (RELAY_FRESH_SECONDS + 30) * 1000).toISOString() })
      .where(eq(agentSessions.id, sessionId));

  /**
   * Marks the session as executing a turn. `cxx portal accept` does exactly
   * this: acknowledge, then stamp the turn on the heartbeat.
   */
  const beginTurn = async (world: World, secondsAgo = 0) => {
    const messageId = randomUUID();
    await db.insert(agentEvents).values({
      sessionId: world.sessionId,
      clientEventId: `accepted:${messageId}`,
      eventType: 'message_accepted',
      source: 'portal',
      payloadEnc: JSON.stringify({}),
      createdAt: new Date(Date.now() - secondsAgo * 1000).toISOString(),
    });
    await db
      .update(agentSessions)
      .set({ activeTurnId: messageId })
      .where(eq(agentSessions.id, world.sessionId));
    return messageId;
  };

  describe('a dead session releases the operator', () => {
    // The notice used to stay outstanding for the whole retention window with
    // no action that cleared it, because the only clearing events are the
    // operator's own and neither can be sent to an agent that is gone.
    it('stops reporting attention once the session has ended', async () => {
      const world = await makeWorld();
      await raiseAttention(world, 'needs a decision');
      expect(await agentOf(world)).toMatchObject({ attention: { summary: 'needs a decision' } });

      await world.service.forceClose({ kind: 'portal', identity: world.identity }, {
        sessionId: world.sessionId,
        clientMessageId: randomUUID(),
      });

      const ended = await agentOf(world);
      expect(ended['attention']).toBeNull();
      expect(ended).toMatchObject({ presence: 'ended', read_only: true });
    });

    // forceClose is the escalation the UI reaches when a cooperative close is
    // refused, so it must not itself require a reachable agent.
    it('force-ends an agent that never opened a relay', async () => {
      const world = await makeWorld();
      await world.service.heartbeatAgent(world.sessionId, world.bridgeToken, { relayAction: 'close' }, host.id);
      expect(await agentOf(world)).toMatchObject({ presence: 'idle' });

      const forced = await world.service.forceClose({ kind: 'portal', identity: world.identity }, {
        sessionId: world.sessionId,
        clientMessageId: randomUUID(),
      });
      expect(forced).toMatchObject({ forced: true, already_ended: false, status: 'completed' });
    });

    // The cooperative close is what the UI tries first; its refusal is what
    // tells the client to escalate rather than report a dead end.
    it('refuses a cooperative close against an unreachable agent', async () => {
      const world = await makeWorld();
      await staleRelay(world.sessionId);
      await expect(
        world.service.requestClose({ kind: 'portal', identity: world.identity }, {
          sessionId: world.sessionId,
          clientMessageId: randomUUID(),
        }),
      ).rejects.toMatchObject({ code: 'agent_relay_unavailable' });
    });
  });

  describe('a message is never discarded in silence', () => {
    it('emits message_canceled when a queued instruction is cancelled undelivered', async () => {
      const world = await makeWorld();
      const queued = await world.service.enqueueMessage({ kind: 'portal', identity: world.identity }, {
        sessionId: world.sessionId,
        clientMessageId: randomUUID(),
        content: 'please stop',
      });
      expect(queued).toMatchObject({ status: 'queued' });
      expect(await eventTypes(world.sessionId)).not.toContain('message_canceled');

      // The agent's process exits: `cxx portal leave` cancels everything pending.
      await world.service.heartbeatAgent(world.sessionId, world.bridgeToken, { relayAction: 'close' }, host.id);

      expect(await eventTypes(world.sessionId)).toContain('message_canceled');
      const rows = await db
        .select({ status: agentMessages.status })
        .from(agentMessages)
        .where(eq(agentMessages.sessionId, world.sessionId));
      expect(rows[0]).toMatchObject({ status: 'canceled' });
    });

    it('announces an undelivered message when the session is force-ended', async () => {
      const world = await makeWorld();
      await world.service.enqueueMessage({ kind: 'portal', identity: world.identity }, {
        sessionId: world.sessionId,
        clientMessageId: randomUUID(),
        content: 'still queued',
      });
      await world.service.forceClose({ kind: 'portal', identity: world.identity }, {
        sessionId: world.sessionId,
        clientMessageId: randomUUID(),
      });
      expect(await eventTypes(world.sessionId)).toContain('message_canceled');
    });
  });

  describe('working is reported from the turn, not guessed from the relay', () => {
    // The relay goes stale during execution because nothing polls while the
    // agent works. Reporting that as "not listening" was the ambiguity this
    // state exists to remove.
    it('reports working while a turn is open even with a stale relay', async () => {
      const world = await makeWorld();
      await beginTurn(world);
      await staleRelay(world.sessionId);

      const agent = await agentOf(world);
      expect(agent).toMatchObject({ presence: 'working', relay_ready: false });
      expect(agent['active_turn_started_at']).toBeTruthy();
    });

    // Otherwise a turn that died between accept and say would hold the channel
    // open and writable until the bridge credential lapsed.
    it('falls back to idle once the turn outlives its ceiling', async () => {
      const world = await makeWorld();
      await beginTurn(world, WORKING_MAX_SECONDS + 60);
      await staleRelay(world.sessionId);

      const agent = await agentOf(world);
      expect(agent).toMatchObject({ presence: 'idle' });
      expect(agent['active_turn_started_at']).toBeNull();
    });

    // A working agent returns to its relay and reads the queue then, so holding
    // the message is right; refusing it was the old behaviour.
    it('accepts an instruction queued mid-turn', async () => {
      const world = await makeWorld();
      await beginTurn(world);
      await staleRelay(world.sessionId);

      const queued = await world.service.enqueueMessage({ kind: 'portal', identity: world.identity }, {
        sessionId: world.sessionId,
        clientMessageId: randomUUID(),
        content: 'one more thing',
      });
      expect(queued).toMatchObject({ status: 'queued' });
    });

    it('refuses an instruction once the turn has aged out', async () => {
      const world = await makeWorld();
      await beginTurn(world, WORKING_MAX_SECONDS + 60);
      await staleRelay(world.sessionId);

      await expect(
        world.service.enqueueMessage({ kind: 'portal', identity: world.identity }, {
          sessionId: world.sessionId,
          clientMessageId: randomUUID(),
          content: 'too late',
        }),
      ).rejects.toMatchObject({ code: 'agent_relay_unavailable' });
    });

    it('clears a stale turn from the purge sweep', async () => {
      const world = await makeWorld();
      await beginTurn(world, WORKING_MAX_SECONDS + 60);

      const result = await world.service.purgeExpired();
      expect(result.stale_turns).toBe(1);
      const rows = await db
        .select({ activeTurnId: agentSessions.activeTurnId })
        .from(agentSessions)
        .where(eq(agentSessions.id, world.sessionId));
      expect(rows[0]?.activeTurnId).toBeNull();
    });

    it('leaves a live turn alone', async () => {
      const world = await makeWorld();
      await beginTurn(world);
      const result = await world.service.purgeExpired();
      expect(result.stale_turns).toBe(0);
    });
  });
});
