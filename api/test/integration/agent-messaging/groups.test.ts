import { randomBytes, randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  agentBusAddresses,
  agentBusSubscriptions,
  agentBusMessages,
  agentBusPublications,
  hosts,
  versions,
} from '../../../src/db/schema.js';
import type { Env } from '../../../src/env.js';
import { AgentMessagingService } from '../../../src/services/agent-messaging.js';
import {
  MAX_PUBLICATIONS_PER_MINUTE,
  MAX_PUBLICATION_CONTENT_BYTES,
  MAX_TOPIC_SUBSCRIBERS,
  MAX_AGENT_SUBSCRIPTIONS,
  SERVER_ADDRESS_ID,
  SERVER_PUBLICATION_TOPIC,
} from '../../../src/services/agent-messaging/groups.js';
import { invalidateFleetEngineState } from '../../../src/services/engine-switch.js';
import { decrypt } from '../../../src/security/secret-box.js';
import type { Engine } from '../../../src/util/engine.js';
import { getTestDb, type TestDb } from '../../helpers/test-db.js';
import { loadTestEnv, testKeyring } from '../../helpers/test-keyring.js';

const handle = await getTestDb();
const PREFIX = 'ztest-publications';
const ENGINES: Engine[] = ['codex', 'claude', 'grok'];
interface Identity {
  sessionId: string;
  token: string;
  addressId: string;
  address: string;
}

describe.skipIf(!handle)('persistent opt-in publications against MySQL', { timeout: 120_000 }, () => {
  let db: TestDb;
  let service: AgentMessagingService;
  let host: typeof hosts.$inferSelect;
  const keyring = testKeyring();
  const cleanup = async () => {
    if (!host) return;
    const scoped = `SELECT id FROM agent_bus_addresses WHERE host_id=${host.id}`;
    await db.execute(
      sql.raw(
        `DELETE FROM agent_bus_subscriptions WHERE subscriber_address_id IN (${scoped}) OR topic LIKE 'group:${PREFIX}%'`,
      ),
    );
    await db.execute(
      sql.raw(
        `DELETE FROM agent_bus_publications WHERE sender_address_id IN (${scoped}) OR topic LIKE 'group:${PREFIX}%' OR sender_address_id='${SERVER_ADDRESS_ID}'`,
      ),
    );
    await db.execute(
      sql.raw(
        `DELETE FROM agent_bus_messages WHERE sender_address_id IN (${scoped}) OR target_address_id IN (${scoped})`,
      ),
    );
    await db.execute(
      sql.raw(
        `DELETE FROM agent_bus_conversations WHERE address_a_id IN (${scoped}) OR address_b_id IN (${scoped})`,
      ),
    );
    await db.execute(sql.raw(`DELETE FROM agent_bus_groups WHERE slug LIKE '${PREFIX}%'`));
    await db.execute(sql.raw(`DELETE FROM agent_sessions WHERE host_id=${host.id}`));
    await db.execute(sql.raw(`DELETE FROM agent_bus_addresses WHERE host_id=${host.id}`));
    await db.execute(sql.raw(`DELETE FROM logs WHERE host_id=${host.id}`));
    for (const engine of ENGINES)
      await db.delete(versions).where(eq(versions.name, `${engine}_engine_disabled`));
    invalidateFleetEngineState(db);
  };
  beforeAll(async () => {
    db = handle!.db;
    const now = new Date().toISOString();
    await db
      .insert(hosts)
      .values({
        fqdn: `${PREFIX}.example`,
        apiKey: 'f'.repeat(64),
        status: 'active',
        secure: 1,
        engines: 'codex,claude,grok',
        createdAt: now,
        updatedAt: now,
      })
      .onDuplicateKeyUpdate({ set: { status: 'active' } });
    host = (
      await db
        .select()
        .from(hosts)
        .where(eq(hosts.fqdn, `${PREFIX}.example`))
    )[0]!;
    service = new AgentMessagingService(
      db,
      { ...loadTestEnv(), AGENT_PORTAL_BRIDGE_TTL_SECONDS: 900 } as Env,
      keyring,
    );
  });
  beforeEach(async () => {
    await cleanup();
    await db
      .insert(versions)
      .values({ name: 'agent_messaging_enabled', version: '1', updatedAt: new Date().toISOString() })
      .onDuplicateKeyUpdate({ set: { version: '1' } });
  });
  afterEach(cleanup);
  afterAll(async () => {
    await cleanup();
    if (host) await db.delete(hosts).where(eq(hosts.id, host.id));
    await db.update(versions).set({ version: '0' }).where(eq(versions.name, 'agent_messaging_enabled'));
    await handle?.pool.end();
  });
  async function register(engine: Engine, label: string): Promise<Identity> {
    const sessionId = randomUUID();
    const token = randomBytes(32).toString('base64url');
    const result = await service.registerSession(host, {
      engine,
      username: `${PREFIX}-${label}`,
      cwd: `/tmp/${PREFIX}/${label}`,
      invocationKind: 'interactive',
      sessionId,
      bridgeToken: token,
      adapterProtocol: 'test-live-v1',
      adapterCapabilities: { test: true, execution_contract_version: 2 },
    });
    const address = result.address as { id: string; address: string };
    return { sessionId, token, addressId: address.id, address: address.address };
  }
  async function group(agents: Identity[], slug = `${PREFIX}-main`) {
    await service.createAdminGroup({ slug, title: 'Scoped audit', description: 'Opt-in only' });
    for (const agent of agents) await service.subscribe(agent.sessionId, agent.token, `group:${slug}`);
    return `group:${slug}`;
  }
  const message = async (id: string) =>
    (await db.select().from(agentBusMessages).where(eq(agentBusMessages.id, id)))[0]!;

  it('includes Server publications in the metadata-only mailbox ring', async () => {
    const target = await register('grok', 'server-ring');
    await service.subscribe(target.sessionId, target.token, SERVER_PUBLICATION_TOPIC);
    const sent = await service.publishAdmin({ topic: SERVER_PUBLICATION_TOPIC, content: 'Server notice', clientMessageId: randomUUID() });
    const mailbox = await service.peekMailbox(target.sessionId, target.token);
    expect(mailbox.pending).toEqual([expect.objectContaining({ message_id: sent.deliveries[0]!.message_id, kind: 'publication', from: expect.objectContaining({ engine: 'server', fqdn: null }) })]);
    expect(JSON.stringify(mailbox)).not.toContain('Server notice');
  });

  it('routes each of Codex, Claude and Grok to the two other group members, then Server to all three', async () => {
    const agents = await Promise.all(ENGINES.map((engine) => register(engine, engine)));
    for (const agent of agents)
      await service.heartbeatSession(agent.sessionId, agent.token, { receiveCapable: true });
    const outsider = await register('codex', 'outsider');
    const topic = await group(agents);
    for (let source = 0; source < agents.length; source++) {
      const sender = agents[source]!;
      const result = await service.publish(sender.sessionId, sender.token, {
        topic,
        content: `from ${ENGINES[source]}`,
        clientMessageId: randomUUID(),
      });
      expect(result.recipient_count).toBe(2);
      expect(result.deliveries.map((r) => r.address_id).sort()).toEqual(
        agents
          .filter((a) => a !== sender)
          .map((a) => a.addressId)
          .sort(),
      );
      for (const receipt of result.deliveries) {
        const row = await message(receipt.message_id);
        expect(row).toMatchObject({ sourceEngine: ENGINES[source], kind: 'publication', status: 'queued' });
        expect(decrypt(row.contentEnc, keyring)).toContain(`PUBLICATION/1 topic=${topic}`);
        const receiver = agents.find((agent) => agent.addressId === receipt.address_id)!;
        const claimId = randomUUID();
        const delivery = await service.claimForSession(receiver.sessionId, receiver.token, claimId);
        expect(delivery).toMatchObject({
          message_id: receipt.message_id,
          sender: { engine: ENGINES[source] },
        });
        await service.acknowledgeSessionDelivery(receiver.sessionId, receiver.token, receipt.message_id, {
          claimId,
          outcome: 'completed',
        });
      }
    }
    const published = await service.publishAdmin({
      topic,
      content: 'from Server',
      clientMessageId: randomUUID(),
    });
    expect(published.recipient_count).toBe(3);
    expect(published.deliveries.some((r) => r.address_id === outsider.addressId)).toBe(false);
    for (const receipt of published.deliveries)
      expect(await message(receipt.message_id)).toMatchObject({
        sourceEngine: 'server',
        senderAddressId: SERVER_ADDRESS_ID,
      });
    const targets = await service.listAddresses(agents[0]!.sessionId, agents[0]!.token, {
      includeOffline: true,
    });
    expect(JSON.stringify(targets)).not.toContain(SERVER_ADDRESS_ID);
    const receiver = agents[0]!;
    await expect(
      service.replyMessage(
        receiver.sessionId,
        receiver.token,
        published.deliveries.find((r) => r.address_id === receiver.addressId)!.message_id,
        { content: 'reply', clientMessageId: randomUUID() },
      ),
    ).rejects.toMatchObject({ code: 'agent_messaging_server_publication_reply' });
  });

  it('never copies private messages or replies into an individual agent feed', async () => {
    const [publisher, follower, privatePeer] = await Promise.all([
      register('grok', 'publisher'),
      register('claude', 'follower'),
      register('codex', 'private'),
    ]);
    expect(await service.subscribe(follower!.sessionId, follower!.token, publisher!.address)).toMatchObject({
      changed: true,
    });
    expect(await service.subscribe(follower!.sessionId, follower!.token, publisher!.address)).toMatchObject({
      changed: false,
    });
    const direct = await service.sendMessage(publisher!.sessionId, publisher!.token, {
      to: privatePeer!.address,
      content: 'private secret',
      clientMessageId: randomUUID(),
    });
    await service.replyMessage(
      privatePeer!.sessionId,
      privatePeer!.token,
      String((direct.message as { id: string }).id),
      { content: 'private reply', clientMessageId: randomUUID() },
    );
    expect(
      await db
        .select()
        .from(agentBusMessages)
        .where(eq(agentBusMessages.targetAddressId, follower!.addressId)),
    ).toHaveLength(0);
    const published = await service.publish(publisher!.sessionId, publisher!.token, {
      topic: publisher!.address,
      content: 'explicit public news',
      clientMessageId: randomUUID(),
    });
    expect(published.deliveries).toHaveLength(1);
    expect(published.deliveries[0]?.address_id).toBe(follower!.addressId);
    expect(decrypt((await message(published.deliveries[0]!.message_id)).contentEnc, keyring)).not.toContain(
      'private secret',
    );
    await expect(
      service.publish(follower!.sessionId, follower!.token, {
        topic: publisher!.address,
        content: 'impersonation',
        clientMessageId: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: 'agent_messaging_publication_forbidden' });
    await expect(
      service.publishAdmin({
        topic: publisher!.address,
        content: 'admin impersonation',
        clientMessageId: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: 'agent_messaging_publication_forbidden' });
  });

  it('keeps receipt snapshots stable across concurrent duplicate retries and membership changes', async () => {
    const sender = await register('codex', 'sender');
    const subscriber = await register('grok', 'subscriber');
    const topic = await group([sender, subscriber]);
    const input = { topic, content: 'exactly one durable fanout', clientMessageId: randomUUID() };
    const results = await Promise.all([
      service.publish(sender.sessionId, sender.token, input),
      service.publish(sender.sessionId, sender.token, input),
    ]);
    expect(results.filter((r) => r.created)).toHaveLength(1);
    expect(results[0]!.publication_id).toBe(results[1]!.publication_id);
    expect(results[0]!.deliveries).toEqual(results[1]!.deliveries);
    expect(await service.unsubscribe(subscriber.sessionId, subscriber.token, topic)).toMatchObject({
      changed: true,
    });
    expect(await service.unsubscribe(subscriber.sessionId, subscriber.token, topic)).toMatchObject({
      changed: false,
    });
    expect((await service.publish(sender.sessionId, sender.token, input)).deliveries).toEqual(
      results[0]!.deliveries,
    );
    expect(
      (await service.publish(sender.sessionId, sender.token, { ...input, clientMessageId: randomUUID() }))
        .recipient_count,
    ).toBe(0);
    await expect(
      service.publish(sender.sessionId, sender.token, { ...input, content: 'changed' }),
    ).rejects.toMatchObject({ code: 'agent_messaging_publication_conflict' });
    expect(
      await db
        .select()
        .from(agentBusMessages)
        .where(eq(agentBusMessages.targetAddressId, subscriber.addressId)),
    ).toHaveLength(1);
  });

  it('requires opt-in group membership and restricts subscriptions to the authenticated identity', async () => {
    const creator = await register('codex', 'creator');
    const outsider = await register('claude', 'outsider');
    const slug = `${PREFIX}-membership`;
    const created = await service.createGroup(creator.sessionId, creator.token, {
      slug,
      title: 'Member only',
    });
    expect(created.created).toBe(true);
    expect((await service.groupMembers(creator.sessionId, creator.token, slug)).members).toHaveLength(0);
    await expect(
      service.publish(creator.sessionId, creator.token, {
        topic: `group:${slug}`,
        content: 'not joined',
        clientMessageId: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: 'agent_messaging_group_membership_required' });
    await expect(service.subscribe(creator.sessionId, outsider.token, `group:${slug}`)).rejects.toMatchObject(
      { code: 'agent_bridge_unauthorized' },
    );
    await service.subscribe(creator.sessionId, creator.token, `group:${slug}`);
    expect((await service.subscriptions(outsider.sessionId, outsider.token)).subscriptions).toHaveLength(0);
    await expect(
      service.subscribe(outsider.sessionId, outsider.token, 'group:missing'),
    ).rejects.toMatchObject({ code: 'agent_messaging_group_not_found' });
    await expect(service.subscribe(outsider.sessionId, outsider.token, 'fleet:*')).rejects.toMatchObject({
      status: 422,
    });
    await expect(service.subscribe(creator.sessionId, creator.token, creator.address)).rejects.toMatchObject({
      status: 422,
    });
  });

  it('supports the Server feed and refuses native binding, direct sends and private content listing', async () => {
    const follower = await register('grok', 'server-follower');
    await service.subscribe(follower.sessionId, follower.token, SERVER_PUBLICATION_TOPIC);
    const published = await service.publishAdmin({
      topic: SERVER_PUBLICATION_TOPIC,
      content: 'server news',
      clientMessageId: randomUUID(),
    });
    expect(published.recipient_count).toBe(1);
    expect(await message(published.deliveries[0]!.message_id)).toMatchObject({
      sourceEngine: 'server',
      targetEngine: 'grok',
    });
    await expect(
      service.registerSession(host, {
        engine: 'grok',
        username: 'Server',
        cwd: '/',
        invocationKind: 'interactive',
        sessionId: randomUUID(),
        bridgeToken: randomBytes(32).toString('base64url'),
        requestedAddress: SERVER_PUBLICATION_TOPIC,
      }),
    ).rejects.toMatchObject({ code: 'agent_messaging_address_mismatch' });
    await expect(
      service.sendMessage(follower.sessionId, follower.token, {
        to: SERVER_PUBLICATION_TOPIC,
        content: 'not a portal reply',
        clientMessageId: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: 'agent_messaging_address_not_found' });
    expect(JSON.stringify(await service.listAdminSubscriptions())).not.toContain('server news');
    expect(JSON.stringify(await service.listAdminGroups())).not.toContain('server news');
    expect(JSON.stringify(await db.select().from(agentBusPublications))).not.toContain('server news');
  });

  it.each(ENGINES)(
    'claims and completes a durable Server publication on %s, with redrive preserving the origin',
    async (engine) => {
      const follower = await register(engine, `claim-${engine}`);
      await service.heartbeatSession(follower.sessionId, follower.token, { receiveCapable: true });
      await service.subscribe(follower.sessionId, follower.token, SERVER_PUBLICATION_TOPIC);
      const published = await service.publishAdmin({
        topic: SERVER_PUBLICATION_TOPIC,
        content: `Server receipt ${engine}`,
        clientMessageId: randomUUID(),
      });
      const claimId = randomUUID();
      const delivery = await service.claimForSession(follower.sessionId, follower.token, claimId);
      expect(delivery).toMatchObject({
        message_id: published.deliveries[0]!.message_id,
        kind: 'publication',
        sender: { engine: 'server' },
      });
      await service.acknowledgeSessionDelivery(follower.sessionId, follower.token, delivery!.message_id, {
        claimId,
        outcome: 'dead',
        errorCode: 'test_redrive',
      });
      const redriven = await service.redriveMessage(delivery!.message_id);
      expect(redriven).toMatchObject({ message: { sender: { engine: 'server' }, target: { engine } } });
      const secondClaim = randomUUID();
      const fresh = await service.claimForSession(follower.sessionId, follower.token, secondClaim);
      expect(fresh!.sender.engine).toBe('server');
      await service.acknowledgeSessionDelivery(follower.sessionId, follower.token, fresh!.message_id, {
        claimId: secondClaim,
        outcome: 'completed',
      });
      expect((await message(fresh!.message_id)).status).toBe('completed');
    },
  );

  it('retains queued delivery for offline members and skips suspended engines while enforcing the master switch', async () => {
    const sender = await register('codex', 'sender');
    const grok = await register('grok', 'suspended');
    const offline = await register('claude', 'offline');
    const topic = await group([sender, grok, offline]);
    await service.finishSession(offline.sessionId, offline.token, 'completed');
    await db
      .insert(versions)
      .values({ name: 'grok_engine_disabled', version: '1', updatedAt: new Date().toISOString() });
    invalidateFleetEngineState(db);
    const result = await service.publish(sender.sessionId, sender.token, {
      topic,
      content: 'durable',
      clientMessageId: randomUUID(),
    });
    expect(result.deliveries.map((r) => r.address_id)).toEqual([offline.addressId]);
    expect(result.skipped).toEqual([{ address_id: grok.addressId, reason: 'address_ineligible' }]);
    await expect(
      service.publish(grok.sessionId, grok.token, {
        topic: grok.address,
        content: 'suspended',
        clientMessageId: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: 'engine_disabled' });
    await service.unsubscribe(sender.sessionId, sender.token, grok.address);
    await db.update(versions).set({ version: '0' }).where(eq(versions.name, 'agent_messaging_enabled'));
    await expect(
      service.publishAdmin({ topic, content: 'disabled', clientMessageId: randomUUID() }),
    ).rejects.toMatchObject({ code: 'agent_messaging_disabled' });
  });

  it('rate limits zero-recipient publishes and rolls back queues if publication persistence fails', async () => {
    const sender = await register('claude', 'rate');
    for (let i = 0; i < MAX_PUBLICATIONS_PER_MINUTE; i++) {
      await service.publish(sender.sessionId, sender.token, {
        topic: sender.address,
        content: 'no listeners',
        clientMessageId: randomUUID(),
      });
    }
    await expect(
      service.publish(sender.sessionId, sender.token, {
        topic: sender.address,
        content: 'one too many',
        clientMessageId: randomUUID(),
      }),
    ).rejects.toMatchObject({ status: 429, code: 'agent_messaging_publication_rate_limited' });
    const publisher = await register('codex', 'atomic');
    const target = await register('grok', 'atomic-target');
    const topic = await group([publisher, target], `${PREFIX}-atomic`);
    // Reject the final metadata write after all queue rows were inserted.
    const realTransaction = db.transaction.bind(db);
    const fault = vi.spyOn(db, 'transaction').mockImplementation((action, config) =>
      realTransaction(async (tx) => {
        const insert = tx.insert.bind(tx);
        vi.spyOn(tx, 'insert').mockImplementation(((table) => {
          if ((table as unknown) === agentBusPublications) throw new Error('ztest publication rollback');
          return insert(table);
        }) as typeof tx.insert);
        return action(tx);
      }, config),
    );
    try {
      await expect(
        service.publish(publisher.sessionId, publisher.token, {
          topic,
          content: 'rollback',
          clientMessageId: randomUUID(),
        }),
      ).rejects.toThrow();
      expect(
        await db
          .select()
          .from(agentBusMessages)
          .where(eq(agentBusMessages.targetAddressId, target.addressId)),
      ).toHaveLength(0);
    } finally {
      fault.mockRestore();
    }
  });

  it('bounds UTF-8 publication bodies before queue writes while allowing the maximum with envelope headroom', async () => {
    const sender = await register('grok', 'bounds');
    const subscriber = await register('codex', 'bounds-target');
    await service.subscribe(subscriber.sessionId, subscriber.token, sender.address);
    const tooLarge = '😀'.repeat(MAX_PUBLICATION_CONTENT_BYTES / 4 + 1);
    await expect(
      service.publish(sender.sessionId, sender.token, {
        topic: sender.address,
        content: tooLarge,
        clientMessageId: randomUUID(),
      }),
    ).rejects.toMatchObject({ status: 422, param: 'content' });
    expect(
      await db
        .select()
        .from(agentBusMessages)
        .where(eq(agentBusMessages.targetAddressId, subscriber.addressId)),
    ).toHaveLength(0);
    const result = await service.publish(sender.sessionId, sender.token, {
      topic: sender.address,
      content: 'x'.repeat(MAX_PUBLICATION_CONTENT_BYTES),
      clientMessageId: randomUUID(),
    });
    expect(result.recipient_count).toBe(1);
    expect((await message(result.deliveries[0]!.message_id)).contentBytes).toBeLessThanOrEqual(32 * 1024);
  });

  it('bounds group fanout and per-agent follows while retaining idempotent subscribe retries at capacity', async () => {
    const slug = `${PREFIX}-capacity`;
    const topic = `group:${slug}`;
    await service.createAdminGroup({ slug, title: 'Capacity' });
    const agents: Identity[] = [];
    for (let i = 0; i < MAX_TOPIC_SUBSCRIBERS + 1; i++)
      agents.push(await register(ENGINES[i % ENGINES.length]!, `capacity-${i}`));
    for (const agent of agents.slice(0, MAX_TOPIC_SUBSCRIBERS))
      await service.subscribe(agent.sessionId, agent.token, topic);
    const first = agents[0]!;
    const overflow = agents[MAX_TOPIC_SUBSCRIBERS]!;
    expect(await service.subscribe(first.sessionId, first.token, topic)).toMatchObject({ changed: false });
    await expect(service.subscribe(overflow.sessionId, overflow.token, topic)).rejects.toMatchObject({
      code: 'agent_messaging_subscription_limit',
    });
    for (const publisher of agents.slice(1, MAX_AGENT_SUBSCRIPTIONS))
      await service.subscribe(first.sessionId, first.token, publisher.address);
    expect((await service.subscriptions(first.sessionId, first.token)).subscriptions).toHaveLength(
      MAX_AGENT_SUBSCRIPTIONS,
    );
    await expect(
      service.subscribe(first.sessionId, first.token, SERVER_PUBLICATION_TOPIC),
    ).rejects.toMatchObject({ code: 'agent_messaging_subscription_limit' });
    // Disabled, suspended and offline identities keep their deliberate opt-in.
    await db
      .update(agentBusAddresses)
      .set({ enabled: 0 })
      .where(eq(agentBusAddresses.id, agents[1]!.addressId));
    await service.finishSession(agents[4]!.sessionId, agents[4]!.token, 'completed');
    await db
      .insert(versions)
      .values({ name: 'grok_engine_disabled', version: '1', updatedAt: new Date().toISOString() });
    invalidateFleetEngineState(db);
    await expect(service.subscribe(overflow.sessionId, overflow.token, topic)).rejects.toMatchObject({
      code: 'agent_messaging_subscription_limit',
    });

    // Permanent retirement reclaims group membership and follows of the feed.
    await db
      .update(agentBusAddresses)
      .set({ archivedAt: new Date().toISOString() })
      .where(eq(agentBusAddresses.id, agents[2]!.addressId));
    await db.delete(agentBusAddresses).where(eq(agentBusAddresses.id, agents[3]!.addressId));
    expect(await service.subscribe(overflow.sessionId, overflow.token, topic)).toMatchObject({
      changed: true,
    });
    expect(await service.subscribe(first.sessionId, first.token, SERVER_PUBLICATION_TOPIC)).toMatchObject({
      changed: true,
    });
    const memberships = await db
      .select()
      .from(agentBusSubscriptions)
      .where(eq(agentBusSubscriptions.topic, topic));
    expect(memberships.some((row) => row.subscriberAddressId === agents[1]!.addressId)).toBe(true);
    expect(memberships.some((row) => row.subscriberAddressId === agents[4]!.addressId)).toBe(true);
    expect(memberships.some((row) => row.subscriberAddressId === agents[5]!.addressId)).toBe(true);
    expect(
      (await service.subscriptions(first.sessionId, first.token)).subscriptions.some(
        (row) => row.topic === agents[2]!.address || row.topic === agents[3]!.address,
      ),
    ).toBe(false);
  });

  it('protects the reserved Server identity from native controls and detects corrupt stored identity state', async () => {
    await service.publishAdmin({
      topic: SERVER_PUBLICATION_TOPIC,
      content: 'Create reserved publisher',
      clientMessageId: randomUUID(),
    });
    for (const enabled of [false, true])
      await expect(service.setAddressEnabled(SERVER_ADDRESS_ID, enabled)).rejects.toMatchObject({
        code: 'agent_messaging_server_identity_readonly',
      });
    await expect(service.setAddressAlias(SERVER_ADDRESS_ID, 'pretend-native')).rejects.toMatchObject({
      code: 'agent_messaging_server_identity_readonly',
    });
    const before = (
      await db.select().from(agentBusAddresses).where(eq(agentBusAddresses.id, SERVER_ADDRESS_ID))
    )[0]!;
    try {
      await db
        .update(agentBusAddresses)
        .set({ enabled: 0 })
        .where(eq(agentBusAddresses.id, SERVER_ADDRESS_ID));
      await expect(
        service.publishAdmin({
          topic: SERVER_PUBLICATION_TOPIC,
          content: 'Refuse disabled identity',
          clientMessageId: randomUUID(),
        }),
      ).rejects.toMatchObject({ code: 'agent_messaging_server_identity_conflict' });
      await db
        .update(agentBusAddresses)
        .set({ enabled: 1, archivedAt: new Date().toISOString() })
        .where(eq(agentBusAddresses.id, SERVER_ADDRESS_ID));
      await expect(
        service.publishAdmin({
          topic: SERVER_PUBLICATION_TOPIC,
          content: 'Refuse archived identity',
          clientMessageId: randomUUID(),
        }),
      ).rejects.toMatchObject({ code: 'agent_messaging_server_identity_conflict' });
    } finally {
      await db
        .update(agentBusAddresses)
        .set({ enabled: before.enabled, archivedAt: before.archivedAt })
        .where(eq(agentBusAddresses.id, SERVER_ADDRESS_ID));
    }
  });

  it('reclaims subscriptions when a publisher host was permanently deleted', async () => {
    const subscriber = await register('codex', 'host-retirement-subscriber');
    const now = new Date().toISOString();
    const fqdn = `${PREFIX}-retired-host.example`;
    await db.insert(hosts).values({
      fqdn,
      apiKey: 'a'.repeat(64),
      status: 'active',
      secure: 1,
      engines: 'claude',
      createdAt: now,
      updatedAt: now,
    });
    const retiredHost = (await db.select().from(hosts).where(eq(hosts.fqdn, fqdn)))[0]!;
    let addressId: string | undefined;
    try {
      const sessionId = randomUUID();
      const token = randomBytes(32).toString('base64url');
      const registered = await service.registerSession(retiredHost, {
        engine: 'claude',
        username: `${PREFIX}-deleted-host`,
        cwd: `/tmp/${PREFIX}/deleted-host`,
        invocationKind: 'interactive',
        sessionId,
        bridgeToken: token,
        adapterProtocol: 'test-live-v1',
      });
      const address = registered.address as { id: string; address: string };
      addressId = address.id;
      const topic = await group([subscriber], `${PREFIX}-host-retirement`);
      await service.subscribe(sessionId, token, topic);
      await service.subscribe(subscriber.sessionId, subscriber.token, address.address);
      await db.delete(hosts).where(eq(hosts.id, retiredHost.id));
      await service.subscribe(subscriber.sessionId, subscriber.token, SERVER_PUBLICATION_TOPIC);
      expect(
        (await service.subscriptions(subscriber.sessionId, subscriber.token)).subscriptions.map(
          (row) => row.topic,
        ),
      ).toEqual([SERVER_PUBLICATION_TOPIC, topic]);
      expect(
        (await service.groupMembers(subscriber.sessionId, subscriber.token, topic.slice(6))).members.map(
          (row) => row.address_id,
        ),
      ).toEqual([subscriber.addressId]);
    } finally {
      if (addressId) await db.delete(agentBusAddresses).where(eq(agentBusAddresses.id, addressId));
      await db.execute(sql`DELETE FROM agent_sessions WHERE host_id=${retiredHost.id}`);
      await db.delete(hosts).where(eq(hosts.id, retiredHost.id));
    }
  });
});
