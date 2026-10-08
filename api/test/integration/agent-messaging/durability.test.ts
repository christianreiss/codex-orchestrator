import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { eq, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  agentBusAddresses,
  agentBusConversations,
  agentBusMessages,
  agentBusRelays,
  agentSessions,
  hosts,
} from '../../../src/db/schema.js';
import { splitSqlStatements } from '../../../src/db/migration-sql.js';
import type { Env } from '../../../src/env.js';
import {
  AGENT_MESSAGING_ENABLED_KEY,
  AgentMessagingService,
} from '../../../src/services/agent-messaging.js';
import { AgentReceiverService } from '../../../src/services/agent-receiver.js';
import { makeAdminEventsWriter } from '../../../src/services/admin-events-writer.js';
import { HostManagementService } from '../../../src/services/host-management.js';
import { createHostRegistrationService } from '../../../src/services/host-registration.js';
import { ENGINES, type Engine } from '../../../src/util/engine.js';
import { getTestDb, type TestDb } from '../../helpers/test-db.js';
import { loadTestEnv, testKeyring } from '../../helpers/test-keyring.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = [
  join(HERE, '../../../src/db/migrations/0008_add_agent_portal.sql'),
  join(HERE, '../../../src/db/migrations/0014_add_agent_messaging.sql'),
];
const PREFIX = 'ztest-agent-messaging';
const HOST_FQDN = `${PREFIX}.example`;
const HOST_KEY = 'b'.repeat(64);
const DIRECTIONS = ENGINES.flatMap(source => ENGINES.map(target => ({ source, target })));
const RECEIVER_PROTOCOLS = {
  codex: 'codex-queue-v1',
  claude: 'claude-channel-v1',
  grok: 'grok-acp-v1',
} as const;
const handle = await getTestDb();

interface AgentIdentity {
  sessionId: string;
  bridgeToken: string;
  address: string;
  addressId: string;
  bindingGeneration: number;
  engine: Engine;
  username: string;
  cwd: string;
}

describe.skipIf(!handle)('agent messaging durability against a real database', { timeout: 120_000 }, () => {
  let db: TestDb;
  let env: Env;
  let service: AgentMessagingService;
  let host: typeof hosts.$inferSelect;

  const exec = async (query: string) => await db.execute(sql.raw(query));

  const cleanup = async (): Promise<void> => {
    const hostId = host?.id ?? 0;
    await exec(`DELETE FROM agent_bus_messages WHERE sender_address_id IN (
      SELECT id FROM agent_bus_addresses WHERE host_id = ${hostId}
    ) OR target_address_id IN (
      SELECT id FROM agent_bus_addresses WHERE host_id = ${hostId}
    )`);
    await exec(`DELETE FROM agent_bus_conversations WHERE address_a_id IN (
      SELECT id FROM agent_bus_addresses WHERE host_id = ${hostId}
    ) OR address_b_id IN (
      SELECT id FROM agent_bus_addresses WHERE host_id = ${hostId}
    )`);
    await exec(`DELETE FROM agent_bus_relays WHERE host_id = ${hostId}`);
    await exec(`DELETE FROM agent_sessions WHERE host_id = ${hostId}`);
    await exec(`DELETE FROM agent_bus_addresses WHERE host_id = ${hostId}`);
    await exec(`DELETE FROM install_tokens WHERE host_id = ${hostId}`);
    await exec(`DELETE FROM admin_events WHERE host_id = ${hostId}`);
    await exec(`DELETE FROM logs WHERE host_id = ${hostId}`);
    await exec(
      `INSERT INTO versions (name, version, updated_at)
       VALUES ('${AGENT_MESSAGING_ENABLED_KEY}', '0', '1970-01-01T00:00:00.000Z')
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
      `INSERT INTO hosts (
         fqdn, api_key, status, secure, engines, agent_messaging_enabled, created_at, updated_at
       ) VALUES (
         '${HOST_FQDN}', '${HOST_KEY}', 'active', 1, 'codex,claude,grok', 1, '${now}', '${now}'
       )`,
    );
    const rows = await db.select().from(hosts).where(eq(hosts.fqdn, HOST_FQDN)).limit(1);
    host = rows[0]!;
    env = { ...loadTestEnv(), AGENT_PORTAL_BRIDGE_TTL_SECONDS: 900 } as Env;
    service = new AgentMessagingService(db, env, testKeyring());
  });

  beforeEach(async () => {
    await cleanup();
    await exec(
      `INSERT INTO versions (name, version, updated_at)
       VALUES ('${AGENT_MESSAGING_ENABLED_KEY}', '1', '2026-07-31T00:00:00.000Z')
       ON DUPLICATE KEY UPDATE version = '1', updated_at = VALUES(updated_at)`,
    );
    await db
      .update(hosts)
      .set({ secure: 1, status: 'active', insecureEnabledUntil: null, engines: ENGINES.join(',') })
      .where(eq(hosts.id, host.id));
    host = (await db.select().from(hosts).where(eq(hosts.id, host.id)).limit(1))[0]!;
  });

  afterEach(cleanup);

  afterAll(async () => {
    await cleanup();
    await exec(`DELETE FROM hosts WHERE fqdn = '${HOST_FQDN}'`);
    await handle?.pool.end();
  });

  async function register(
    engine: Engine,
    label: string,
    overrides: Partial<{
      username: string;
      cwd: string;
      upstreamSessionId: string;
      adapterProtocol: string | null;
      requestedAddress: string;
      expectedBindingGeneration: number;
    }> = {},
  ): Promise<AgentIdentity> {
    const sessionId = randomUUID();
    const bridgeToken = randomBytes(32).toString('base64url');
    const username = overrides.username ?? `${PREFIX}-${label}`;
    const cwd = overrides.cwd ?? `/tmp/${PREFIX}/${label}`;
    const result = await service.registerSession(host, {
      engine,
      username,
      cwd,
      upstreamSessionId: overrides.upstreamSessionId,
      invocationKind: 'interactive',
      sessionId,
      bridgeToken,
      adapterProtocol: overrides.adapterProtocol === undefined ? 'test-live-v1' : overrides.adapterProtocol,
      requestedAddress: overrides.requestedAddress,
      expectedBindingGeneration: overrides.expectedBindingGeneration,
      adapterCapabilities: { test: true, execution_contract_version: 2 },
    });
    const address = result.address as Record<string, unknown>;
    return {
      sessionId,
      bridgeToken,
      address: String(address.address),
      addressId: String(address.id),
      bindingGeneration: Number(address.binding_generation),
      engine,
      username,
      cwd,
    };
  }

  async function deliver(source: AgentIdentity, target: AgentIdentity, content: string): Promise<void> {
    const sent = await service.sendMessage(source.sessionId, source.bridgeToken, {
      to: target.address,
      content,
      clientMessageId: randomUUID(),
      kind: 'request',
    });
    const message = sent.message as Record<string, unknown>;
    const claimId = randomUUID();
    const claimed = await service.claimForSession(target.sessionId, target.bridgeToken, claimId);
    expect(claimed).toMatchObject({
      message_id: message.id,
      content,
      claim_id: claimId,
      attempts: 1,
    });
    await service.acknowledgeSessionDelivery(target.sessionId,target.bridgeToken,String(message.id),{claimId,outcome:'accepted'});
    const completed = await service.acknowledgeSessionDelivery(
      target.sessionId,
      target.bridgeToken,
      String(message.id),
      { claimId, outcome: 'completed', upstreamSessionId: randomUUID() },
    );
    expect((completed.message as Record<string, unknown>).status).toBe('completed');
    // Lost HTTP responses are safe: terminal ACKs retain their scoped claim
    // identity and collapse a retry onto the same terminal row.
    const repeated = await service.acknowledgeSessionDelivery(
      target.sessionId,
      target.bridgeToken,
      String(message.id),
      { claimId, outcome: 'completed' },
    );
    expect((repeated.message as Record<string, unknown>).status).toBe('completed');
  }

  it('refuses to accept expired queued work even before the maintenance sweep', async () => {
    const sender = await register('codex', 'expired-sender');
    const target = await register('grok', 'expired-target');
    const sent = await service.sendMessage(sender.sessionId, sender.bridgeToken, {
      to: target.address, content: 'expired work', kind: 'request', clientMessageId: randomUUID(),
    });
    const messageId = String((sent.message as Record<string, unknown>).id), claimId = randomUUID();
    await service.claimForSession(target.sessionId, target.bridgeToken, claimId);
    await db.update(agentBusMessages).set({ expiresAt: new Date(Date.now() - 1000).toISOString() }).where(eq(agentBusMessages.id, messageId));
    await expect(service.acknowledgeSessionDelivery(target.sessionId, target.bridgeToken, messageId, { claimId, outcome: 'accepted' })).rejects.toMatchObject({ code: 'agent_messaging_message_expired' });
    const [message] = await db.select().from(agentBusMessages).where(eq(agentBusMessages.id, messageId));
    expect(message!.acceptedAt).toBeNull();
  });

  it('delivers and completes all nine Codex/Claude/Grok direction pairs', async () => {
    const senders = new Map<Engine, AgentIdentity>();
    const targets = new Map<Engine, AgentIdentity>();
    for (const engine of ENGINES) {
      senders.set(engine, await register(engine, `${engine}-sender`));
      targets.set(engine, await register(engine, `${engine}-target`));
    }
    for (const { source, target } of DIRECTIONS) {
      await deliver(senders.get(source)!, targets.get(target)!, `${source} to ${target}`);
    }

    const state = await service.state();
    const directions = state.directions as Array<Record<string, unknown>>;
    for (const { source, target } of DIRECTIONS) {
      expect(directions.find((row) => row.source_engine === source && row.target_engine === target))
        .toMatchObject({ total: 1, completed: 1, pending: 0 });
    }
  });

  it.each(DIRECTIONS)('$source to $target preserves durable admission, receiver ownership and exact session generations', async ({ source: sourceEngine, target: targetEngine }) => {
    const source = await register(sourceEngine, 'matrix-source', { adapterProtocol: null });
    const nativeSessionId = randomUUID();
    const target = await register(targetEngine, 'matrix-target', {
      adapterProtocol: null, upstreamSessionId: nativeSessionId,
    });
    const content = `${sourceEngine} to ${targetEngine} survives receiver reconnect`;
    const input = { to: target.address, content, clientMessageId: randomUUID(), kind: 'request' as const };
    const sent = await service.sendMessage(source.sessionId, source.bridgeToken, input);
    const messageId = String((sent.message as Record<string, unknown>).id);
    const readMessage = async (id = messageId) => (await db.select().from(agentBusMessages).where(eq(agentBusMessages.id, id)))[0]!;
    expect(await readMessage()).toMatchObject({
      sourceEngine, targetEngine, senderSessionId: source.sessionId,
      targetAddressId: target.addressId, status: 'queued', attempts: 0,
      claimId: null, leaseOwner: null, targetBindingGeneration: null,
      deliverySessionId: null, deliveryUpstreamSessionId: null,
    });
    expect((await readMessage()).contentEnc).not.toContain(content);
    await expect(service.claimForSession(target.sessionId, target.bridgeToken, randomUUID()))
      .rejects.toMatchObject({ code: 'agent_messaging_adapter_unavailable' });

    // A new service has no in-memory queue; admission and idempotency survive it.
    service = new AgentMessagingService(db, env, testKeyring());
    const repeated = await service.sendMessage(source.sessionId, source.bridgeToken, input);
    expect(repeated.message).toMatchObject({ id: messageId, status: 'queued' });
    const mailbox = await service.peekMailbox(target.sessionId, target.bridgeToken);
    expect(mailbox.pending).toEqual([expect.objectContaining({
      message_id: messageId, from: expect.objectContaining({ engine: sourceEngine }),
    })]);
    expect(JSON.stringify(mailbox)).not.toContain(content);
    expect(await readMessage()).toMatchObject({ status: 'queued', attempts: 0, claimId: null });

    const receiver = new AgentReceiverService(db, env, testKeyring());
    const generation = randomUUID();
    const protocol = RECEIVER_PROTOCOLS[targetEngine];
    await expect(receiver.register(target.sessionId, target.bridgeToken, {
      generation, protocol: RECEIVER_PROTOCOLS[ENGINES.find(engine => engine !== targetEngine)!],
      native_session_id: nativeSessionId,
    })).rejects.toMatchObject({ code: 'receiver_engine_mismatch' });
    expect((await receiver.register(target.sessionId, target.bridgeToken, {
      generation, protocol, native_session_id: nativeSessionId,
    })).receiver).toMatchObject({ state: 'ready', protocol, generation, native_session_id: nativeSessionId });
    await expect(receiver.register(target.sessionId, target.bridgeToken, {
      generation: randomUUID(), protocol, native_session_id: randomUUID(),
    })).rejects.toMatchObject({ code: 'receiver_owned' });
    await expect(service.heartbeatSession(target.sessionId, target.bridgeToken, { receiveCapable: false }))
      .rejects.toMatchObject({ code: 'receiver_owned' });
    await expect(receiver.claim(target.sessionId, target.bridgeToken, randomUUID(), 'peer', randomUUID()))
      .rejects.toMatchObject({ code: 'receiver_expired' });

    const relay = await service.registerRelay(host, {
      username: target.username, instanceId: randomUUID(), wrapperVersion: 'matrix-test',
        capabilities: { execution_contract_version: 2 },
    });
    expect(await service.claimForRelay(String(relay.relay_id), String(relay.relay_token), randomUUID())).toBeNull();
    expect(await readMessage()).toMatchObject({ status: 'queued', attempts: 0 });
    const second = await service.sendMessage(source.sessionId, source.bridgeToken, {
      ...input, content: 'second queued message', clientMessageId: randomUUID(),
    });
    const secondId = String((second.message as Record<string, unknown>).id);
    const claimId = randomUUID();
    const claimed = await receiver.claim(target.sessionId, target.bridgeToken, generation, 'peer', claimId);
    expect(claimed.delivery).toMatchObject({
      message_id: messageId, content, attempts: 1, claim_id: claimId,
      lease_owner: `session:${target.sessionId}`,
      sender: { address: source.address, engine: sourceEngine },
      target: { address: target.address, engine: targetEngine, binding_generation: target.bindingGeneration, upstream_session_id: nativeSessionId },
    });
    expect(await readMessage()).toMatchObject({
      status: 'leased', targetBindingGeneration: target.bindingGeneration,
      deliverySessionId: target.sessionId, deliveryUpstreamSessionId: nativeSessionId,
    });
    expect((await receiver.claim(target.sessionId, target.bridgeToken, generation, 'peer', claimId)).delivery)
      .toMatchObject({ message_id: messageId, attempts: 1 });
    await expect(service.acknowledgeSessionDelivery(source.sessionId, source.bridgeToken, messageId, {
      claimId, outcome: 'accepted',
    })).rejects.toMatchObject({ code: 'agent_messaging_lease_lost' });
    await service.acknowledgeSessionDelivery(target.sessionId, target.bridgeToken, messageId, {
      claimId, outcome: 'accepted', upstreamSessionId: nativeSessionId,
    });
    expect((await receiver.claim(target.sessionId, target.bridgeToken, generation, 'peer', randomUUID())).delivery).toBeNull();
    expect(await readMessage(secondId)).toMatchObject({ status: 'queued', attempts: 0 });
    // A receiver connection generation can change while the native turn keeps
    // running. Its accepted claim belongs to the session/binding, so it remains
    // renewable and completable without exposing either message a second time.
    await receiver.retry(target.sessionId);
    const resumedGeneration = randomUUID();
    await receiver.register(target.sessionId, target.bridgeToken, {
      generation: resumedGeneration, protocol, native_session_id: nativeSessionId,
    });
    await service.renewSessionDelivery(target.sessionId, target.bridgeToken, messageId, claimId);
    expect((await receiver.claim(target.sessionId, target.bridgeToken, resumedGeneration, 'peer', randomUUID())).delivery).toBeNull();
    expect(await readMessage()).toMatchObject({ status: 'accepted', claimId, attempts: 1 });
    await service.acknowledgeSessionDelivery(target.sessionId, target.bridgeToken, messageId, {
      claimId, outcome: 'completed', upstreamSessionId: nativeSessionId,
    });

    await receiver.retry(target.sessionId);
    await expect(receiver.update(target.sessionId, target.bridgeToken, generation, 'heartbeat', {}))
      .rejects.toMatchObject({ code: 'receiver_generation_changed' });
    await expect(receiver.claim(target.sessionId, target.bridgeToken, generation, 'peer', randomUUID()))
      .rejects.toMatchObject({ code: 'receiver_expired' });
    await service.finishSession(target.sessionId, target.bridgeToken, 'completed');
    await expect(register(targetEngine, 'matrix-stale', {
      username: target.username, cwd: target.cwd, requestedAddress: target.address,
      expectedBindingGeneration: target.bindingGeneration - 1,
    })).rejects.toMatchObject({ code: 'agent_messaging_binding_stale' });
    const restarted = await register(targetEngine, 'matrix-restarted', {
      username: target.username, cwd: target.cwd, adapterProtocol: null,
      upstreamSessionId: nativeSessionId, requestedAddress: target.address,
      expectedBindingGeneration: target.bindingGeneration,
    });
    expect(restarted).toMatchObject({ address: target.address, bindingGeneration: target.bindingGeneration + 1 });
    const successorGeneration = randomUUID();
    await receiver.register(restarted.sessionId, restarted.bridgeToken, {
      generation: successorGeneration, protocol, native_session_id: nativeSessionId,
    });
    await expect(receiver.claim(target.sessionId, target.bridgeToken, generation, 'peer', randomUUID()))
      .rejects.toMatchObject({ code: 'agent_session_finished' });
    const successorClaim = randomUUID();
    expect((await receiver.claim(restarted.sessionId, restarted.bridgeToken, successorGeneration, 'peer', successorClaim)).delivery)
      .toMatchObject({ message_id: secondId, attempts: 1, target: { binding_generation: restarted.bindingGeneration, upstream_session_id: nativeSessionId } });
    expect(await readMessage(secondId)).toMatchObject({
      deliverySessionId: restarted.sessionId, deliveryUpstreamSessionId: nativeSessionId,
      targetBindingGeneration: restarted.bindingGeneration,
    });
    await service.acknowledgeSessionDelivery(restarted.sessionId,restarted.bridgeToken,secondId,{claimId:successorClaim,outcome:'accepted'});
    await service.acknowledgeSessionDelivery(restarted.sessionId, restarted.bridgeToken, secondId, {
      claimId: successorClaim, outcome: 'completed', upstreamSessionId: nativeSessionId,
    });
    expect(await readMessage()).toMatchObject({ status: 'completed', attempts: 1 });
    expect(await readMessage(secondId)).toMatchObject({ status: 'completed', attempts: 1 });
  });

  it('keeps one in-flight delivery per address and preserves FIFO across retry', async () => {
    const source = await register('codex', 'fifo-source');
    const target = await register('claude', 'fifo-target');
    const first = await service.sendMessage(source.sessionId, source.bridgeToken, {
      to: target.address, content: 'first', clientMessageId: randomUUID(),
    });
    const second = await service.sendMessage(source.sessionId, source.bridgeToken, {
      to: target.address, content: 'second', clientMessageId: randomUUID(),
    });
    const firstId = String((first.message as Record<string, unknown>).id);
    const secondId = String((second.message as Record<string, unknown>).id);
    const inserted = await db.select().from(agentBusMessages).where(
      sql`${agentBusMessages.id} IN (${firstId}, ${secondId})`,
    );
    const orders = new Map(inserted.map((row) => [row.id, row.dispatchOrder]));
    expect(orders.get(firstId)).toBeLessThan(orders.get(secondId)!);
    const claimA = randomUUID();
    expect(await service.claimForSession(target.sessionId, target.bridgeToken, claimA))
      .toMatchObject({ message_id: firstId, content: 'first' });
    expect(await service.claimForSession(target.sessionId, target.bridgeToken, randomUUID())).toBeNull();
    await service.acknowledgeSessionDelivery(target.sessionId, target.bridgeToken, firstId, {
      claimId: claimA, outcome: 'retry', errorCode: 'test_retry',
    });
    // The second delivery cannot leapfrog a delayed retry at the head.
    expect(await service.claimForSession(target.sessionId, target.bridgeToken, randomUUID())).toBeNull();
    await db.update(agentBusMessages).set({ nextAttemptAt: '1970-01-01T00:00:00.000Z' }).where(eq(agentBusMessages.id, firstId));
    const claimB = randomUUID();
    expect(await service.claimForSession(target.sessionId, target.bridgeToken, claimB))
      .toMatchObject({ message_id: firstId, attempts: 2 });
    await service.acknowledgeSessionDelivery(target.sessionId, target.bridgeToken, firstId, {
      claimId: claimB, outcome: 'completed',
    });
    expect(await service.claimForSession(target.sessionId, target.bridgeToken, randomUUID()))
      .toMatchObject({ message_id: secondId, content: 'second' });
  });

  it('does not let sixty-four blocked later rows starve another target', async () => {
    const source = await register('codex', 'starvation-source');
    const blockedTarget = await register('claude', 'starvation-blocked');
    const eligibleTarget = await register('claude', 'starvation-eligible');
    const head = await service.sendMessage(source.sessionId, source.bridgeToken, {
      to: blockedTarget.address, content: 'blocked-head', clientMessageId: randomUUID(),
    });
    const headMessage = head.message as Record<string, unknown>;
    await db.update(agentBusMessages).set({ nextAttemptAt: '2999-01-01T00:00:00.000Z' }).where(
      eq(agentBusMessages.id, String(headMessage.id)),
    );
    for (let index = 0; index < 64; index += 1) {
      await service.sendMessage(source.sessionId, source.bridgeToken, {
        to: blockedTarget.address,
        conversationId: String(headMessage.conversation_id),
        content: `blocked-later-${index}`,
        clientMessageId: randomUUID(),
      });
    }
    const eligible = await service.sendMessage(source.sessionId, source.bridgeToken, {
      to: eligibleTarget.address, content: 'claim-me', clientMessageId: randomUUID(),
    });
    expect(await service.claimForSession(eligibleTarget.sessionId, eligibleTarget.bridgeToken, randomUUID())).toMatchObject({
      message_id: String((eligible.message as Record<string, unknown>).id),
      content: 'claim-me',
    });
  });

  it('reuses a dormant host/user/engine/cwd address with reset continuity', async () => {
    const first = await register('codex', 'stable', { username: 'stable-user', cwd: '/tmp/stable-work' });
    await service.finishSession(first.sessionId, first.bridgeToken, 'completed');
    const second = await register('codex', 'stable-next', { username: 'stable-user', cwd: '/tmp/stable-work' });

    expect(second.addressId).toBe(first.addressId);
    expect(second.address).toBe(first.address);
    expect(second.bindingGeneration).toBe(first.bindingGeneration + 1);
    const rows = await db.select().from(agentBusAddresses).where(eq(agentBusAddresses.id, first.addressId));
    expect(rows[0]).toMatchObject({ continuity: 'reset', currentSessionId: second.sessionId });
  });

  it('does not let a disabled address rebind until an administrator re-enables it', async () => {
    const identity = await register('codex', 'disabled-rebind');
    await service.setAddressEnabled(identity.addressId, false);
    await expect(service.registerSession(host, {
      engine: identity.engine,
      username: identity.username,
      cwd: identity.cwd,
      invocationKind: 'interactive',
      sessionId: identity.sessionId,
      bridgeToken: identity.bridgeToken,
      adapterProtocol: 'test-live-v1',
    })).rejects.toMatchObject({ code: 'agent_messaging_binding_stale' });
    await expect(service.listAddresses(identity.sessionId, identity.bridgeToken)).rejects.toMatchObject({
      code: 'agent_messaging_binding_stale',
    });

    await service.setAddressEnabled(identity.addressId, true);
    const rebound = await service.registerSession(host, {
      engine: identity.engine,
      username: identity.username,
      cwd: identity.cwd,
      invocationKind: 'interactive',
      sessionId: identity.sessionId,
      bridgeToken: identity.bridgeToken,
      requestedAddress: identity.address,
      adapterProtocol: 'test-live-v1',
    });
    expect(rebound.address).toMatchObject({ id: identity.addressId, address: identity.address });
  });

  it('reclaims an expired wrapper binding and delivers queued work to the stable address', async () => {
    const source = await register('codex', 'reap-source');
    const target = await register('claude', 'reap-target', {
      username: 'reap-user', cwd: '/tmp/reap-work',
    });
    const sent = await service.sendMessage(source.sessionId, source.bridgeToken, {
      to: target.address, content: 'survive wrapper crash', clientMessageId: randomUUID(),
    });
    await db.update(agentSessions).set({ bridgeExpiresAt: '1970-01-01T00:00:00.000Z' }).where(eq(agentSessions.id, target.sessionId));
    const restarted = await register('claude', 'reap-restarted', {
      username: 'reap-user', cwd: '/tmp/reap-work',
    });
    expect(restarted.addressId).toBe(target.addressId);
    const claimId = randomUUID();
    expect(await service.claimForSession(restarted.sessionId, restarted.bridgeToken, claimId)).toMatchObject({
      message_id: String((sent.message as Record<string, unknown>).id),
      content: 'survive wrapper crash',
    });
  });

  it('makes the final retry-to-dead acknowledgement idempotent after a lost response', async () => {
    const source = await register('codex', 'dead-source');
    const target = await register('claude', 'dead-target');
    const sent = await service.sendMessage(source.sessionId, source.bridgeToken, {
      to: target.address, content: 'fail permanently', clientMessageId: randomUUID(),
    });
    const messageId = String((sent.message as Record<string, unknown>).id);
    const claimId = randomUUID();
    await service.claimForSession(target.sessionId, target.bridgeToken, claimId);
    await db.update(agentBusMessages).set({ attempts: 12 }).where(eq(agentBusMessages.id, messageId));
    const first = await service.acknowledgeSessionDelivery(target.sessionId, target.bridgeToken, messageId, {
      claimId, outcome: 'retry', errorCode: 'permanent_test_failure',
    });
    expect(first.message).toMatchObject({ status: 'dead' });
    const repeated = await service.acknowledgeSessionDelivery(target.sessionId, target.bridgeToken, messageId, {
      claimId, outcome: 'retry', errorCode: 'permanent_test_failure',
    });
    expect(repeated.message).toMatchObject({ status: 'dead' });
  });

  it('master-off cancels work and conversations, revokes relays, but leaves interactive sessions running', async () => {
    const source = await register('codex', 'switch-source');
    const target = await register('claude', 'switch-target');
    await service.sendMessage(source.sessionId, source.bridgeToken, {
      to: target.address, content: 'cancel me', clientMessageId: randomUUID(),
    });
    await service.registerRelay(host, {
      username: target.username,
      instanceId: randomUUID(),
      wrapperVersion: 'test',
        capabilities: { execution_contract_version: 2 },
    });

    const result = await service.setEnabled(false);
    expect(result).toMatchObject({ enabled: false, canceled: 1, conversations: 1, relays: 1 });
    expect((await db.select().from(agentBusMessages))[0]).toMatchObject({ status: 'canceled' });
    expect((await db.select().from(agentBusConversations))[0]).toMatchObject({ status: 'canceled' });
    expect((await db.select().from(agentBusRelays))[0]).toMatchObject({ status: 'revoked', tokenHash: null });
    const sessions = await db.select().from(agentSessions).where(eq(agentSessions.hostId, host.id));
    expect(sessions).toHaveLength(2);
    expect(sessions.every((row) => row.endedAt === null)).toBe(true);
    await expect(service.listAddresses(source.sessionId, source.bridgeToken)).rejects.toMatchObject({
      code: 'agent_messaging_disabled',
    });
  });

  // The allowed window is a MySQL DATETIME written through drizzle's
  // toISOString mapping. These three run against real MySQL on purpose: a
  // client-side ISO string in the eligibility filter would compare the T/Z
  // form against a DATETIME and silently return the wrong host set, which no
  // in-memory fake can catch.
  it('keeps an insecure host eligible while its allowed window is open', async () => {
    const source = await register('codex', 'window-open-source');
    const target = await register('claude', 'window-open-target');
    await db
      .update(hosts)
      .set({ secure: 0, insecureEnabledUntil: new Date(Date.now() + 10 * 60_000) })
      .where(eq(hosts.id, host.id));

    const listed = await service.listAddresses(source.sessionId, source.bridgeToken);
    expect((listed.addresses as Array<{ address: string }>).map((row) => row.address)).toContain(
      target.address,
    );
    const sent = await service.sendMessage(source.sessionId, source.bridgeToken, {
      to: target.address, content: 'insecure but inside the window', clientMessageId: randomUUID(),
    });
    expect(sent.message).toMatchObject({ status: 'queued' });
  });

  it('drops a peer from the online listing the moment its heartbeat goes stale', async () => {
    const source = await register('codex', 'presence-source');
    const target = await register('claude', 'presence-target');

    const onlineAddresses = async () => {
      const listed = await service.listAddresses(source.sessionId, source.bridgeToken, {
        includeOffline: false,
      });
      return (listed.addresses as Array<{ address: string }>).map((row) => row.address);
    };

    expect(await onlineAddresses()).toContain(target.address);

    // The crash. Nothing tells the server a wrapper died: `readiness` still
    // reads what registration wrote and `current_session_id` is still bound, so
    // every stored signal says this agent is fine. Only the heartbeat knows.
    await db
      .update(agentSessions)
      .set({ heartbeatAt: new Date(Date.now() - 600_000).toISOString().replace(/\.\d{3}Z$/, 'Z') })
      .where(eq(agentSessions.id, target.sessionId));

    // Before presence was derived this still listed as a reachable peer, and a
    // message to it queued for the full 24h TTL against nobody.
    expect(await onlineAddresses()).not.toContain(target.address);

    // The row stays discoverable unfiltered — it is history, not a lie — and
    // now carries the honest answer alongside the latched `readiness`.
    const all = await service.listAddresses(source.sessionId, source.bridgeToken);
    const row = (all.addresses as Array<Record<string, unknown>>).find(
      (r) => r['address'] === target.address,
    );
    expect(row?.['presence']).toBe('offline');
    expect(row?.['readiness']).toBe('ready');
  });

  it('denies an insecure host once its allowed window has closed, without canceling queued work', async () => {
    const source = await register('codex', 'window-closed-source');
    const target = await register('claude', 'window-closed-target');
    const sent = await service.sendMessage(source.sessionId, source.bridgeToken, {
      to: target.address, content: 'wait for the window', clientMessageId: randomUUID(),
    });
    await db
      .update(hosts)
      .set({ secure: 0, insecureEnabledUntil: new Date(Date.now() - 60_000) })
      .where(eq(hosts.id, host.id));

    // A closed window fails loudly at the bridge credential rather than
    // silently returning nothing: the tools stay present, the call is denied.
    await expect(
      service.listAddresses(source.sessionId, source.bridgeToken),
    ).rejects.toMatchObject({ code: 'agent_messaging_insecure_window_closed' });
    await expect(
      service.sendMessage(source.sessionId, source.bridgeToken, {
        to: target.address, content: 'still closed', clientMessageId: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: 'agent_messaging_insecure_window_closed' });

    // The queue survives a closed window; it is not an operational shutdown.
    expect((await db.select().from(agentBusMessages).where(
      eq(agentBusMessages.id, String((sent.message as Record<string, unknown>).id)),
    ))[0]).toMatchObject({ status: 'queued' });
    expect((await db.select().from(agentBusConversations))[0]).toMatchObject({ status: 'open' });
  });

  it('resumes delivery when the operator reopens the window', async () => {
    const source = await register('codex', 'window-reopen-source');
    const target = await register('claude', 'window-reopen-target');
    const sent = await service.sendMessage(source.sessionId, source.bridgeToken, {
      to: target.address, content: 'deliver after reopen', clientMessageId: randomUUID(),
    });
    const messageId = String((sent.message as Record<string, unknown>).id);
    await db
      .update(hosts)
      .set({ secure: 0, insecureEnabledUntil: new Date(Date.now() - 60_000) })
      .where(eq(hosts.id, host.id));
    await expect(
      service.claimForSession(target.sessionId, target.bridgeToken, randomUUID()),
    ).rejects.toMatchObject({ code: 'agent_messaging_insecure_window_closed' });

    await db
      .update(hosts)
      .set({ insecureEnabledUntil: new Date(Date.now() + 10 * 60_000) })
      .where(eq(hosts.id, host.id));
    const delivery = await service.claimForSession(target.sessionId, target.bridgeToken, randomUUID());
    expect(delivery).toMatchObject({ message_id: messageId });
  });

  // The relay is the lane that runs unattended, so a closed window has to stop
  // it at both the registration and the polling edge. Before the fleet switch
  // became the only switch an insecure host never started a relay at all; now
  // it does, and this is what keeps it from claiming outside its window.
  it('refuses relay registration and relay claims while the allowed window is closed', async () => {
    const target = await register('claude', 'relay-window-target');
    const source = await register('codex', 'relay-window-source');
    await service.sendMessage(source.sessionId, source.bridgeToken, {
      to: target.address, content: 'not for a closed window', clientMessageId: randomUUID(),
    });
    const relay = await service.registerRelay(host, {
      username: target.username,
      instanceId: randomUUID(),
      wrapperVersion: 'test',
        capabilities: { execution_contract_version: 2 },
    });

    const closed = (await db
      .update(hosts)
      .set({ secure: 0, insecureEnabledUntil: new Date(Date.now() - 60_000) })
      .where(eq(hosts.id, host.id))
      .then(() => db.select().from(hosts).where(eq(hosts.id, host.id)).limit(1)))[0]!;

    await expect(
      service.claimForRelay(String(relay.relay_id), String(relay.relay_token), randomUUID()),
    ).rejects.toMatchObject({ code: 'agent_messaging_insecure_window_closed' });
    await expect(
      service.registerRelay(closed, {
        username: target.username,
        instanceId: randomUUID(),
        wrapperVersion: 'test',
        capabilities: { execution_contract_version: 2 },
      }),
    ).rejects.toMatchObject({ code: 'agent_messaging_insecure_window_closed' });

    // Reopening the window restores the relay lane without a redrive.
    await db
      .update(hosts)
      .set({ insecureEnabledUntil: new Date(Date.now() + 10 * 60_000) })
      .where(eq(hosts.id, host.id));
    const reopened = (await db.select().from(hosts).where(eq(hosts.id, host.id)).limit(1))[0]!;
    const revived = await service.registerRelay(reopened, {
      username: target.username,
      instanceId: randomUUID(),
      wrapperVersion: 'test',
        capabilities: { execution_contract_version: 2 },
    });
    expect(revived).toMatchObject({ enabled: true });
  });

  it('atomically fences messaging when the admin registration path rotates a host key', async () => {
    const source = await register('codex', 'admin-rotate-source');
    const target = await register('claude', 'admin-rotate-target');
    const sent = await service.sendMessage(source.sessionId, source.bridgeToken, {
      to: target.address, content: 'do not survive key rotation', clientMessageId: randomUUID(),
    });
    await service.registerRelay(host, {
      username: target.username,
      instanceId: randomUUID(),
      wrapperVersion: 'test',
        capabilities: { execution_contract_version: 2 },
    });
    const management = new HostManagementService({
      db,
      env,
      keyring: testKeyring(),
      events: makeAdminEventsWriter(db),
    });

    const rotated = await management.register({
      fqdn: HOST_FQDN,
      secure: true,
      engines: ['codex', 'claude'],
    });
    host = rotated.host;

    expect((await db.select().from(agentBusMessages).where(
      eq(agentBusMessages.id, String((sent.message as Record<string, unknown>).id)),
    ))[0]).toMatchObject({ status: 'canceled' });
    expect((await db.select().from(agentBusConversations))[0]).toMatchObject({ status: 'canceled' });
    expect((await db.select().from(agentBusRelays))[0]).toMatchObject({ status: 'revoked', tokenHash: null });
    expect((await db.select().from(agentBusAddresses))[0]).toMatchObject({ readiness: 'disabled', currentSessionId: null });
  });

  it('atomically fences messaging when CLI auth approval rotates a host key', async () => {
    const source = await register('claude', 'cli-rotate-source');
    const target = await register('codex', 'cli-rotate-target');
    const sent = await service.sendMessage(source.sessionId, source.bridgeToken, {
      to: target.address, content: 'do not survive CLI reapproval', clientMessageId: randomUUID(),
    });
    const registration = createHostRegistrationService({
      db,
      keyring: testKeyring(),
      insecure: { openInitial: async () => undefined } as never,
    });

    const rotated = await registration.registerOrRotate({
      fqdn: HOST_FQDN,
      secure: true,
      engines: 'codex,claude',
      createdBy: 'durability-test',
    });
    host = rotated.host;

    expect((await db.select().from(agentBusMessages).where(
      eq(agentBusMessages.id, String((sent.message as Record<string, unknown>).id)),
    ))[0]).toMatchObject({ status: 'canceled' });
    expect((await db.select().from(agentBusConversations))[0]).toMatchObject({ status: 'canceled' });
    expect((await db.select().from(agentBusAddresses))[0]).toMatchObject({ readiness: 'disabled', currentSessionId: null });
  });

  describe('a session that never received an address', () => {
    // Every session registered while the fleet switch was off is in this
    // state the moment the switch is turned on. Its liveness heartbeat is
    // shared with Agent Portal, so raising here silently killed the portal
    // for the whole life of the session.
    async function unboundSession(): Promise<AgentIdentity> {
      const agent = await register('codex', 'unbound');
      await exec(`UPDATE agent_sessions SET agent_bus_address_id = NULL WHERE id = '${agent.sessionId}'`);
      return agent;
    }

    it('reports no messaging rather than failing the shared heartbeat', async () => {
      const agent = await unboundSession();

      await expect(
        service.heartbeatSession(agent.sessionId, agent.bridgeToken, {
          status: 'active',
          skipIfUnbound: true,
        }),
      ).resolves.toBeNull();
    });

    it('still refuses an explicit bind, which cannot be satisfied', async () => {
      const agent = await unboundSession();

      await expect(
        service.heartbeatSession(agent.sessionId, agent.bridgeToken, { receiveCapable: true }),
      ).rejects.toMatchObject({ code: 'agent_messaging_address_missing' });
    });

    it('keeps heartbeating a bound session normally', async () => {
      const agent = await register('codex', 'bound');

      const result = await service.heartbeatSession(agent.sessionId, agent.bridgeToken, {
        status: 'active',
        skipIfUnbound: true,
      });

      expect(result).toMatchObject({ enabled: true });
      expect((result!.address as Record<string, unknown>).address).toBe(agent.address);
    });
  });
});
