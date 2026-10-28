import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { drizzle } from 'drizzle-orm/mysql2';
import { eq, inArray, or } from 'drizzle-orm';
import { getTestDb } from '../../helpers/test-db.js';
import { testKeyring } from '../../helpers/test-keyring.js';
import * as schema from '../../../src/db/schema.js';
import type { Env } from '../../../src/env.js';
import { ControlPlaneOwnership } from '../../../src/control-plane/owner.js';
import { OwnerPersistence } from '../../../src/control-plane/persistence.js';
import { CommandExecutor } from '../../../src/control-plane/commands.js';
import { DeadlineQueue } from '../../../src/control-plane/deadlines.js';
import { ConnectionPresence, bindOwnerPresence } from '../../../src/control-plane/presence.js';
import { hydrateOwnerState } from '../../../src/control-plane/state/hydrate.js';
import { bindOwnerRuntime, mutateOwnerState, type OwnerRuntime } from '../../../src/control-plane/state/runtime.js';
import { registerOwnedMessagingSession } from '../../../src/control-plane/state/session-registration.js';
import { stageUpdate } from '../../../src/control-plane/state/rows.js';
import { AgentMessagingService } from '../../../src/services/agent-messaging.js';
import { sha256 } from '../../../src/security/hash.js';
import { ENGINES } from '../../../src/util/engine.js';

/**
 * Open-or-join on the control-plane owner path, which is what production runs.
 * The SQL fallback has its own suite in agent-messaging/conference.test.ts.
 */
const handle = await getTestDb();
describe.skipIf(!handle)('conference open-or-join on the owner runtime', () => {
  afterAll(async () => {
    await handle?.pool.end();
  });

  it('converges concurrent callers on one room, keeps strangers out, and releases the key with the room', async () => {
    const keyring = testKeyring(),
      suffix = randomUUID().slice(0, 8),
      now = new Date().toISOString();
    const env = { AGENT_PORTAL_BRIDGE_TTL_SECONDS: 3600 } as Env;
    const owner = new ControlPlaneOwnership(handle!.pool, 'owner_conference_rdv_test'),
      deadlines = new DeadlineQueue((error) => {
        throw error;
      });
    const ids: string[] = [],
      addresses: string[] = [],
      commands: string[] = [],
      conferences = new Set<string>();
    let close: (() => Promise<void>) | undefined, presence: ConnectionPresence | undefined;
    const [inserted] = await handle!.db.insert(schema.hosts).values({
      fqdn: `conf-rdv-${suffix}.test`,
      apiKey: 'fixture-host-key',
      apiKeyHash: sha256('fixture-host-key'),
      secure: 1,
      status: 'active',
      engines: ENGINES.join(','),
      createdAt: now,
      updatedAt: now,
    });
    const hostId = Number(inserted.insertId);
    const [host] = await handle!.db.select().from(schema.hosts).where(eq(schema.hosts.id, hostId));
    const names = Array.from({ length: 12 }, (_, n) => ({
      nameKey: `rdv-${suffix}-${n}`,
      name: `Rdv ${suffix} ${n}`,
      currentSessionId: null,
    }));
    await handle!.db.insert(schema.agentNamePool).values(names);
    const [previousFlag] = await handle!.db
      .select()
      .from(schema.versions)
      .where(eq(schema.versions.name, 'agent_messaging_enabled'));
    await handle!.db
      .insert(schema.versions)
      .values({ name: 'agent_messaging_enabled', version: '1', updatedAt: now })
      .onDuplicateKeyUpdate({ set: { version: '1' } });
    try {
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
        committed(receipt) {
          commands.push(receipt.id);
        },
      });
      close = () => executor.drain();
      const runtime: OwnerRuntime = {
        state: store,
        deadlines,
        assertOwner: () => owner.assertReady(),
        execute: (command) => executor.execute(command),
      };
      bindOwnerRuntime(handle!.db, runtime);
      presence = new ConnectionPresence((error) => {
        throw error;
      });
      bindOwnerPresence(runtime, presence);
      const bus = new AgentMessagingService(handle!.db, env, keyring);

      /** A live, listening agent: bound session, session presence and a receiver generation. */
      const agent = async (engine: (typeof ENGINES)[number], cwd: string) => {
        const id = randomUUID(),
          token = `fixture-bridge-${randomUUID()}-${randomUUID()}`,
          native = randomUUID(),
          generation = randomUUID();
        ids.push(id);
        await registerOwnedMessagingSession(
          runtime,
          host!,
          {
            sessionId: id,
            bridgeToken: token,
            engine,
            username: 'fixture',
            cwd,
            invocationKind: 'interactive' as const,
            upstreamSessionId: native,
            adapterProtocol: 'fixture-v1',
            adapterCapabilities: {
              launch_identity_version: 1,
              control_state_protocol: 1,
              execution_contract_version: 2,
            },
          },
          env,
        );
        const address = store.snapshot().sessions.get(id)!.agentBusAddressId!;
        addresses.push(address);
        await mutateOwnerState(runtime, {
          kind: 'fixture.receiver',
          payload: { id },
          prepare(ctx) {
            stageUpdate(ctx, 'agentSessions', id, {
              receiver: {
                generation,
                protocol: 'codex-queue-v1',
                native_session_id: native,
                heartbeat_at: new Date().toISOString(),
                failure: null,
                probes: { peer: {} },
              },
            });
            return null;
          },
        });
        presence!.attach({
          connectionId: randomUUID(),
          hostId,
          username: 'fixture',
          scope: { topic: 'session', session_id: id, binding_generation: 1 },
        });
        presence!.attach({
          connectionId: randomUUID(),
          hostId,
          username: 'fixture',
          scope: { topic: 'receiver', session_id: id, binding_generation: 1, receiver_generation: generation },
        });
        return { id, token, address };
      };
      const openOrJoin = (who: { id: string; token: string }, topic: string) =>
        bus.openConference(who.id, who.token, { topic, joinExisting: true });
      const liveRooms = () =>
        store
          .snapshot()
          .table('agentBusConferences')
          .all()
          .filter((room) => addresses.includes(room.ownerAddressId) && room.status === 'open');

      const shared = `/fixture/${suffix}/shared`;
      const racers = await Promise.all(ENGINES.flatMap((engine) => [agent(engine, shared), agent(engine, shared)]));
      const topics = ['Discuss together and agree', ' discuss  TOGETHER and agree'];
      const answers = await Promise.all(racers.map((who, n) => openOrJoin(who, topics[n % 2]!)));
      for (const answer of answers) conferences.add(String(answer.conference_id));

      // One room, one chair, everybody else a PIN-less participant of it.
      expect(new Set(answers.map((answer) => answer.conference_id)).size).toBe(1);
      expect(answers.filter((answer) => answer.role === 'owner')).toHaveLength(1);
      const joined = answers.filter((answer) => answer.joined === true);
      expect(joined).toHaveLength(racers.length - 1);
      for (const answer of joined) expect(answer).toMatchObject({ role: 'participant', reused: true, pin: null });
      const chairAnswer = answers.find((answer) => answer.role === 'owner')!;
      expect(String(chairAnswer.pin)).toMatch(/^[0-9]{4}$/);
      const conferenceId = String(chairAnswer.conference_id);
      expect(liveRooms()).toHaveLength(1);
      expect(store.snapshot().table('agentBusConferences').get(conferenceId)?.rendezvousKey).toMatch(/^[0-9a-f]{64}$/);
      expect((await bus.conferenceRoster(racers[0]!.id, racers[0]!.token, conferenceId)).members).toHaveLength(
        racers.length,
      );

      // Asking again is idempotent: no second HELLO is charged.
      const peer = racers[answers.findIndex((answer) => answer.joined === true)]!;
      const before = store
        .snapshot()
        .table('agentBusConferenceMembers')
        .by('addressId', peer.address)
        .find((member) => member.conferenceId === conferenceId)!.messageCount;
      expect(await openOrJoin(peer, 'Discuss together and agree')).toMatchObject({ joined: true, conference_id: conferenceId });
      expect(
        store
          .snapshot()
          .table('agentBusConferenceMembers')
          .by('addressId', peer.address)
          .find((member) => member.conferenceId === conferenceId)!.messageCount,
      ).toBe(before);

      // Another repository identity, a looser topic and a never-invited stranger all stay out.
      const elsewhere = await agent('claude', `/fixture/${suffix}/elsewhere`);
      const otherRepo = await openOrJoin(elsewhere, 'Discuss together and agree');
      conferences.add(String(otherRepo.conference_id));
      expect(otherRepo).toMatchObject({ joined: false, role: 'owner' });
      expect(otherRepo.conference_id).not.toBe(conferenceId);
      const looser = await agent('codex', shared);
      const looseAnswer = await openOrJoin(looser, 'Discuss together');
      conferences.add(String(looseAnswer.conference_id));
      expect(looseAnswer).toMatchObject({ joined: false, role: 'owner' });
      expect(looseAnswer.conference_id).not.toBe(conferenceId);

      // A room opened without join_existing carries no key and is never joined this way.
      const privateChair = await agent('claude', shared);
      const privateRoom = await bus.openConference(privateChair.id, privateChair.token, { topic: 'Private sync' });
      conferences.add(String(privateRoom.conference_id));
      expect(store.snapshot().table('agentBusConferences').get(String(privateRoom.conference_id))?.rendezvousKey).toBeNull();
      const outsider = await agent('grok', shared);
      const outsideAnswer = await openOrJoin(outsider, 'Private sync');
      conferences.add(String(outsideAnswer.conference_id));
      expect(outsideAnswer).toMatchObject({ joined: false, role: 'owner' });
      expect(outsideAnswer.conference_id).not.toBe(privateRoom.conference_id);
      expect(
        store.snapshot().table('agentBusConferenceMembers').by('conferenceId', String(privateRoom.conference_id)),
      ).toHaveLength(1);

      // The topic is the whole key.
      await expect(bus.openConference(outsider.id, outsider.token, { joinExisting: true })).rejects.toMatchObject({
        status: 422,
      });

      // Adjourning releases the key: the topic can be convened again, in a new room.
      const chair = racers[answers.findIndex((answer) => answer.role === 'owner')]!;
      await bus.adjournConference(chair.id, chair.token, { conferenceId, force: true });
      const late = await agent('codex', shared);
      const reconvened = await openOrJoin(late, 'Discuss together and agree');
      conferences.add(String(reconvened.conference_id));
      expect(reconvened).toMatchObject({ joined: false, role: 'owner' });
      expect(reconvened.conference_id).not.toBe(conferenceId);
    } finally {
      await close?.();
      presence?.close();
      deadlines.close();
      await owner.close();
      if (commands.length)
        await handle!.db
          .delete(schema.controlPlaneCommandReceipts)
          .where(inArray(schema.controlPlaneCommandReceipts.requestId, commands));
      if (addresses.length) {
        await handle!.db
          .delete(schema.agentBusConferenceMembers)
          .where(inArray(schema.agentBusConferenceMembers.addressId, addresses));
        await handle!.db
          .delete(schema.agentBusConferences)
          .where(inArray(schema.agentBusConferences.ownerAddressId, addresses));
        const messages = await handle!.db
          .select({ id: schema.agentBusMessages.id, conversationId: schema.agentBusMessages.conversationId })
          .from(schema.agentBusMessages)
          .where(
            or(
              inArray(schema.agentBusMessages.senderAddressId, addresses),
              inArray(schema.agentBusMessages.targetAddressId, addresses),
            ),
          );
        if (messages.length) {
          await handle!.db.delete(schema.agentTaskResults).where(
            inArray(
              schema.agentTaskResults.messageId,
              messages.map((row) => row.id),
            ),
          );
          await handle!.db.delete(schema.agentBusMessages).where(
            inArray(
              schema.agentBusMessages.id,
              messages.map((row) => row.id),
            ),
          );
          await handle!.db.delete(schema.agentBusConversations).where(
            inArray(
              schema.agentBusConversations.id,
              messages.map((row) => row.conversationId),
            ),
          );
        }
      }
      if (conferences.size)
        await handle!.db
          .delete(schema.agentBusConferences)
          .where(inArray(schema.agentBusConferences.id, [...conferences]));
      if (ids.length) {
        await handle!.db.delete(schema.agentNameLeases).where(inArray(schema.agentNameLeases.sessionId, ids));
        await handle!.db.delete(schema.agentSessions).where(inArray(schema.agentSessions.id, ids));
        await handle!.db
          .update(schema.agentNamePool)
          .set({ currentSessionId: null })
          .where(inArray(schema.agentNamePool.currentSessionId, ids));
      }
      if (addresses.length)
        await handle!.db
          .delete(schema.agentBusAddresses)
          .where(inArray(schema.agentBusAddresses.id, addresses));
      await handle!.db.delete(schema.agentNamePool).where(
        inArray(
          schema.agentNamePool.nameKey,
          names.map((row) => row.nameKey),
        ),
      );
      await handle!.db.delete(schema.hosts).where(eq(schema.hosts.id, hostId));
      if (previousFlag)
        await handle!.db
          .update(schema.versions)
          .set({ version: previousFlag.version })
          .where(eq(schema.versions.name, previousFlag.name));
      else
        await handle!.db.delete(schema.versions).where(eq(schema.versions.name, 'agent_messaging_enabled'));
    }
  });
});
