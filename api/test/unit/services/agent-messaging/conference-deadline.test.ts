import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { conferenceMessageExpiry } from '../../../../src/services/agent-messaging/conference-protocol.js';
import {
  ownedClaimCandidates,
  type OwnedClaimOptions,
} from '../../../../src/services/agent-messaging/owned-claim.js';
import { OwnerStateSnapshot, OwnerStateStore } from '../../../../src/control-plane/state/store.js';
import { acknowledgeOwnedDelivery } from '../../../../src/services/agent-messaging/owned-delivery.js';
import { CommandExecutor } from '../../../../src/control-plane/commands.js';
import { createDbFake } from '../../../helpers/db-fake.js';
import { testKeyring } from '../../../helpers/test-keyring.js';
import type { OwnerRuntime } from '../../../../src/control-plane/state/runtime.js';
import type { PersistenceTransaction } from '../../../../src/control-plane/persistence.js';
import type { PreparedOwnerState } from '../../../../src/control-plane/state/store.js';
import { ownedConferenceAdmissionOpen } from '../../../../src/services/agent-messaging/conference-protocol.js';
import { newQueuedMessage } from '../../../../src/services/agent-messaging/views.js';
import type { AgentBusAddress, AgentBusConference } from '../../../../src/db/schema.js';
import type { StateSeed } from '../../../../src/control-plane/state/catalog.js';

describe('conference delivery deadline', () => {
  const now = '2026-10-25T12:00:00Z',
    deadlineAt = '2026-10-25T12:00:01Z';
  it('does not apply the external 60-second minimum to internal conference messages', () => {
    expect(conferenceMessageExpiry({ deadlineAt } as AgentBusConference, now)).toBe(deadlineAt);
  });
  it('caps long rooms at the ordinary maximum relative to the supplied clock', () => {
    expect(conferenceMessageExpiry({ deadlineAt: '2099-01-01T00:00:00Z' } as AgentBusConference, now)).toBe(
      '2026-11-01T12:00:00Z',
    );
  });
  for (const engine of ['codex', 'claude', 'grok']) {
    for (const status of ['open', 'adjourning', 'adjourned']) {
      it(`${engine}: fences old long-expiry rows at the deadline in ${status} rooms`, () => {
        const sender = { id: randomUUID(), engine } as AgentBusAddress;
        const target = { id: randomUUID(), engine } as AgentBusAddress;
        const conversationId = randomUUID(),
          conferenceId = randomUUID();
        const row = newQueuedMessage({
          id: randomUUID(),
          conversationId,
          sequence: 1,
          sender,
          target,
          senderSessionId: null,
          kind: 'task',
          content: 'old task',
          contentEnc: 'fixture',
          clientMessageId: randomUUID(),
          expiresAt: '2099-01-01T00:00:00Z',
          now,
        });
        const state = new OwnerStateSnapshot({ epoch: randomUUID(), sequence: 0n }, {
          agentBusConferences: [{ id: conferenceId, status, deadlineAt }],
          agentBusConferenceMembers: [
            { id: randomUUID(), conferenceId, conversationId, state: 'dispatched' },
          ],
          agentBusMessages: [row],
        } as unknown as StateSeed);
        const options = {
          targetAddressIds: [target.id],
          leaseOwner: `session:${randomUUID()}`,
          relayGeneration: null,
          smartQueue: false,
          informationalOnly: false,
        } as OwnedClaimOptions;
        expect(ownedClaimCandidates(state, options, now)).toHaveLength(1);
        expect(ownedClaimCandidates(state, options, deadlineAt)).toHaveLength(0);
        expect(ownedClaimCandidates(state, options, '2026-10-25T12:00:02Z')).toHaveLength(0);
      });
    }
  }
});

describe('conference late ACK preserves accepted work', () => {
  for (const engine of ['codex', 'claude', 'grok']) {
    for (const status of ['leased', 'accepted'] as const) {
      it(`${engine}: ${status} ACK after deadline`, async () => {
        const sessionId = randomUUID(),
          targetId = randomUUID(),
          senderId = randomUUID();
        const messageId = randomUUID(),
          conversationId = randomUUID(),
          conferenceId = randomUUID(),
          claimId = randomUUID();
        const now = new Date().toISOString(),
          leaseOwner = `session:${sessionId}`;
        const sender = { id: senderId, engine } as AgentBusAddress;
        const target = {
          id: targetId,
          engine,
          currentSessionId: sessionId,
          bindingGeneration: 1,
        } as AgentBusAddress;
        const message = {
          ...newQueuedMessage({
            id: messageId,
            conversationId,
            sequence: 1,
            sender,
            target,
            senderSessionId: null,
            kind: 'task',
            content: 'task',
            contentEnc: 'fixture',
            clientMessageId: randomUUID(),
            expiresAt: '2099-01-01T00:00:00Z',
            now,
          }),
          status,
          claimId,
          leaseOwner,
          targetBindingGeneration: 1,
          relayGeneration: null,
          ownerInstanceId: null,
          acceptedAt: status === 'accepted' ? now : null,
        };
        const seed = {
          versions: [{ name: 'agent_messaging_enabled', version: '1' }],
          agentSessions: [{ id: sessionId, endedAt: null, bindingGeneration: 1 }],
          agentBusAddresses: [sender, target],
          agentBusMessages: [message],
          agentBusConferenceMembers: [
            { id: randomUUID(), conversationId, conferenceId, state: 'dispatched' },
          ],
          agentBusConferences: [
            { id: conferenceId, status: 'adjourning', deadlineAt: '2000-01-01T00:00:00Z' },
          ],
        } as unknown as StateSeed;
        const state = new OwnerStateStore(
          new OwnerStateSnapshot({ epoch: randomUUID(), sequence: 0n }, seed),
        );
        const db = createDbFake();
        const executor = new CommandExecutor<OwnerStateSnapshot, PersistenceTransaction, PreparedOwnerState>({
          state,
          assertOwner() {},
          loseOwner(error) {
            throw error;
          },
          notificationError(error) {
            throw error;
          },
          committed() {},
          persistence: {
            async receipt() {
              return undefined;
            },
            async record() {},
            async transaction(run) {
              await run(db as unknown as PersistenceTransaction);
            },
          },
        });
        const runtime = {
          state,
          assertOwner() {},
          execute: (command) => executor.execute(command),
        } as OwnerRuntime;
        const result = acknowledgeOwnedDelivery(
          db as never,
          runtime,
          testKeyring(),
          messageId,
          { claimId, outcome: status === 'leased' ? 'accepted' : 'completed' },
          leaseOwner,
          null,
          sessionId,
        );
        if (status === 'leased') {
          await expect(result).rejects.toMatchObject({ code: 'agent_messaging_conference_expired' });
          expect(state.snapshot().messages.get(messageId)?.status).toBe('leased');
        } else {
          await result;
          expect(state.snapshot().messages.get(messageId)?.status).toBe('completed');
          expect(state.snapshot().table('agentTaskResults').by('messageId', messageId)).toHaveLength(1);
          const reply = {
            ...message,
            kind: 'reply',
            workKind: null,
            replyToMessageId: messageId,
            senderAddressId: targetId,
            targetAddressId: senderId,
          };
          expect(ownedConferenceAdmissionOpen(state.snapshot(), reply, now)).toBe(true);
          expect(ownedConferenceAdmissionOpen(state.snapshot(), { ...reply, workKind: 'request' }, now)).toBe(
            false,
          );
          expect(
            ownedConferenceAdmissionOpen(state.snapshot(), { ...reply, senderAddressId: senderId }, now),
          ).toBe(false);
        }
        await executor.drain();
      });
    }
  }
});

describe('conference expiry does not stall independent work', () => {
  for (const engine of ['codex', 'claude', 'grok']) {
    for (const smartQueue of [false, true]) {
      for (const status of ['queued', 'leased', 'accepted'] as const) {
        it(`${engine}: smart=${smartQueue}, expired ${status} FIFO predecessor`, () => {
          const sender = { id: randomUUID(), engine } as AgentBusAddress;
          const target = { id: randomUUID(), engine } as AgentBusAddress;
          const conferenceId = randomUUID(),
            conversationId = randomUUID(),
            now = '2026-10-25T12:00:02Z';
          const make = (conv: string, order: number) => ({
            ...newQueuedMessage({
              id: randomUUID(),
              conversationId: conv,
              sequence: 1,
              sender,
              target,
              senderSessionId: null,
              kind: 'task',
              content: 'task',
              contentEnc: 'fixture',
              clientMessageId: randomUUID(),
              expiresAt: '2099-01-01T00:00:00Z',
              now,
            }),
            dispatchOrder: order,
          });
          const earlier = { ...make(conversationId, 1), status },
            later = make(randomUUID(), 2);
          const snapshot = new OwnerStateSnapshot({ epoch: randomUUID(), sequence: 0n }, {
            agentBusMessages: [earlier, later],
            agentBusConferenceMembers: [{ id: randomUUID(), conferenceId, conversationId }],
            agentBusConferences: [{ id: conferenceId, deadlineAt: '2026-10-25T12:00:01Z' }],
          } as unknown as StateSeed);
          const candidates = ownedClaimCandidates(
            snapshot,
            {
              targetAddressIds: [target.id],
              leaseOwner: `session:${randomUUID()}`,
              relayGeneration: null,
              smartQueue,
              informationalOnly: false,
            } as OwnedClaimOptions,
            now,
          );
          expect(candidates.map((row) => row.id)).toEqual(status === 'accepted' ? [] : [later.id]);
        });
      }
    }
    it(`${engine}: private room-question conversation is fenced via room delivery metadata`, () => {
      const sender = { id: randomUUID(), engine: 'server' } as AgentBusAddress;
      const target = { id: randomUUID(), engine } as AgentBusAddress;
      const conferenceId = randomUUID(),
        eventId = randomUUID(),
        now = '2026-10-25T12:00:02Z';
      const question = newQueuedMessage({
        id: randomUUID(),
        conversationId: randomUUID(),
        sequence: 1,
        sender,
        target,
        senderSessionId: null,
        kind: 'message',
        deliveryClass: 'coordination',
        content: 'question',
        contentEnc: 'fixture',
        clientMessageId: randomUUID(),
        expiresAt: '2099-01-01T00:00:00Z',
        now,
      });
      const snapshot = new OwnerStateSnapshot({ epoch: randomUUID(), sequence: 0n }, {
        agentBusMessages: [question],
        agentRoomEvents: [{ id: eventId, roomId: conferenceId }],
        agentRoomDeliveries: [{ eventId, addressId: target.id, messageId: question.id }],
        agentBusConferences: [{ id: conferenceId, status: 'adjourning', deadlineAt: '2026-10-25T12:00:01Z' }],
      } as unknown as StateSeed);
      expect(ownedConferenceAdmissionOpen(snapshot, question as never, now)).toBe(false);
      expect(
        ownedClaimCandidates(
          snapshot,
          {
            targetAddressIds: [target.id],
            leaseOwner: `session:${randomUUID()}`,
            relayGeneration: null,
            smartQueue: true,
            informationalOnly: false,
          } as OwnedClaimOptions,
          now,
        ),
      ).toEqual([]);
    });
  }
});
