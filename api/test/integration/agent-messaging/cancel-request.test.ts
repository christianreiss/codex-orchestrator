import { randomBytes, randomUUID } from 'node:crypto';
import mysql from 'mysql2/promise';
import { drizzle } from 'drizzle-orm/mysql2';
import { eq, inArray, or } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../../../src/db/schema.js';
import { AgentMessagingService, AGENT_MESSAGING_ENABLED_KEY } from '../../../src/services/agent-messaging.js';
import { AgentReceiverService } from '../../../src/services/agent-receiver.js';
import { invalidateFleetEngineState } from '../../../src/services/engine-switch.js';
import { ENGINES, type Engine } from '../../../src/util/engine.js';
import Fastify from 'fastify';
import { envelopePlugin } from '../../../src/http/plugins/envelope.js';
import { registerAgentMessagingRoutes } from '../../../src/routes/agent-messaging/index.js';
import type { RouteContext } from '../../../src/routes/index.js';
import { readDbConfig } from '../../helpers/test-db.js';
import { loadTestEnv, testKeyring } from '../../helpers/test-keyring.js';

const config = readDbConfig();
const protocols = { codex: 'codex-queue-v1', claude: 'claude-channel-v1', grok: 'grok-acp-v1' } as const;

describe.skipIf(!config)('requester cancels its own queued request on real MySQL', { timeout: 30_000 }, () => {
  const pool = mysql.createPool({ ...config, connectionLimit: 4 });
  const db = drizzle(pool, { schema, mode: 'default' });
  const env = { ...loadTestEnv(), CXX_QUEUE_DELIVERY_V1_ENABLED: true, CXX_QUEUE_DELIVERY_V1_HOST_IDS: '' };
  const service = new AgentMessagingService(db, env, testKeyring());
  const receiver = new AgentReceiverService(db, env, testKeyring());
  let host: typeof schema.hosts.$inferSelect;
  const prior = new Map<string, string | undefined>();
  const flagNames = [AGENT_MESSAGING_ENABLED_KEY, ...ENGINES.map((e) => `${e}_engine_disabled`)];

  async function flag(name: string, value: string) {
    await db
      .insert(schema.versions)
      .values({ name, version: value, updatedAt: new Date().toISOString() })
      .onDuplicateKeyUpdate({ set: { version: value } });
    invalidateFleetEngineState(db);
  }
  beforeAll(async () => {
    for (const name of flagNames)
      prior.set(
        name,
        (await db.select().from(schema.versions).where(eq(schema.versions.name, name)))[0]?.version ??
          undefined,
      );
    const fqdn = `cancel-request-${randomUUID()}.test`,
      now = new Date().toISOString();
    await db.insert(schema.hosts).values({
      fqdn,
      apiKey: randomBytes(32).toString('hex'),
      status: 'active',
      secure: 1,
      engines: ENGINES.join(','),
      createdAt: now,
      updatedAt: now,
    });
    host = (await db.select().from(schema.hosts).where(eq(schema.hosts.fqdn, fqdn)))[0]!;
  });
  beforeEach(async () => {
    env.CXX_QUEUE_DELIVERY_V1_ENABLED = true;
    env.CXX_QUEUE_DELIVERY_V1_HOST_IDS = '';
    await flag(AGENT_MESSAGING_ENABLED_KEY, '1');
    for (const engine of ENGINES) await flag(`${engine}_engine_disabled`, '0');
    await db.update(schema.hosts).set({ status: 'active' }).where(eq(schema.hosts.id, host.id));
  });
  afterAll(async () => {
    if (host) {
      const addresses = await db
        .select()
        .from(schema.agentBusAddresses)
        .where(eq(schema.agentBusAddresses.hostId, host.id));
      const ids = addresses.map((a) => a.id);
      if (ids.length) {
        await db
          .delete(schema.agentBusMessages)
          .where(
            or(
              inArray(schema.agentBusMessages.targetAddressId, ids),
              inArray(schema.agentBusMessages.senderAddressId, ids),
            ),
          );
        await db
          .delete(schema.agentBusConversations)
          .where(
            or(
              inArray(schema.agentBusConversations.addressAId, ids),
              inArray(schema.agentBusConversations.addressBId, ids),
            ),
          );
      }
      await db.delete(schema.agentSessions).where(eq(schema.agentSessions.hostId, host.id));
      await db.delete(schema.agentBusAddresses).where(eq(schema.agentBusAddresses.hostId, host.id));
      await db.delete(schema.logs).where(eq(schema.logs.hostId, host.id));
      await db.delete(schema.hosts).where(eq(schema.hosts.id, host.id));
    }
    for (const [name, value] of prior) {
      if (value === undefined) await db.delete(schema.versions).where(eq(schema.versions.name, name));
      else await flag(name, value);
    }
    await pool.end();
  });

  async function peer(engine: Engine = 'codex', capable = true) {
    const id = randomUUID(),
      token = randomBytes(32).toString('base64url'),
      generation = randomUUID(),
      native = randomUUID();
    const result = await service.registerSession(host, {
      engine,
      username: randomUUID(),
      cwd: '/tmp/cancel-request',
      invocationKind: 'interactive',
      sessionId: id,
      bridgeToken: token,
      upstreamSessionId: native,
      adapterCapabilities: { execution_contract_version: 2 },
    });
    const address = result.address as { id: string; address: string };
    await receiver.register(id, token, {
      generation,
      protocol: protocols[engine],
      native_session_id: native,
      capabilities: capable ? { queue_delivery_v1: true } : undefined,
    });
    return { id, token, generation, address: address.address, addressId: address.id };
  }
  type Peer = Awaited<ReturnType<typeof peer>>;
  async function send(
    source: Peer,
    target: Peer,
    content: string,
    extra: Partial<Parameters<typeof service.sendMessage>[2]> = {},
  ) {
    return (await service.sendMessage(source.id, source.token, {
      to: target.address,
      content,
      clientMessageId: randomUUID(),
      ...extra,
    })) as { message: { id: string } };
  }
  async function claim(p: Peer, id = randomUUID(), info = false) {
    return service.claimForSession(p.id, p.token, id, p.generation, info);
  }
  async function ack(
    p: Peer,
    d: NonNullable<Awaited<ReturnType<typeof claim>>>,
    outcome: 'accepted' | 'completed',
  ) {
    return service.acknowledgeSessionDelivery(p.id, p.token, d.message_id, { claimId: d.claim_id, outcome });
  }
  for (const engine of ENGINES) {
    it(`${engine}: agent_request conversation id cancels the queued request`, async () => {
      const source = await peer(engine),
        target = await peer(engine);
      const sent = (await service.sendMessage(source.id, source.token, {
        to: target.address,
        content: 'withdraw me',
        clientMessageId: randomUUID(),
        kind: 'request',
      })) as { message: { id: string; conversation_id: string; sequence: number } };
      const waited = (await service.waitForMessages(source.id, source.token, sent.message.conversation_id, sent.message.sequence)) as { conversation: { id: string } };
      expect(waited.conversation.id).toBe(sent.message.conversation_id);
      const got = (await service.getMessage(source.id, source.token, sent.message.id)) as { message: { status: string } };
      expect(got.message.status).toBe('queued');
      const result = (await service.cancelConversation(source.id, source.token, waited.conversation.id, 'test')) as { canceled_messages: number };
      expect(result.canceled_messages).toBe(1);
    });
  }
  it('withdraws a queued request over the session routes with the ids agent_request returns', async () => {
    const source = await peer('codex'),
      target = await peer('codex');
    const app = Fastify({ logger: false });
    await app.register(envelopePlugin);
    app.decorate('requireAdmin', async () => {});
    app.decorate('resolveAdmin', async () => null);
    await registerAgentMessagingRoutes(app, { db, env, keyring: testKeyring() } as unknown as RouteContext);
    const post = async (op: string, payload: Record<string, unknown>) => {
      const r = await app.inject({ method: 'POST', url: `/host/agent-sessions/${source.id}/agent-messaging/${op}`, headers: { 'x-agent-bridge-token': source.token }, payload });
      return { status: r.statusCode, body: JSON.parse(r.payload) };
    };
    try {
      const sent = await post('send', { to: target.address, content: 'withdraw me', client_message_id: randomUUID(), kind: 'request' });
      expect(sent.status).toBe(200);
      const message = sent.body.message;
      const waited = await post('wait', { conversation_id: message.conversation_id, after: message.sequence, seconds: 0 });
      expect(waited.body.conversation.id).toBe(message.conversation_id);
      // A message id is not a conversation id; this is the only shape that
      // reproduces the reported not-found while the request stays queued.
      const wrongKind = await post('cancel', { conversation_id: message.id, reason: null });
      expect(wrongKind.status).toBe(404);
      expect(wrongKind.body.code).toBe('agent_messaging_conversation_not_found');
      expect((await post('message', { message_id: message.id })).body.message.status).toBe('queued');
      const canceled = await post('cancel', { conversation_id: waited.body.conversation.id, reason: null });
      expect(canceled.status).toBe(200);
      expect(canceled.body.canceled_messages).toBe(1);
      const got = await post('message', { message_id: message.id });
      expect(got.body.message.status).toBe('canceled');
    } finally {
      await app.close();
    }
  });
});
