import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { drizzle } from 'drizzle-orm/mysql2';
import { eq, inArray, or } from 'drizzle-orm';
import { getTestDb } from '../../helpers/test-db.js';
import { testKeyring } from '../../helpers/test-keyring.js';
import { installSqlBudget } from '../../helpers/sql-budget.js';
import * as schema from '../../../src/db/schema.js';
import type { Env } from '../../../src/env.js';
import { ControlPlaneOwnership } from '../../../src/control-plane/owner.js';
import { OwnerPersistence } from '../../../src/control-plane/persistence.js';
import { CommandExecutor } from '../../../src/control-plane/commands.js';
import { DeadlineQueue } from '../../../src/control-plane/deadlines.js';
import { ConnectionPresence, bindOwnerPresence } from '../../../src/control-plane/presence.js';
import { ConnectionCredentials } from '../../../src/control-plane/credentials.js';
import { hydrateOwnerState } from '../../../src/control-plane/state/hydrate.js';
import {
  bindOwnerRuntime,
  mutateOwnerState,
  type OwnerRuntime,
} from '../../../src/control-plane/state/runtime.js';
import { registerOwnedMessagingSession } from '../../../src/control-plane/state/session-registration.js';
import { updateOwnedSession } from '../../../src/control-plane/state/session-update.js';
import { stageSessionFinish } from '../../../src/control-plane/state/session-lifecycle.js';
import { stageUpdate } from '../../../src/control-plane/state/rows.js';
import { AgentMessagingService } from '../../../src/services/agent-messaging.js';
import { claimOwnedDelivery } from '../../../src/services/agent-messaging/owned-claim.js';
import { sha256 } from '../../../src/security/hash.js';
import { ENGINES } from '../../../src/util/engine.js';

const handle = await getTestDb();
describe.skipIf(!handle)('owned messaging lifecycle on MySQL', () => {
  afterAll(async () => {
    await handle?.pool.end();
  });
  it('registers all engines, keeps binding identity, performs SQL-free steady reads and commits finish/name changes atomically', async () => {
    const keyring = testKeyring(),
      suffix = randomUUID().slice(0, 8),
      now = new Date().toISOString();
    const env = { AGENT_PORTAL_BRIDGE_TTL_SECONDS: 3600 } as Env;
    const owner = new ControlPlaneOwnership(handle!.pool, 'owner_refactor_test'),
      deadlines = new DeadlineQueue((error) => {
        throw error;
      });
    const ids: string[] = [],
      addresses: string[] = [],
      commands: string[] = [],
      conferences: string[] = [];
    let close: (() => Promise<void>) | undefined,
      credentials: ConnectionCredentials | undefined,
      presence: ConnectionPresence | undefined;
    const budget = installSqlBudget(handle!.pool);
    const [inserted] = await handle!.db
      .insert(schema.hosts)
      .values({
        fqdn: `messaging-${suffix}.test`,
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
    const names = Array.from({ length: 8 }, (_, n) => ({
      nameKey: `fixture-${suffix}-${n}`,
      name: `Fixture ${suffix} ${n}`,
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
      credentials = new ConnectionCredentials(runtime, presence, { session: 3_600_000, relay: 900_000 });
      const bus = new AgentMessagingService(handle!.db, env, keyring);
      for (const engine of ENGINES) {
        const id = randomUUID(),
          token = `fixture-bridge-${randomUUID()}-${randomUUID()}`,
          native = randomUUID();
        ids.push(id);
        const input = {
          sessionId: id,
          bridgeToken: token,
          engine,
          username: 'fixture',
          cwd: '/fixture',
          invocationKind: 'interactive' as const,
          upstreamSessionId: native,
          adapterProtocol: 'fixture-v1',
          adapterCapabilities: {
            launch_identity_version: 1,
            control_state_protocol: 1,
            execution_contract_version: 2,
          },
        };
        const result = await registerOwnedMessagingSession(runtime, host!, input, env);
        const address = store.snapshot().sessions.get(id)!.agentBusAddressId!;
        addresses.push(address);
        expect(result).toMatchObject({
          session_id: id,
          name_status: 'assigned',
          capabilities: { control_state_protocol: 1 },
        });
        expect(store.snapshot().addresses.get(address)?.receiveHeartbeatAt).toBeNull();
        await registerOwnedMessagingSession(runtime, host!, input, env);
        expect(store.snapshot().sessions.get(id)?.agentBusAddressId).toBe(address);
        expect(store.snapshot().table('agentNameLeases').by('sessionId', id)).toHaveLength(1);
        presence.attach({
          connectionId: randomUUID(),
          hostId,
          username: 'fixture',
          scope: { topic: 'session', session_id: id, binding_generation: 1 },
        });
        budget.reset();
        for (let n = 0; n < 100; n++) {
          await bus.authenticateBridge(id, token);
          await updateOwnedSession(runtime, id, token, {});
        }
        expect(budget.snapshot()).toEqual([]);
        const competing = randomUUID();
        ids.push(competing);
        await expect(
          registerOwnedMessagingSession(runtime, host!, { ...input, sessionId: competing }, env),
        ).rejects.toThrow('already bound');
        expect(store.snapshot().sessions.has(competing)).toBe(false);
        const [failedRows] = await handle!.pool.query<import('mysql2').RowDataPacket[]>(
          'SELECT id FROM agent_sessions WHERE id=?',
          [competing],
        );
        expect(failedRows).toHaveLength(0);
        await mutateOwnerState(runtime, {
          kind: 'fixture.metadata',
          payload: { id },
          prepare(ctx) {
            stageUpdate(ctx, 'agentSessions', id, { status: 'waiting' });
            return null;
          },
        });
        await updateOwnedSession(runtime, id, token, { status: 'active' });
        expect(store.snapshot().sessions.get(id)?.status).toBe('active');
        const peerId = randomUUID(),
          peerToken = `fixture-peer-${randomUUID()}-${randomUUID()}`,
          instance = randomUUID();
        ids.push(peerId);
        await registerOwnedMessagingSession(
          runtime,
          host!,
          { ...input, sessionId: peerId, bridgeToken: peerToken, upstreamSessionId: randomUUID() },
          env,
        );
        const peerAddress = store.snapshot().sessions.get(peerId)!.agentBusAddressId!;
        addresses.push(peerAddress);
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
        let attached = presence.attach({
          connectionId: randomUUID(),
          hostId,
          username: 'fixture',
          scope: {
            topic: 'session',
            session_id: peerId,
            binding_generation: 1,
            native_instance_id: instance,
          },
        });
        budget.reset();
        for (let n = 0; n < 30; n++)
          expect(await bus.claimForSession(peerId, peerToken, randomUUID())).toBeNull();
        expect(budget.snapshot()).toEqual([]);
        const clientMessageId = randomUUID(),
          send = {
            to: `agent:${peerAddress}`,
            content: 'Perform exactly one fixture action',
            kind: 'request' as const,
            clientMessageId,
          };
        const sent = await bus.sendMessage(id, token, send),
          messageId = (sent.message as { id: string }).id;
        expect(sent.created).toBe(true);
        expect((await bus.sendMessage(id, token, send)).created).toBe(false);
        const conversationId = (sent.message as { conversation_id: string }).conversation_id;
        budget.reset();
        for (let n = 0; n < 30; n++) {
          expect((await bus.waitForMessages(id, token, conversationId, 0)).messages).toEqual([]);
          expect((await bus.waitForMessages(peerId, peerToken, conversationId, 1)).messages).toEqual([]);
          expect((await bus.peekMailbox(peerId, peerToken)).pending).toHaveLength(1);
        }
        expect(budget.snapshot()).toEqual([]);
        const claimId = randomUUID(),
          delivery = await bus.claimForSession(peerId, peerToken, claimId);
        expect(delivery).toMatchObject({
          message_id: messageId,
          claim_id: claimId,
          lease_until: null,
          ownership_mode: 'connection',
        });
        expect((await bus.claimForSession(peerId, peerToken, claimId))?.message_id).toBe(messageId);
        await bus.acknowledgeSessionDelivery(peerId, peerToken, messageId, { claimId, outcome: 'accepted' });
        budget.reset();
        for (let n = 0; n < 100; n++)
          expect(await bus.renewSessionDelivery(peerId, peerToken, messageId, claimId)).toMatchObject({
            lease_until: null,
            ownership_mode: 'connection',
          });
        expect(budget.snapshot()).toEqual([]);
        attached.detach();
        await expect(bus.claimForSession(peerId, peerToken, randomUUID())).rejects.toThrow('no longer owned');
        expect(store.snapshot().messages.get(messageId)?.status).toBe('accepted');
        // Result storage is exact-claim authority, not a request to execute again.
        const completion = {
          claimId,
          outcome: 'completed' as const,
          taskResult: { status: 'succeeded' as const, summary: 'One verified fixture action' },
        };
        await bus.acknowledgeSessionDelivery(peerId, peerToken, messageId, completion);
        await bus.acknowledgeSessionDelivery(peerId, peerToken, messageId, completion);
        expect(store.snapshot().messages.get(messageId)).toMatchObject({
          status: 'completed',
          taskResultStatus: 'succeeded',
        });
        expect(store.snapshot().table('agentTaskResults').by('messageId', messageId)).toHaveLength(1);
        expect(store.snapshot().messages.by('replyToMessageId', messageId)).toHaveLength(1);
        const incoming = await bus.waitForMessages(id, token, conversationId, 0);
        expect(incoming.messages).toHaveLength(1);
        budget.reset();
        expect(
          (await bus.waitForMessages(id, token, conversationId, Number(incoming.next_sequence))).messages,
        ).toEqual([]);
        expect(budget.snapshot()).toEqual([]);
        await expect(
          bus.acknowledgeSessionDelivery(peerId, peerToken, messageId, {
            ...completion,
            taskResult: { status: 'failed', summary: 'Different result' },
          }),
        ).rejects.toThrow('different payload');
        attached = presence.attach({
          connectionId: randomUUID(),
          hostId,
          username: 'fixture',
          scope: {
            topic: 'session',
            session_id: peerId,
            binding_generation: 1,
            native_instance_id: instance,
          },
        });
        expect(await bus.claimForSession(peerId, peerToken, claimId)).toBeNull();
        const nextSend = await bus.sendMessage(id, token, {
            ...send,
            clientMessageId: randomUUID(),
            content: 'Report progress, then finish once',
          }),
          nextId = (nextSend.message as { id: string }).id,
          nextClaim = randomUUID();
        expect((await bus.claimForSession(peerId, peerToken, nextClaim))?.message_id).toBe(nextId);
        await bus.acknowledgeSessionDelivery(peerId, peerToken, nextId, {
          claimId: nextClaim,
          outcome: 'accepted',
        });
        const progress = {
          claimId: nextClaim,
          clientMessageId: randomUUID(),
          content: 'Still running',
          queue: { delivery_class: 'progress' as const, coalesce_key: 'fixture-progress' },
        };
        expect((await bus.replyMessage(peerId, peerToken, nextId, progress)).created).toBe(true);
        expect(store.snapshot().messages.get(nextId)?.status).toBe('accepted');
        expect(store.snapshot().table('agentTaskResults').by('messageId', nextId)).toHaveLength(0);
        expect((await bus.replyMessage(peerId, peerToken, nextId, progress)).created).toBe(false);
        const finalReply = {
          claimId: nextClaim,
          clientMessageId: randomUUID(),
          content: 'Finished with evidence',
          taskResult: { status: 'succeeded' as const, summary: 'Verified final result' },
        };
        expect((await bus.replyMessage(peerId, peerToken, nextId, finalReply)).created).toBe(true);
        expect((await bus.replyMessage(peerId, peerToken, nextId, finalReply)).created).toBe(false);
        expect(store.snapshot().messages.get(nextId)).toMatchObject({
          status: 'completed',
          taskResultStatus: 'succeeded',
        });
        expect(store.snapshot().table('agentTaskResults').by('messageId', nextId)).toHaveLength(1);
        const informationalIds: string[] = [];
        for (const content of ['First informational original', 'Second informational original']) {
          const information = await bus.sendMessage(id, token, {
            to: `agent:${peerAddress}`,
            content,
            clientMessageId: randomUUID(),
          });
          informationalIds.push((information.message as { id: string }).id);
        }
        await mutateOwnerState(runtime, {
          kind: 'fixture.age_information',
          payload: { informationalIds },
          prepare(ctx) {
            for (const infoId of informationalIds)
              stageUpdate(ctx, 'agentBusMessages', infoId, {
                createdAt: new Date(Date.now() - 61_000).toISOString(),
              });
            return null;
          },
        });
        const batchClaim = randomUUID(),
          batch = await claimOwnedDelivery(handle!.db, runtime, keyring, {
            targetAddressIds: [peerAddress],
            leaseOwner: `session:${peerId}`,
            claimId: batchClaim,
            relayGeneration: null,
            skipReceiveCapable: false,
            informationalOnly: true,
            smartQueue: true,
            peerBatch: true,
          });
        expect(batch?.kind).toBe('digest');
        const presentation = JSON.parse(batch!.content);
        expect(presentation).toMatchObject({ presentation: 'peer_batch_v1', total: 2, next_after: null });
        expect(presentation.entries.map((entry: { message_id: string }) => entry.message_id)).toEqual(
          informationalIds,
        );
        expect(informationalIds.map((infoId) => store.snapshot().messages.get(infoId)?.status)).toEqual([
          'batched',
          'batched',
        ]);
        await bus.acknowledgeSessionDelivery(peerId, peerToken, batch!.message_id, {
          claimId: batchClaim,
          outcome: 'completed',
        });
        expect(informationalIds.map((infoId) => store.snapshot().messages.get(infoId)?.status)).toEqual([
          'digested',
          'digested',
        ]);
        const chairReceiver = randomUUID();
        await mutateOwnerState(runtime, {
          kind: 'fixture.receiver',
          payload: { id },
          prepare(ctx) {
            stageUpdate(ctx, 'agentSessions', id, {
              receiver: {
                generation: chairReceiver,
                protocol: 'codex-queue-v1',
                native_session_id: native,
                heartbeat_at: now,
                failure: null,
                probes: { peer: {} },
              },
            });
            return null;
          },
        });
        const chairAttachment = presence.attach({
          connectionId: randomUUID(),
          hostId,
          username: 'fixture',
          scope: {
            topic: 'receiver',
            session_id: id,
            binding_generation: 1,
            receiver_generation: chairReceiver,
          },
        });
        const opened = await bus.openConference(id, token, { topic: 'Fixture room', maxMembers: 2 }),
          conferenceId = String(opened.conference_id);
        conferences.push(conferenceId);
        expect((await bus.openConference(id, token, {})).conference_id).toBe(conferenceId);
        const invitation = await bus.inviteToConference(id, token, {
          conferenceId,
          to: [`agent:${peerAddress}`],
        });
        expect((invitation.results as Array<{ delivered: boolean }>)[0]?.delivered).toBe(true);
        const invitationClaim = randomUUID(),
          invitationDelivery = await bus.claimForSession(peerId, peerToken, invitationClaim);
        expect(invitationDelivery?.content).toContain('INVITE');
        await bus.acknowledgeSessionDelivery(peerId, peerToken, invitationDelivery!.message_id, {
          claimId: invitationClaim,
          outcome: 'completed',
        });
        await bus.joinConference(peerId, peerToken, { conferenceId, purpose: 'Test ownership' });
        budget.reset();
        for (let n = 0; n < 100; n++) {
          expect((await bus.conferenceRoster(id, token, conferenceId)).members).toHaveLength(2);
          expect((await bus.listConferences(peerId, peerToken)).conferences).toHaveLength(1);
          expect((await bus.openConference(id, token, {})).reused).toBe(true);
        }
        expect(budget.snapshot()).toEqual([]);
        const task = await bus.conferenceDispatch(id, token, {
            conferenceId,
            to: `agent:${peerAddress}`,
            task: 'One conference task',
          }),
          taskId = String(task.message_id),
          taskClaim = randomUUID();
        expect((await bus.claimForSession(peerId, peerToken, taskClaim))?.message_id).toBe(taskId);
        await bus.acknowledgeSessionDelivery(peerId, peerToken, taskId, {
          claimId: taskClaim,
          outcome: 'accepted',
        });
        const adjourned = await bus.adjournConference(id, token, { conferenceId, force: true });
        expect(adjourned).toMatchObject({ status: 'adjourned', uncertain_deliveries: 1 });
        expect(store.snapshot().messages.get(taskId)).toMatchObject({
          status: 'ambiguous',
          claimId: taskClaim,
          leaseOwner: `session:${peerId}`,
        });
        const late = {
          claimId: taskClaim,
          outcome: 'completed' as const,
          taskResult: { status: 'succeeded' as const, summary: 'Finished original task after cancellation' },
        };
        await bus.acknowledgeSessionDelivery(peerId, peerToken, taskId, late);
        expect(store.snapshot().messages.get(taskId)).toMatchObject({
          status: 'ambiguous',
          taskResultStatus: 'succeeded',
        });
        expect(store.snapshot().table('agentTaskResults').by('messageId', taskId)).toHaveLength(1);
        await bus.acknowledgeSessionDelivery(peerId, peerToken, taskId, late);
        expect(await bus.claimForSession(peerId, peerToken, taskClaim)).toBeNull();
        chairAttachment.detach();
        attached.detach();
        await mutateOwnerState(runtime, {
          kind: 'fixture.finish_peer',
          payload: { peerId },
          prepare(ctx) {
            stageSessionFinish(
              ctx,
              ctx.snapshot.sessions.get(peerId)!,
              'completed',
              new Date().toISOString(),
            );
            return null;
          },
        });
        await mutateOwnerState(runtime, {
          kind: 'fixture.finish',
          payload: { id },
          prepare(ctx) {
            stageSessionFinish(ctx, ctx.snapshot.sessions.get(id)!, 'completed', new Date().toISOString());
            return null;
          },
        });
        expect(store.snapshot().addresses.get(address)?.currentSessionId).toBeNull();
        expect(store.snapshot().table('agentNameLeases').by('sessionId', id)[0]?.cooldownUntil).toBeTruthy();
        await expect(registerOwnedMessagingSession(runtime, host!, input, env)).rejects.toThrow('finished');
      }
      const last = ids[ids.length - 1]!;
      const [stored] = await handle!.db
        .select()
        .from(schema.agentSessions)
        .where(eq(schema.agentSessions.id, last));
      expect(stored?.status).toBe('completed');
    } finally {
      await close?.();
      credentials?.close();
      presence?.close();
      deadlines.close();
      await owner.close();
      budget.restore();
      if (commands.length)
        await handle!.db
          .delete(schema.controlPlaneCommandReceipts)
          .where(inArray(schema.controlPlaneCommandReceipts.requestId, commands));
      if (conferences.length)
        await handle!.db
          .delete(schema.agentBusConferences)
          .where(inArray(schema.agentBusConferences.id, conferences));
      if (addresses.length) {
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
