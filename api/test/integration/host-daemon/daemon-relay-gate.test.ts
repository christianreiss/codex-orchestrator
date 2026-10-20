import { createHash, randomUUID, randomBytes } from 'node:crypto';
import { eq, or } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  hosts,
  hostDaemons,
  hostDaemonSessions,
  versions,
  agentBusMessages,
  agentBusConversations,
  agentSessions,
  agentBusAddresses,
  agentBusRelays,
} from '../../../src/db/schema.js';
import { AgentMessagingService } from '../../../src/services/agent-messaging.js';
import { HostDaemonService } from '../../../src/services/host-daemon/service.js';
import { daemonSettingsSchema } from '../../../src/services/host-daemon/policy.js';
import { getTestDb } from '../../helpers/test-db.js';
import { loadTestEnv, testKeyring } from '../../helpers/test-keyring.js';

// An operator turning the host daemon off (or a timed deadline/migration fence) must cut
// an already-registered daemon relay off at its next heartbeat or claim, not only when its
// 15-minute token lapses. Accepted work keeps the relay alive until it has drained.
const handle = await getTestDb();
describe.skipIf(!handle)('daemon relay acceptance gate with MySQL', () => {
  let id: number, service: HostDaemonService, messaging: AgentMessagingService, generation: string;
  beforeAll(async () => {
    const stamp = new Date().toISOString(),
      fqdn = `daemon-relay-gate-${randomUUID()}.test`;
    await handle!.db.insert(hosts).values({
      fqdn,
      apiKey: 'f'.repeat(64),
      apiKeyHash: createHash('sha256').update(fqdn).digest('hex'),
      reverseDnsMode: 0,
      engines: 'codex,claude,grok',
      secure: 1,
      agentMessagingEnabled: 1,
      authDigest: 'fixture',
      claudeAuthDigest: 'fixture',
      grokAuthDigest: 'fixture',
      status: 'active',
      createdAt: stamp,
      updatedAt: stamp,
    });
    id = (await handle!.db.select().from(hosts).where(eq(hosts.fqdn, fqdn)))[0]!.id;
    await handle!.db
      .insert(versions)
      .values({ name: 'agent_messaging_enabled', version: '1', updatedAt: stamp })
      .onDuplicateKeyUpdate({ set: { version: '1' } });
    service = new HostDaemonService({ db: handle!.db, env: loadTestEnv(), keyring: testKeyring() });
    messaging = new AgentMessagingService(handle!.db, loadTestEnv(), testKeyring());
  });
  beforeEach(async () => {
    await handle!.db.delete(hostDaemonSessions).where(eq(hostDaemonSessions.hostId, id));
    await handle!.db.delete(hostDaemons).where(eq(hostDaemons.hostId, id));
    await service.configure(id, daemonSettingsSchema.parse({ enabled: true }));
    generation = (
      await service.connect(id, {
        instance_id: randomUUID(),
        username: 'root',
        version: 'fixture',
        engines: ['codex', 'claude', 'grok'],
        error: null,
      })
    ).generation;
  });
  afterEach(async () => {
    const addresses = await handle!.db.select().from(agentBusAddresses).where(eq(agentBusAddresses.hostId, id));
    for (const address of addresses) {
      await handle!.db.delete(agentBusMessages).where(or(eq(agentBusMessages.targetAddressId, address.id), eq(agentBusMessages.senderAddressId, address.id)));
      await handle!.db.delete(agentBusConversations).where(or(eq(agentBusConversations.addressAId, address.id), eq(agentBusConversations.addressBId, address.id)));
    }
    await handle!.db.delete(agentBusRelays).where(eq(agentBusRelays.hostId, id));
    await handle!.db.delete(agentSessions).where(eq(agentSessions.hostId, id));
    await handle!.db.delete(agentBusAddresses).where(eq(agentBusAddresses.hostId, id));
  });
  afterAll(async () => {
    await handle!.db.delete(hostDaemonSessions).where(eq(hostDaemonSessions.hostId, id));
    await handle!.db.delete(hostDaemons).where(eq(hostDaemons.hostId, id));
    await handle!.db.delete(hosts).where(eq(hosts.id, id));
    await handle!.pool.end();
  });

  const host = async () => (await handle!.db.select().from(hosts).where(eq(hosts.id, id)))[0]!;
  const registerDaemonRelay = async () => {
    const relay = await messaging.registerRelay(await host(), {
      username: 'root:daemon',
      instanceId: randomUUID(),
      wrapperVersion: 'fixture',
      capabilities: { host_daemon: true, execution_contract_version: 2 },
    });
    return { relayId: String(relay.relay_id), token: String(relay.relay_token) };
  };
  const actor = async (username: string, engine: 'codex' | 'claude' | 'grok' = 'codex') => {
    const sessionId = randomUUID(),
      token = randomBytes(32).toString('base64url');
    const registered = await messaging.registerSession(await host(), {
      engine,
      sessionId,
      bridgeToken: token,
      upstreamSessionId: randomUUID(),
      username,
      cwd: '/tmp',
      invocationKind: 'interactive',
      adapterProtocol: 'test-live-v1',
      adapterCapabilities: { execution_contract_version: 2 },
    });
    return { sessionId, token, address: registered.address as { id: string; address: string } };
  };
  /** An idle remote-start session bound to a dormant mailbox with one queued peer message. */
  const idleRemoteSessionWithMail = async (engine: 'codex' | 'claude' | 'grok' = 'codex') => {
    await service.start(
      { host_id: id, engine, cwd: '/tmp', title: 'Fixture', prompt: 'Fixture', client_message_id: randomUUID() },
      'fixture-owner',
    );
    const op = (await service.offer(id, generation))!;
    await service.accept(id, op.operation_id, op.claim_id);
    await service.complete(id, op.operation_id, op.claim_id, { status: 'completed', reply: 'Idle' });
    const sender = await actor('fixture-sender'),
      target = await actor('root', engine);
    await handle!.db
      .update(hostDaemonSessions)
      .set({ addressId: target.address.id, sessionId: target.sessionId })
      .where(eq(hostDaemonSessions.id, op.session_id));
    await messaging.finishSession(target.sessionId, target.token, 'completed');
    await messaging.sendMessage(sender.sessionId, sender.token, {
      to: target.address.address,
      content: 'Resume fixture',
      clientMessageId: randomUUID(),
    });
    return { sessionId: op.session_id, target };
  };

  it('keeps an enabled daemon relay heartbeating and claiming', async () => {
    await idleRemoteSessionWithMail();
    const relay = await registerDaemonRelay();
    await expect(messaging.heartbeatRelay(relay.relayId, relay.token)).resolves.toMatchObject({ enabled: true });
    await expect(messaging.claimForRelay(relay.relayId, relay.token, randomUUID())).resolves.toMatchObject({
      message_id: expect.any(String),
    });
  });

  it.each(['codex', 'claude', 'grok'] as const)('binds an accepted %s daemon delivery to its exact native user and transcript', async (engine) => {
    const { target } = await idleRemoteSessionWithMail(engine);
    const relay = await registerDaemonRelay();
    const claimId = randomUUID();
    const delivery = await messaging.claimForRelay(relay.relayId, relay.token, claimId);
    if (!delivery) throw new Error('Peer fixture was not leased');
    await messaging.acknowledgeRelayDelivery(relay.relayId, relay.token, delivery.message_id, { claimId, outcome: 'accepted' });
    const childId = randomUUID(), bridgeToken = randomBytes(32).toString('base64url');
    const registration = {
      engine, username: 'root', cwd: '/tmp', sessionId: childId, bridgeToken,
      invocationKind: 'peer_delivery' as const, requestedAddress: target.address.address,
      expectedBindingGeneration: Number(delivery.target.binding_generation),
      upstreamSessionId: String(delivery.target.upstream_session_id), continuity: 'native' as const,
      deliveryMessageId: delivery.message_id, deliveryClaimId: claimId,
      adapterCapabilities: { execution_contract_version: 2, launch_identity_version: 1 },
    };
    await expect(messaging.registerSession(await host(), { ...registration, deliveryClaimId: randomUUID() }))
      .rejects.toMatchObject({ code: 'agent_messaging_lease_lost' });
    const [storedRelay] = await handle!.db.select().from(agentBusRelays).where(eq(agentBusRelays.id, relay.relayId));
    for (const patch of [
      { generation: storedRelay!.generation + 1 },
      { capabilities: { host_daemon: false } },
      { username: 'root:daemon:daemon' },
    ]) {
      await handle!.db.update(agentBusRelays).set(patch).where(eq(agentBusRelays.id, relay.relayId));
      await expect(messaging.registerSession(await host(), registration))
        .rejects.toMatchObject({ code: 'agent_messaging_lease_lost' });
      await handle!.db.update(agentBusRelays).set({ generation: storedRelay!.generation,
        capabilities: storedRelay!.capabilities, username: storedRelay!.username }).where(eq(agentBusRelays.id, relay.relayId));
    }
    const registered = await messaging.registerSession(await host(), registration);
    expect(registered.address).toMatchObject({ id: target.address.id, username: 'root',
      binding_generation: Number(delivery.target.binding_generation) + 1 });
    const identity = await messaging.self(childId, bridgeToken);
    expect(identity).toMatchObject({ session_id: childId, uuid: target.address.id,
      native_session_id: delivery.target.upstream_session_id });
    await messaging.renewRelayDelivery(relay.relayId, relay.token, delivery.message_id, claimId);
    await messaging.finishSession(childId, bridgeToken, 'completed');
    await messaging.acknowledgeRelayDelivery(relay.relayId, relay.token, delivery.message_id,
      { claimId, outcome: 'completed', upstreamSessionId: String(delivery.target.upstream_session_id) });
  });

  it('refuses heartbeat and claim of an idle daemon relay once the operator disables the daemon', async () => {
    const relay = await registerDaemonRelay();
    await expect(messaging.heartbeatRelay(relay.relayId, relay.token)).resolves.toMatchObject({ enabled: true });
    await service.configure(id, daemonSettingsSchema.parse({ enabled: false }));
    await expect(messaging.heartbeatRelay(relay.relayId, relay.token)).rejects.toMatchObject({ status: 403, message: 'Daemon relay is not enabled' });
    await expect(messaging.claimForRelay(relay.relayId, relay.token, randomUUID())).rejects.toMatchObject({
      status: 403,
      message: 'Daemon relay is not enabled',
    });
    // Re-enabling admits the same, still-unexpired registration again.
    await service.configure(id, daemonSettingsSchema.parse({ enabled: true }));
    await expect(messaging.heartbeatRelay(relay.relayId, relay.token)).resolves.toMatchObject({ enabled: true });
  });

  it('refuses an idle daemon relay after a timed deadline or under a migration fence', async () => {
    const relay = await registerDaemonRelay();
    const [row] = await handle!.db.select().from(hostDaemons).where(eq(hostDaemons.hostId, id));
    await handle!.db
      .update(hostDaemons)
      .set({ settings: { ...row!.settings, expires_at: new Date(Date.now() - 1000).toISOString() } })
      .where(eq(hostDaemons.hostId, id));
    await expect(messaging.heartbeatRelay(relay.relayId, relay.token)).rejects.toMatchObject({ status: 403, message: 'Daemon relay is not enabled' });
    await handle!.db.update(hostDaemons).set({ settings: row!.settings }).where(eq(hostDaemons.hostId, id));
    const requestId = randomUUID();
    await service.migration(id, requestId, 'fence');
    await expect(messaging.claimForRelay(relay.relayId, relay.token, randomUUID())).rejects.toMatchObject({
      status: 403,
      message: 'Daemon relay is not enabled',
    });
    await service.migration(id, requestId, 'release');
    await expect(messaging.heartbeatRelay(relay.relayId, relay.token)).resolves.toMatchObject({ enabled: true });
  });

  it('keeps a draining daemon relay alive until its leased work is finished, without new work', async () => {
    const { target } = await idleRemoteSessionWithMail();
    const relay = await registerDaemonRelay();
    const delivery = await messaging.claimForRelay(relay.relayId, relay.token, randomUUID());
    if (!delivery) throw new Error('Peer fixture was not leased');
    await service.configure(id, daemonSettingsSchema.parse({ enabled: false }));
    // In-flight: heartbeat keeps the token valid so the result can still be recorded,
    // and a claim yields nothing new instead of failing the wrapper's shared poll context.
    await expect(messaging.heartbeatRelay(relay.relayId, relay.token)).resolves.toMatchObject({ enabled: true });
    await expect(messaging.claimForRelay(relay.relayId, relay.token, randomUUID())).resolves.toBeNull();
    await expect(
      messaging.acknowledgeRelayDelivery(relay.relayId, relay.token, delivery.message_id, {
        claimId: delivery.claim_id,
        outcome: 'dead',
        errorCode: 'fixture_drained',
      }),
    ).resolves.toBeTruthy();
    await handle!.db
      .update(hostDaemonSessions)
      .set({ status: 'closed', activeMessageId: null })
      .where(eq(hostDaemonSessions.addressId, target.address.id));
    await expect(messaging.heartbeatRelay(relay.relayId, relay.token)).rejects.toMatchObject({ status: 403, message: 'Daemon relay is not enabled' });
  });
});
