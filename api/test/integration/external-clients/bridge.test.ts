import { protectOwnerReadHandle, scopedDatabase } from '../../../src/db/fresh-read.js';
import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { drizzle } from 'drizzle-orm/mysql2';
import { eq } from 'drizzle-orm';
import { getTestDb } from '../../helpers/test-db.js';
import { testKeyring } from '../../helpers/test-keyring.js';
import * as schema from '../../../src/db/schema.js';
import type { Env } from '../../../src/env.js';
import { ControlPlaneOwnership } from '../../../src/control-plane/owner.js';
import { OwnerPersistence } from '../../../src/control-plane/persistence.js';
import { CommandExecutor } from '../../../src/control-plane/commands.js';
import { DeadlineQueue } from '../../../src/control-plane/deadlines.js';
import { ConnectionPresence, bindOwnerPresence } from '../../../src/control-plane/presence.js';
import { ConnectionCredentials } from '../../../src/control-plane/credentials.js';
import { hydrateOwnerState } from '../../../src/control-plane/state/hydrate.js';
import { bindOwnerRuntime, mutateOwnerState, type OwnerRuntime } from '../../../src/control-plane/state/runtime.js';
import { registerOwnedMessagingSession } from '../../../src/control-plane/state/session-registration.js';
import { AgentMessagingService } from '../../../src/services/agent-messaging.js';
import { ExternalClientsService } from '../../../src/services/external-clients/index.js';
import { ensureExternalHost } from '../../../src/ops/ensure-external-host.js';
import { sha256 } from '../../../src/security/hash.js';

const handle = await getTestDb();
describe.skipIf(!handle)('external clients over the owned messaging bus', () => {
  afterAll(async () => {
    await handle?.pool.end();
  });
  it('registers a virtual session, delivers FIFO with trust, acks, replies and reports results', async () => {
    const keyring = testKeyring(),
      suffix = randomUUID().slice(0, 8),
      now = new Date().toISOString();
    const env = { AGENT_PORTAL_BRIDGE_TTL_SECONDS: 3600 } as Env;
    const owner = new ControlPlaneOwnership(handle!.pool, `owner_external_${suffix}`),
      deadlines = new DeadlineQueue((error) => {
        throw error;
      });
    const sessionIds: string[] = [];
    let close: (() => Promise<void>) | undefined;
    const [inserted] = await handle!.db.insert(schema.hosts).values({
      fqdn: `external-peer-${suffix}.test`,
      apiKey: `k-${suffix}`,
      apiKeyHash: sha256(`k-${suffix}`),
      secure: 1,
      status: 'active',
      engines: 'claude',
      createdAt: now,
      updatedAt: now,
    });
    const hostId = Number(inserted.insertId);
    const [host] = await handle!.db.select().from(schema.hosts).where(eq(schema.hosts.id, hostId));
    await handle!.db.insert(schema.agentNamePool).values(
      Array.from({ length: 6 }, (_, n) => ({
        nameKey: `ext-${suffix}-${n}`,
        name: `Ext ${suffix} ${n}`,
        currentSessionId: null,
      })),
    );
    await handle!.db
      .insert(schema.versions)
      .values({ name: 'agent_messaging_enabled', version: '1', updatedAt: now })
      .onDuplicateKeyUpdate({ set: { version: '1' } });
    const clientIds: string[] = [];
    try {
      await ensureExternalHost(handle!.db);
      await owner.acquire();
      const { store } = await owner.hydrate((connection, epoch) =>
        hydrateOwnerState(drizzle(connection, { schema, mode: 'default' }), { epoch, sequence: 0n }),
      );
      owner.ready();
      const executor = new CommandExecutor({
        state: store,
        persistence: new OwnerPersistence(owner, keyring),
        assertOwner: () => owner.assertReady(),
        loseOwner: (error) => owner.lose(error),
        notificationError(error) {
          throw error;
        },
        committed() {},
      });
      close = () => executor.drain();
      const runtime: OwnerRuntime = {
        state: store,
        deadlines,
        assertOwner: () => owner.assertReady(),
        execute: (command) => executor.execute(command),
      };
      // Production hands services a handle that refuses writes outside an owner command.
      const guarded = scopedDatabase(handle!.db);
      bindOwnerRuntime(guarded, runtime);
      protectOwnerReadHandle(guarded);
      const presence = new ConnectionPresence((error) => {
        throw error;
      });
      bindOwnerPresence(runtime, presence);
      new ConnectionCredentials(runtime, presence, { session: 3_600_000, relay: 900_000 });
      const bus = new AgentMessagingService(guarded, env, keyring);
      const service = new ExternalClientsService(guarded, env, keyring);

      // A native peer that can receive.
      const peerId = randomUUID(),
        peerToken = `fixture-peer-${randomUUID()}-${randomUUID()}`,
        instance = randomUUID();
      sessionIds.push(peerId);
      await registerOwnedMessagingSession(
        runtime,
        host!,
        {
          engine: 'claude',
          username: 'fixture',
          cwd: '/fixture',
          invocationKind: 'interactive',
          sessionId: peerId,
          bridgeToken: peerToken,
          upstreamSessionId: randomUUID(),
          adapterProtocol: 'fixture-v1',
          adapterCapabilities: { launch_identity_version: 1, control_state_protocol: 1, execution_contract_version: 2 },
        },
        env,
      );
      const peerAddress = store.snapshot().sessions.get(peerId)!.agentBusAddressId!;
      await mutateOwnerState(runtime, {
        kind: 'fixture.native_control',
        payload: { peerId, instance },
        prepare(ctx) {
          const row = {
            sessionId: peerId,
            instanceId: instance,
            bindingGeneration: 1,
            requestId: null,
            clientMessageId: null,
            actorId: null,
            status: 'ready',
            updatedAt: now,
          };
          ctx.draft.upsert('agentNativeControls', row);
          ctx.write(async (tx) => {
            await tx.insert(schema.agentNativeControls).values(row);
          });
          return null;
        },
      });
      presence.attach({
        connectionId: randomUUID(),
        hostId,
        username: 'fixture',
        scope: { topic: 'session', session_id: peerId, binding_generation: 1, native_instance_id: instance },
      });

      // Admin lifecycle: a new client starts with the requested trust, key shown once.
      const created = await service.create({ name: `Jessica ${suffix}`, description: '  Hermes Bot\nvom `Owner`  ', trust: 'trusted' });
      clientIds.push(created.client.id);
      expect(created.key.startsWith('cxe_')).toBe(true);
      expect(created.client).toMatchObject({ trust: 'trusted', enabled: true, description: "Hermes Bot vom 'Owner'" });
      await expect(service.create({ name: `jessica ${suffix}` })).rejects.toThrow('already exists');
      const client = await service.authenticate(created.key);
      expect(client.id).toBe(created.client.id);
      await expect(service.authenticate('cxe_nope')).rejects.toMatchObject({ code: 'key_invalid' });

      // First poll registers the virtual session and finds nothing.
      expect(await service.bridge.poll(client, 0)).toBeNull();
      const row = (await handle!.db.select().from(schema.externalClients).where(eq(schema.externalClients.id, client.id)))[0]!;
      expect(row.sessionId).toBeTruthy();
      expect(row.addressId).toBeTruthy();
      const address = store.snapshot().addresses.get(row.addressId!)!;
      expect(address.engine).toBe('external');
      // The address carries the configured name, never a random pool name.
      expect(address.launchName).toBe(`Jessica ${suffix}`);

      // Peer -> external: arrives with server-stamped sender, redelivered until acked, then FIFO.
      const first = await bus.sendMessage(peerId, peerToken, {
        to: `agent:${row.addressId}`,
        content: 'first',
        clientMessageId: randomUUID(),
      });
      await bus.sendMessage(peerId, peerToken, {
        to: `agent:${row.addressId}`,
        content: 'second',
        clientMessageId: randomUUID(),
        conversationId: (first.message as { conversation_id: string }).conversation_id,
      });
      // A fresh message becomes claimable within a second (timestamps have second precision).
      const got = await service.bridge.poll(client, 5);
      expect(got?.content).toBe('first');
      const envelope = await service.envelope(got!);
      expect(envelope).toMatchObject({ kind: 'message', sender: { engine: 'claude', trust: 'peer' }, content: 'first' });
      expect((await service.bridge.poll(client, 0))?.message_id).toBe(got!.message_id); // not acked: again
      const acked = await service.bridge.ack(client, [got!.message_id]);
      expect(acked.acked).toEqual([got!.message_id]);
      expect((await service.bridge.ack(client, [got!.message_id])).acked).toEqual([got!.message_id]); // idempotent
      const next = await service.bridge.poll(client, 5);
      expect(next?.content).toBe('second');
      await service.bridge.ack(client, [next!.message_id]);
      expect(await service.bridge.poll(client, 0)).toBeNull();

      // Reply to the first message: the peer receives a reply from the external client.
      await service.bridge.reply(client, { clientMessageId: randomUUID(), replyTo: got!.message_id, content: 'answer' });
      const replyClaim = randomUUID();
      const replied = await bus.claimForSession(peerId, peerToken, replyClaim);
      expect(replied?.content).toContain('answer');
      expect(replied?.sender).toMatchObject({ engine: 'external' });
      await bus.acknowledgeSessionDelivery(peerId, peerToken, replied!.message_id, { claimId: replyClaim, outcome: 'completed' });

      // External -> peer: the peer sees engine external, and the envelope back carries the client's trust.
      const sent = await service.bridge.send(client, {
        clientMessageId: randomUUID(),
        to: `agent:${peerAddress}`,
        content: 'hello from outside',
      });
      expect(sent).toBeTruthy();
      const received = await bus.claimForSession(peerId, peerToken, randomUUID());
      expect(received?.content).toContain('hello from outside');
      // Native receivers get identity and trust as a server-written first line.
      expect(received?.content.startsWith('[from external client "Jessica')).toBe(true);
      expect(received?.content).toContain("(Hermes Bot vom 'Owner') · trust: trusted");
      expect(received?.sender).toMatchObject({ engine: 'external' });
      const back = await service.envelope(received!);
      expect(back.sender).toMatchObject({ engine: 'external', trust: 'trusted', description: "Hermes Bot vom 'Owner'" });

      // Discovery lists the native peer.
      const listed = (await service.bridge.agents(client, { includeOffline: true, limit: 50 })) as { agents: Array<{ address: string }> };
      expect(listed.agents.map((a) => a.address)).toContain(`agent:${peerAddress}`);

      // Oversized content is refused, never truncated.
      await expect(
        service.bridge.send(client, {
          clientMessageId: randomUUID(),
          to: `agent:${peerAddress}`,
          content: 'x'.repeat(32 * 1024 + 1),
        }),
      ).rejects.toMatchObject({ status: 413, code: 'content_too_large' });

      // Disabling ends access; rotating kills the old key.
      await service.update(client.id, { enabled: false });
      await expect(service.authenticate(created.key)).rejects.toMatchObject({ code: 'client_disabled' });
      // Disabling releases the reserved name; re-enabling takes it back on the next call.
      expect(store.snapshot().addresses.get(row.addressId!)?.launchName).toBeNull();
      await service.update(client.id, { enabled: true });
      await service.bridge.heartbeat(await service.authenticate(created.key));
      expect(store.snapshot().addresses.get(row.addressId!)?.launchName).toBe(`Jessica ${suffix}`);
      const rotated = await service.rotateKey(client.id);
      await expect(service.authenticate(created.key)).rejects.toMatchObject({ code: 'key_invalid' });
      expect((await service.authenticate(rotated.key)).id).toBe(client.id);
    } finally {
      await close?.();
      for (const id of clientIds) await handle!.db.delete(schema.externalClients).where(eq(schema.externalClients.id, id));
    }
  });
});
