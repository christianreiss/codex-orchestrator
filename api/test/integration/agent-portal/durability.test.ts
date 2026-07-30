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
