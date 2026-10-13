import { createHash, randomUUID, randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  hosts,
  hostDaemons,
  hostDaemonOperations,
  hostDaemonSessions,
  versions,
  agentBusMessages,
  agentSessions,
  agentBusAddresses,
  agentBusRelays,
} from '../../../src/db/schema.js';
import { AgentMessagingService } from '../../../src/services/agent-messaging.js';
import { HostDaemonService } from '../../../src/services/host-daemon/service.js';
import { daemonSettingsSchema } from '../../../src/services/host-daemon/policy.js';
import { getTestDb } from '../../helpers/test-db.js';
import { loadTestEnv, testKeyring } from '../../helpers/test-keyring.js';

const handle = await getTestDb();
describe.skipIf(!handle)('resident migration admission with MySQL', () => {
  let id: number, service: HostDaemonService, generation: string;
  beforeAll(async () => {
    const stamp = new Date().toISOString(),
      fqdn = `resident-fence-${randomUUID()}.test`;
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
  });
  beforeEach(async () => {
    await handle!.db.delete(hostDaemonSessions).where(eq(hostDaemonSessions.hostId, id));
    await handle!.db.delete(hostDaemons).where(eq(hostDaemons.hostId, id));
    await service.configure(id, daemonSettingsSchema.parse({ enabled: true, resident_enabled: true }));
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
  afterAll(async () => {
    await handle!.db.delete(hosts).where(eq(hosts.id, id));
    await handle!.pool.end();
  });
  const launch = async () => {
    await service.start(
      {
        host_id: id,
        engine: 'codex',
        cwd: '/tmp',
        title: 'Fixture',
        prompt: 'Fixture',
        client_message_id: randomUUID(),
      },
      'fixture-owner',
    );
    return (await service.offer(id, generation))!;
  };

  it('refuses an already-offered operation after the migration fence commits', async () => {
    const op = await launch(),
      requestId = randomUUID();
    expect(await service.migration(id, requestId, 'fence')).toMatchObject({ fenced: true, ready: true });
    await expect(service.accept(id, op.operation_id, op.claim_id)).rejects.toThrow('No work slot');
    const stored = (
      await handle!.db.select().from(hostDaemonOperations).where(eq(hostDaemonOperations.id, op.operation_id))
    )[0]!;
    expect(stored.status).toBe('offered');
    expect((await service.session(op.session_id)).status).toBe('queued');
    await service.migration(id, requestId, 'release');
    expect(await service.offer(id, generation)).toMatchObject({
      operation_id: op.operation_id,
      claim_id: op.claim_id,
    });
    await expect(service.accept(id, op.operation_id, op.claim_id)).resolves.toEqual({ accepted: true });
  });

  it('retains accepted results, residence and the fence across a legacy settings update', async () => {
    const op = await launch(),
      requestId = randomUUID();
    await service.accept(id, op.operation_id, op.claim_id);
    expect(await service.migration(id, requestId, 'fence')).toMatchObject({
      ready: false,
      running: 1,
      accepted: 1,
    });
    await expect(service.accept(id, op.operation_id, op.claim_id)).resolves.toEqual({ accepted: true });
    await service.configure(id, daemonSettingsSchema.parse({ enabled: true }));
    expect((await service.settings(id)).settings).toMatchObject({
      resident_enabled: true,
      migration: { request_id: requestId, fenced: true },
    });
    await service.complete(id, op.operation_id, op.claim_id, {
      status: 'completed',
      reply: 'Retained result',
    });
    expect((await service.session(op.session_id)).status).toBe('idle');
    expect(await service.migration(id, requestId, 'status')).toMatchObject({ ready: true });
    await expect(service.turn(op.session_id, 'New turn', randomUUID(), 'fixture-owner')).rejects.toThrow();
    await expect(service.migration(id, randomUUID(), 'release')).rejects.toThrow('Another migration');
  });

  it('counts a leased peer message even when its native session is idle', async () => {
    const op = await launch(),
      requestId = randomUUID(),
      address = randomUUID(),
      message = randomUUID();
    await service.accept(id, op.operation_id, op.claim_id);
    await service.complete(id, op.operation_id, op.claim_id, { status: 'completed', reply: 'Idle' });
    await handle!.db
      .update(hostDaemonSessions)
      .set({ addressId: address })
      .where(eq(hostDaemonSessions.id, op.session_id));
    const stamp = new Date().toISOString();
    await handle!.db.insert(agentBusMessages).values({
      id: message,
      conversationId: randomUUID(),
      sequence: 1,
      senderAddressId: randomUUID(),
      targetAddressId: address,
      sourceEngine: 'codex',
      targetEngine: 'codex',
      contentEnc: 'fixture',
      contentBytes: 7,
      clientMessageId: randomUUID(),
      status: 'leased',
      nextAttemptAt: stamp,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      createdAt: stamp,
      updatedAt: stamp,
    });
    try {
      expect(await service.migration(id, requestId, 'fence')).toMatchObject({
        ready: false,
        running: 0,
        accepted: 0,
        peer_claims: 1,
      });
      await handle!.db
        .update(agentBusMessages)
        .set({ status: 'completed' })
        .where(eq(agentBusMessages.id, message));
      expect(await service.migration(id, requestId, 'status')).toMatchObject({ ready: true, peer_claims: 0 });
    } finally {
      await handle!.db.delete(agentBusMessages).where(eq(agentBusMessages.id, message));
    }
  });

  it('refuses a leased peer acceptance after fencing while retaining its claim', async () => {
    const messaging = new AgentMessagingService(handle!.db, loadTestEnv(), testKeyring());
    const [host] = await handle!.db.select().from(hosts).where(eq(hosts.id, id));
    const actor = async (username: string) => {
      const sessionId = randomUUID(),
        token = randomBytes(32).toString('base64url');
      const registered = await messaging.registerSession(host!, {
        engine: 'codex',
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
    const sender = await actor('fixture-sender'),
      target = await actor('root');
    const op = await launch();
    await service.accept(id, op.operation_id, op.claim_id);
    await service.complete(id, op.operation_id, op.claim_id, { status: 'completed', reply: 'Idle' });
    await handle!.db
      .update(hostDaemonSessions)
      .set({ addressId: target.address.id, sessionId: target.sessionId })
      .where(eq(hostDaemonSessions.id, op.session_id));
    await messaging.finishSession(target.sessionId, target.token, 'completed');
    const relay = await messaging.registerRelay(host!, {
      username: 'root:daemon',
      instanceId: randomUUID(),
      wrapperVersion: 'fixture',
      capabilities: { host_daemon: true, execution_contract_version: 2 },
    });
    try {
      await messaging.sendMessage(sender.sessionId, sender.token, {
        to: target.address.address,
        content: 'Resume fixture',
        clientMessageId: randomUUID(),
      });
      const delivery = await messaging.claimForRelay(
        String(relay.relay_id),
        String(relay.relay_token),
        randomUUID(),
      );
      if (!delivery) throw new Error('Peer fixture was not leased');
      const requestId = randomUUID();
      expect(await service.migration(id, requestId, 'fence')).toMatchObject({ ready: false, peer_claims: 1 });
      await expect(
        messaging.acknowledgeRelayDelivery(
          String(relay.relay_id),
          String(relay.relay_token),
          delivery.message_id,
          { claimId: delivery.claim_id, outcome: 'accepted' },
        ),
      ).rejects.toMatchObject({ code: 'daemon_disabled' });
      const [stored] = await handle!.db
        .select()
        .from(agentBusMessages)
        .where(eq(agentBusMessages.id, delivery.message_id));
      expect(stored).toMatchObject({ status: 'leased', claimId: delivery.claim_id });
      await service.migration(id, requestId, 'release');
      await expect(
        messaging.acknowledgeRelayDelivery(
          String(relay.relay_id),
          String(relay.relay_token),
          delivery.message_id,
          { claimId: delivery.claim_id, outcome: 'accepted' },
        ),
      ).resolves.toMatchObject({ message: { id: delivery.message_id, status: 'accepted' } });
    } finally {
      await handle!.db
        .delete(agentBusMessages)
        .where(eq(agentBusMessages.targetAddressId, target.address.id));
      await handle!.db.delete(agentBusRelays).where(eq(agentBusRelays.hostId, id));
      await handle!.db.delete(agentSessions).where(eq(agentSessions.hostId, id));
      await handle!.db.delete(agentBusAddresses).where(eq(agentBusAddresses.hostId, id));
    }
  });

  it('serializes competing acceptance and fencing without claiming a ready accepted owner', async () => {
    for (let n = 0; n < 16; n++) {
      const op = await launch(),
        requestId = randomUUID();
      const [acceptance, fence] = await Promise.allSettled([
        service.accept(id, op.operation_id, op.claim_id),
        service.migration(id, requestId, 'fence'),
      ]);
      if (fence.status !== 'fulfilled') throw fence.reason;
      const stored = (
        await handle!.db
          .select()
          .from(hostDaemonOperations)
          .where(eq(hostDaemonOperations.id, op.operation_id))
      )[0]!;
      if (acceptance.status === 'fulfilled') {
        expect(fence.value.ready).toBe(false);
        expect(stored.status).toBe('accepted');
        await service.complete(id, op.operation_id, op.claim_id, { status: 'completed', reply: 'Done' });
      } else {
        expect(fence.value.ready).toBe(true);
        expect(stored.status).toBe('offered');
      }
      await service.migration(id, requestId, 'release');
      await handle!.db.delete(hostDaemonSessions).where(eq(hostDaemonSessions.id, op.session_id));
    }
  });
});
