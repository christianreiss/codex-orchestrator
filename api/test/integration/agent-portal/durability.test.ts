import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  agentEvents,
  agentMessages,
  agentPortalUsers,
  agentPrompts,
  agentSessions,
  hosts,
} from '../../../src/db/schema.js';
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
const PREFIX = 'ztest-agent-portal';
const HOST_FQDN = `${PREFIX}.example`;
const HOST_KEY = 'a'.repeat(64);
const handle = await getTestDb();

interface World {
  service: AgentPortalService;
  host: typeof hosts.$inferSelect;
  userId: number;
  identity: PortalIdentity;
  sessionId: string;
  bridgeToken: string;
}

describe.skipIf(!handle)('agent portal durability against a real database', { timeout: 120_000 }, () => {
  let db: TestDb;
  let env: Env;
  let host: typeof hosts.$inferSelect;

  const exec = async (query: string) => await db.execute(sql.raw(query));

  const cleanup = async (): Promise<void> => {
    await exec(`DELETE FROM agent_messages WHERE portal_user_id IN (
      SELECT id FROM agent_portal_users WHERE display_name LIKE '${PREFIX}%'
    )`);
    await exec(`DELETE FROM agent_prompts WHERE session_id IN (
      SELECT id FROM agent_sessions WHERE host_id = ${host?.id ?? 0}
    )`);
    await exec(`DELETE FROM agent_events WHERE session_id IN (
      SELECT id FROM agent_sessions WHERE host_id = ${host?.id ?? 0}
    )`);
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
    const rows = await db.select().from(hosts).where(eq(hosts.fqdn, HOST_FQDN)).limit(1);
    host = rows[0]!;
    env = {
      ...loadTestEnv(),
      PUBLIC_BASE_URL: 'https://portal.example',
      AGENT_PORTAL_BRIDGE_TTL_SECONDS: 900,
      AGENT_PORTAL_RETENTION_HOURS: 24,
      AGENT_PORTAL_SESSION_TTL_HOURS: 24,
    } as Env;
  });

  beforeEach(async () => {
    await cleanup();
  });

  afterEach(async () => {
    await cleanup();
  });

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
    const login = await service.exchangeMagicLink({
      publicId: created.user.public_id,
      token,
    });
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
      host,
      userId: created.user.id,
      identity: login.identity,
      sessionId: registered.session_id,
      bridgeToken: registered.bridge_token,
    };
  }

  async function openPromptAndAnswer(world: World): Promise<{ promptId: string; messageId: string }> {
    const promptId = randomUUID();
    await world.service.addAgentEvent(
      world.sessionId,
      world.bridgeToken,
      {
        clientEventId: `prompt:${promptId}`,
        type: 'waiting_input',
        source: 'bridge',
        payload: { prompt_id: promptId, question: 'Continue?', allow_answer: true },
      },
      world.host.id,
    );
    const answer = await world.service.answerPrompt(world.identity, {
      sessionId: world.sessionId,
      promptId,
      clientMessageId: randomUUID(),
      answer: 'Yes',
      version: 1,
    });
    return { promptId, messageId: String(answer['message_id']) };
  }

  const agentOf = async (world: World) =>
    (await world.service.listAgents()).find((agent) => agent['id'] === world.sessionId)!;

  const backdateHeartbeat = async (sessionId: string, secondsAgo: number) => {
    await db
      .update(agentSessions)
      .set({ heartbeatAt: new Date(Date.now() - secondsAgo * 1000).toISOString() })
      .where(eq(agentSessions.id, sessionId));
  };

  const raiseAttention = async (world: World, summary: string) => {
    await world.service.addAgentEvent(
      world.sessionId,
      world.bridgeToken,
      { clientEventId: randomUUID(), type: 'attention', source: 'bridge', payload: { summary } },
      world.host.id,
    );
  };

  // `status` is written once by registerAgent and never updated, because the
  // wrapper heartbeats with an empty status forever. Every case below asserts it
  // stays 'active' so the compatibility field is pinned and the reason `presence`
  // exists stays documented in the suite.
  describe('presence is derived, because status is not a liveness signal', () => {
    it('reports listening while an #afk relay is polling', async () => {
      const world = await makeWorld();
      expect(await agentOf(world)).toMatchObject({ presence: 'listening', relay_ready: true, status: 'active' });
    });

    it('reports idle after the agent runs portal leave', async () => {
      const world = await makeWorld();
      await world.service.heartbeatAgent(world.sessionId, world.bridgeToken, { relayAction: 'close' }, world.host.id);
      expect(await agentOf(world)).toMatchObject({ presence: 'idle', relay_ready: false, status: 'active' });
    });

    it('reports idle for a session that never opened a relay', async () => {
      const world = await makeWorld();
      const registered = await world.service.registerAgent(host, {
        engine: 'codex',
        username: 'portal-test',
        cwd: '/tmp/portal-never-afk',
        invocationKind: 'interactive',
      });
      if (!registered.enabled) throw new Error('portal unexpectedly disabled');
      const agents = await world.service.listAgents();
      const fresh = agents.find((agent) => agent['id'] === registered.session_id)!;
      expect(fresh).toMatchObject({ presence: 'idle', relay_ready: false, status: 'active' });
    });

    it('reports offline once the heartbeat goes stale', async () => {
      const world = await makeWorld();
      await backdateHeartbeat(world.sessionId, 120);
      expect(await agentOf(world)).toMatchObject({ presence: 'offline', relay_ready: false });
    });

    it('lets ended win over a stale heartbeat', async () => {
      const world = await makeWorld();
      await world.service.finishAgent(world.sessionId, world.bridgeToken, { status: 'completed' }, world.host.id);
      await backdateHeartbeat(world.sessionId, 120);
      expect(await agentOf(world)).toMatchObject({ presence: 'ended', read_only: true });
    });
  });

  describe('outstanding attention is derived from event cursors', () => {
    it('surfaces a notice and its summary', async () => {
      const world = await makeWorld();
      await raiseAttention(world, 'Approve the prod migration?');
      expect(await agentOf(world)).toMatchObject({
        attention: { summary: 'Approve the prod migration?' },
      });
    });

    it('clears once the operator sends a message', async () => {
      const world = await makeWorld();
      await raiseAttention(world, 'Need a decision');
      await world.service.enqueueMessage(world.identity, {
        sessionId: world.sessionId,
        clientMessageId: randomUUID(),
        content: 'go ahead',
      });
      expect(await agentOf(world)).toMatchObject({ attention: null });
    });

    // answerPrompt also writes a user_message event, so answering a prompt
    // clears an unrelated attention notice. Surprising, intended, pinned here.
    it('clears when the operator answers a prompt', async () => {
      const world = await makeWorld();
      await raiseAttention(world, 'Need a decision');
      await openPromptAndAnswer(world);
      expect(await agentOf(world)).toMatchObject({ attention: null });
    });

    it('re-raises for a notice newer than the last reply', async () => {
      const world = await makeWorld();
      await raiseAttention(world, 'first');
      await world.service.enqueueMessage(world.identity, {
        sessionId: world.sessionId,
        clientMessageId: randomUUID(),
        content: 'ok',
      });
      await raiseAttention(world, 'second');
      expect(await agentOf(world)).toMatchObject({ attention: { summary: 'second' } });
    });

    it('leaves last_event_at and attention null for a session with no events', async () => {
      const world = await makeWorld();
      await db.delete(agentEvents).where(eq(agentEvents.sessionId, world.sessionId));
      expect(await agentOf(world)).toMatchObject({ last_event_at: null, attention: null });
    });
  });

  describe('operator-initiated close', () => {
    const requestClose = async (world: World, note?: string) =>
      await world.service.requestClose(world.identity, {
        sessionId: world.sessionId,
        clientMessageId: randomUUID(),
        note,
      });

    const closeRow = async (sessionId: string) => {
      const rows = await db
        .select()
        .from(agentMessages)
        .where(and(eq(agentMessages.sessionId, sessionId), eq(agentMessages.kind, 'close')));
      return rows[0];
    };

    // The core regression: `cxx portal leave` is how an agent acts on a close,
    // so its own leave must not cancel the note it already claimed.
    it('keeps a leased close note alive across the agent"s own portal leave', async () => {
      const world = await makeWorld();
      await requestClose(world, 'wrap up please');
      const claim = await world.service.claimMessage(world.sessionId, world.bridgeToken, randomUUID(), world.host.id);
      expect(claim).toMatchObject({ kind: 'close', content: 'wrap up please' });

      await world.service.heartbeatAgent(world.sessionId, world.bridgeToken, { relayAction: 'close' }, world.host.id);

      expect(await closeRow(world.sessionId)).toMatchObject({ status: 'leased' });
      await expect(
        world.service.acknowledgeMessage(
          world.sessionId,
          world.bridgeToken,
          { messageId: claim!.message_id, leaseOwner: claim!.lease_owner, outcome: 'accepted' },
          world.host.id,
        ),
      ).resolves.toBeTruthy();
    });

    // A queued note can never be delivered once the relay is down and nothing
    // ages it out, so it must not survive to fire on an unrelated later #afk.
    it('cancels a still-queued close note when the relay closes', async () => {
      const world = await makeWorld();
      await requestClose(world);
      await world.service.heartbeatAgent(world.sessionId, world.bridgeToken, { relayAction: 'close' }, world.host.id);

      expect(await closeRow(world.sessionId)).toMatchObject({ status: 'canceled' });
      const sessions = await db.select().from(agentSessions).where(eq(agentSessions.id, world.sessionId));
      expect(sessions[0]?.closeRequestedAt).toBeTruthy();
    });

    it('walks close.state from pending to acknowledged', async () => {
      const world = await makeWorld();
      await requestClose(world);
      expect(await agentOf(world)).toMatchObject({ close: { state: 'pending' } });

      const claim = await world.service.claimMessage(world.sessionId, world.bridgeToken, randomUUID(), world.host.id);
      expect(await agentOf(world)).toMatchObject({ close: { state: 'pending' } });

      await world.service.acknowledgeMessage(
        world.sessionId,
        world.bridgeToken,
        { messageId: claim!.message_id, leaseOwner: claim!.lease_owner, outcome: 'accepted' },
        world.host.id,
      );
      expect(await agentOf(world)).toMatchObject({ close: { state: 'acknowledged' } });
    });

    it('reports undeliverable once the note is canceled', async () => {
      const world = await makeWorld();
      await requestClose(world);
      await world.service.heartbeatAgent(world.sessionId, world.bridgeToken, { relayAction: 'close' }, world.host.id);
      expect(await agentOf(world)).toMatchObject({ close: { state: 'undeliverable' } });
    });

    it('is idempotent for a repeated client_message_id', async () => {
      const world = await makeWorld();
      const clientMessageId = randomUUID();
      const first = await world.service.requestClose(world.identity, {
        sessionId: world.sessionId,
        clientMessageId,
        note: 'same note',
      });
      const second = await world.service.requestClose(world.identity, {
        sessionId: world.sessionId,
        clientMessageId,
        note: 'same note',
      });
      expect(second['message_id']).toBe(first['message_id']);

      const rows = await db
        .select()
        .from(agentMessages)
        .where(and(eq(agentMessages.sessionId, world.sessionId), eq(agentMessages.kind, 'close')));
      expect(rows).toHaveLength(1);
      const events = await db
        .select()
        .from(agentEvents)
        .where(and(eq(agentEvents.sessionId, world.sessionId), eq(agentEvents.eventType, 'close_requested')));
      expect(events).toHaveLength(1);
    });

    it('rejects a reused client_message_id carrying a different note', async () => {
      const world = await makeWorld();
      const clientMessageId = randomUUID();
      await world.service.requestClose(world.identity, { sessionId: world.sessionId, clientMessageId, note: 'one' });
      await expect(
        world.service.requestClose(world.identity, { sessionId: world.sessionId, clientMessageId, note: 'two' }),
      ).rejects.toMatchObject({ code: 'client_message_id_conflict' });
    });

    it('refuses a cooperative close when no relay is open', async () => {
      const world = await makeWorld();
      await world.service.heartbeatAgent(world.sessionId, world.bridgeToken, { relayAction: 'close' }, world.host.id);
      await expect(requestClose(world)).rejects.toMatchObject({ code: 'agent_relay_unavailable' });
    });

    it('raises attention when the close note dies undelivered', async () => {
      const world = await makeWorld();
      await requestClose(world);
      await db
        .update(agentMessages)
        .set({ attempts: 12 })
        .where(and(eq(agentMessages.sessionId, world.sessionId), eq(agentMessages.kind, 'close')));

      await world.service.claimMessage(world.sessionId, world.bridgeToken, randomUUID(), world.host.id);

      expect(await closeRow(world.sessionId)).toMatchObject({ status: 'dead' });
      expect(await agentOf(world)).toMatchObject({
        attention: { summary: expect.stringContaining('Force end') },
      });
    });
  });

  describe('force close', () => {
    const forceClose = async (world: World, note?: string, clientMessageId = randomUUID()) =>
      await world.service.forceClose({ kind: 'portal', identity: world.identity }, { sessionId: world.sessionId, clientMessageId, note });

    // The whole point of the fallback: it must not depend on the agent.
    it('ends a session whose heartbeat is stale and relay is shut', async () => {
      const world = await makeWorld();
      await world.service.heartbeatAgent(world.sessionId, world.bridgeToken, { relayAction: 'close' }, world.host.id);
      await backdateHeartbeat(world.sessionId, 300);

      const result = await forceClose(world, 'ending this');
      expect(result).toMatchObject({ forced: true, already_ended: false, status: 'completed' });
      expect(await agentOf(world)).toMatchObject({ presence: 'ended', read_only: true });

      const events = await db
        .select()
        .from(agentEvents)
        .where(and(eq(agentEvents.sessionId, world.sessionId), eq(agentEvents.eventType, 'close_requested')));
      expect(events).toHaveLength(1);
    });

    it('cancels pending work on the way out', async () => {
      const world = await makeWorld();
      await world.service.enqueueMessage(world.identity, {
        sessionId: world.sessionId,
        clientMessageId: randomUUID(),
        content: 'still queued',
      });
      await forceClose(world);
      const rows = await db.select().from(agentMessages).where(eq(agentMessages.sessionId, world.sessionId));
      expect(rows.every((row) => row.status === 'canceled')).toBe(true);
    });

    // LIVE_SESSION_STATES excludes completed/failed, so this pins that the
    // endedAt short-circuit runs before any liveness assertion.
    it('is a no-op on a session that already failed', async () => {
      const world = await makeWorld();
      await world.service.finishAgent(world.sessionId, world.bridgeToken, { status: 'failed' }, world.host.id);
      const before = (await db.select().from(agentSessions).where(eq(agentSessions.id, world.sessionId)))[0]!;

      const result = await forceClose(world);
      expect(result).toMatchObject({ forced: false, already_ended: true, status: 'failed' });

      const after = (await db.select().from(agentSessions).where(eq(agentSessions.id, world.sessionId)))[0]!;
      expect(after.endedAt).toBe(before.endedAt);
      expect(after.status).toBe('failed');
    });

    it('collapses a double-tapped force onto one event', async () => {
      const world = await makeWorld();
      const clientMessageId = randomUUID();
      await forceClose(world, undefined, clientMessageId);
      const second = await forceClose(world, undefined, clientMessageId);
      expect(second).toMatchObject({ already_ended: true });

      const events = await db
        .select()
        .from(agentEvents)
        .where(and(eq(agentEvents.sessionId, world.sessionId), eq(agentEvents.eventType, 'close_requested')));
      expect(events).toHaveLength(1);
    });
  });

  it('reopens a live prompt when the answering user is disabled', async () => {
    const world = await makeWorld();
    const { promptId, messageId } = await openPromptAndAnswer(world);

    await world.service.setUserEnabled(world.userId, false);

    const messages = await db.select().from(agentMessages).where(eq(agentMessages.messageId, messageId));
    const prompts = await db.select().from(agentPrompts).where(eq(agentPrompts.id, promptId));
    expect(messages[0]).toMatchObject({ status: 'canceled' });
    expect(prompts[0]).toMatchObject({
      status: 'open',
      answeredByUserId: null,
      answerMessageId: null,
      answeredAt: null,
      version: 3,
    });
  });

  it('expires a queued answer when the master switch is disabled', async () => {
    const world = await makeWorld();
    const { promptId, messageId } = await openPromptAndAnswer(world);

    await world.service.setEnabled(false);

    const messages = await db.select().from(agentMessages).where(eq(agentMessages.messageId, messageId));
    const prompts = await db.select().from(agentPrompts).where(eq(agentPrompts.id, promptId));
    expect(messages[0]).toMatchObject({ status: 'canceled' });
    expect(prompts[0]).toMatchObject({
      status: 'expired',
      answeredByUserId: null,
      answerMessageId: null,
      answeredAt: null,
      version: 3,
    });
  });

  it('expires a queued answer atomically with terminal finalization', async () => {
    const world = await makeWorld();
    const { promptId, messageId } = await openPromptAndAnswer(world);

    await world.service.finishAgent(
      world.sessionId,
      world.bridgeToken,
      { status: 'completed', summary: 'done' },
      world.host.id,
    );

    const messages = await db.select().from(agentMessages).where(eq(agentMessages.messageId, messageId));
    const prompts = await db.select().from(agentPrompts).where(eq(agentPrompts.id, promptId));
    const sessions = await db.select().from(agentSessions).where(eq(agentSessions.id, world.sessionId));
    expect(messages[0]).toMatchObject({ status: 'canceled' });
    expect(prompts[0]).toMatchObject({ status: 'expired', answerMessageId: null, version: 3 });
    expect(sessions[0]).toMatchObject({ status: 'completed', relayEnabled: 0, relayHeartbeatAt: null });
    expect(sessions[0]!.endedAt).not.toBeNull();
  });

  it('collapses an exact event retry onto one row without a second side effect', async () => {
    const world = await makeWorld('recipient-a');
    const eventInput = {
      clientEventId: `attention:${randomUUID()}`,
      type: 'attention' as const,
      source: 'bridge' as const,
      payload: { summary: 'Check the agent' },
    };
    const first = await world.service.addAgentEvent(
      world.sessionId,
      world.bridgeToken,
      eventInput,
      world.host.id,
    );

    const retried = await world.service.addAgentEvent(
      world.sessionId,
      world.bridgeToken,
      eventInput,
      world.host.id,
    );

    expect(retried['cursor']).toBe(first['cursor']);
    const events = await db.select().from(agentEvents).where(and(
      eq(agentEvents.sessionId, world.sessionId),
      eq(agentEvents.clientEventId, eventInput.clientEventId),
    ));
    expect(events).toHaveLength(1);
  });

  it('redelivers an active lease to the same claim id without incrementing attempts', async () => {
    const world = await makeWorld();
    const queued = await world.service.enqueueMessage(world.identity, {
      sessionId: world.sessionId,
      clientMessageId: randomUUID(),
      content: 'Continue safely',
    });
    const claimA = randomUUID();
    const claimB = randomUUID();

    const first = await world.service.claimMessage(world.sessionId, world.bridgeToken, claimA, world.host.id);
    const repeated = await world.service.claimMessage(world.sessionId, world.bridgeToken, claimA, world.host.id);
    const blocked = await world.service.claimMessage(world.sessionId, world.bridgeToken, claimB, world.host.id);
    expect(repeated).toEqual(first);
    expect(first).toMatchObject({ attempts: 1, lease_owner: claimA });
    expect(blocked).toBeNull();

    await db.update(agentMessages).set({ leaseUntil: '1970-01-01T00:00:00.000Z' }).where(
      eq(agentMessages.messageId, String(queued['message_id'])),
    );
    const reclaimed = await world.service.claimMessage(world.sessionId, world.bridgeToken, claimB, world.host.id);
    expect(reclaimed).toMatchObject({
      message_id: queued['message_id'],
      attempts: 2,
      lease_owner: claimB,
    });
    await expect(world.service.acknowledgeMessage(
      world.sessionId,
      world.bridgeToken,
      {
        messageId: String(queued['message_id']),
        leaseOwner: claimA,
        outcome: 'accepted',
      },
      world.host.id,
    )).rejects.toMatchObject({ code: 'agent_message_lease_lost' });
  });

  it('rolls back message acceptance when its visible event cannot commit', async () => {
    const world = await makeWorld();
    const queued = await world.service.enqueueMessage(world.identity, {
      sessionId: world.sessionId,
      clientMessageId: randomUUID(),
      content: 'Atomic acknowledgement',
    });
    const claim = await world.service.claimMessage(
      world.sessionId,
      world.bridgeToken,
      randomUUID(),
      world.host.id,
    );
    expect(claim).not.toBeNull();
    const acceptedEventId = `server:accepted:${String(queued['message_id'])}`;
    await db.insert(agentEvents).values({
      sessionId: world.sessionId,
      clientEventId: acceptedEventId,
      eventType: 'message_accepted',
      source: 'bridge',
      payloadEnc: 'intentional-unique-key-blocker',
      createdAt: new Date().toISOString(),
    });

    await expect(world.service.acknowledgeMessage(
      world.sessionId,
      world.bridgeToken,
      {
        messageId: String(queued['message_id']),
        leaseOwner: claim!.lease_owner,
        outcome: 'accepted',
        upstreamId: 'test-upstream',
      },
      world.host.id,
    )).rejects.toThrow();

    let messages = await db.select().from(agentMessages).where(eq(agentMessages.messageId, String(queued['message_id'])));
    let acceptedEvents = await db.select().from(agentEvents).where(and(
      eq(agentEvents.sessionId, world.sessionId),
      eq(agentEvents.clientEventId, acceptedEventId),
    ));
    expect(messages[0]).toMatchObject({
      status: 'leased',
      leaseOwner: claim!.lease_owner,
      acceptedAt: null,
    });
    expect(acceptedEvents).toHaveLength(1);

    await db.delete(agentEvents).where(and(
      eq(agentEvents.sessionId, world.sessionId),
      eq(agentEvents.clientEventId, acceptedEventId),
    ));

    const accepted = await world.service.acknowledgeMessage(
      world.sessionId,
      world.bridgeToken,
      {
        messageId: String(queued['message_id']),
        leaseOwner: claim!.lease_owner,
        outcome: 'accepted',
        upstreamId: 'test-upstream',
      },
      world.host.id,
    );
    const acceptedAgain = await world.service.acknowledgeMessage(
      world.sessionId,
      world.bridgeToken,
      {
        messageId: String(queued['message_id']),
        leaseOwner: claim!.lease_owner,
        outcome: 'accepted',
        upstreamId: 'test-upstream',
      },
      world.host.id,
    );
    messages = await db.select().from(agentMessages).where(eq(agentMessages.messageId, String(queued['message_id'])));
    acceptedEvents = await db.select().from(agentEvents).where(and(
      eq(agentEvents.sessionId, world.sessionId),
      eq(agentEvents.clientEventId, acceptedEventId),
    ));
    expect(accepted).toMatchObject({ status: 'accepted' });
    expect(acceptedAgain).toMatchObject({ status: 'accepted' });
    expect(messages[0]).toMatchObject({ status: 'accepted', upstreamId: 'test-upstream' });
    expect(acceptedEvents).toHaveLength(1);
  });

  /**
   * The link is now the only way in, so it has to survive the round trip through
   * the encrypted column: what an admin reads back later must be byte-identical
   * to what creation handed out, and must still exchange for a session.
   */
  it('reads the permanent link back from storage and it still logs in', async () => {
    const service = new AgentPortalService(db, env, testKeyring());
    await service.setEnabled(true);
    const created = await service.createUser({ displayName: `${PREFIX}-permanent-link` });

    const revealed = await service.revealUserLink(created.user.id);
    expect(revealed.magic_url).toBe(created.magic_url);

    const url = new URL(revealed.magic_url);
    expect(url.pathname).toBe(`/go/u/${created.user.public_id}`);
    // The token rides in the fragment: a bookmarked URL must never put bearer
    // material anywhere a proxy log or Referer header can reach.
    expect(url.search).toBe('');
    const login = await service.exchangeMagicLink({
      publicId: created.user.public_id,
      token: decodeURIComponent(url.hash.slice(3)),
    });
    expect(login.identity.user.id).toBe(created.user.id);

    // Rotation invalidates the old bookmark and hands out a distinct one.
    const rotated = await service.rotateUser(created.user.id);
    expect(rotated.magic_url).not.toBe(created.magic_url);
    expect(rotated.revoked_sessions).toBe(1);
    await expect(
      service.exchangeMagicLink({
        publicId: created.user.public_id,
        token: decodeURIComponent(url.hash.slice(3)),
      }),
    ).rejects.toThrow();
    expect((await service.revealUserLink(created.user.id)).magic_url).toBe(rotated.magic_url);
  });
});
