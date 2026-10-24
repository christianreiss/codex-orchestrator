import { legacyDrainFor } from '../legacy-drain.js';
import { randomUUID } from 'node:crypto';
import { agentBusConversations, type AgentBusAddress } from '../../db/schema.js';
import { ApiError } from '../../http/errors.js';
import type { Keyring } from '../../security/keyring.js';
import { encrypt } from '../../security/secret-box.js';
import { isPresent, type AgentAddressPresence } from '../../services/agent-presence.js';
import { receiverState } from '../../services/agent-receiver-state.js';
import { newQueuedMessage } from '../../services/agent-messaging/views.js';
import { ownerPresence } from '../presence.js';
import { ownedAddress, requireOwnedMessaging } from './messaging.js';
import { stageQueuedMessage, stageServerAddress } from './messages.js';
import { stageUpdate } from './rows.js';
import { mutateOwnerState, type OwnerRuntime } from './runtime.js';
import type { OwnerStateSnapshot } from './store.js';

export function ownedAddressPresence(
  runtime: OwnerRuntime,
  snapshot: OwnerStateSnapshot,
  address: AgentBusAddress,
): AgentAddressPresence {
  runtime.assertOwner();
  if (!address.enabled || address.archivedAt || address.readiness === 'disabled') return 'disabled';
  const session = address.currentSessionId ? snapshot.sessions.get(address.currentSessionId) : undefined;
  if (session && !session.endedAt && session.bindingGeneration === address.bindingGeneration) {
    const presence = ownerPresence(runtime),
      legacy = legacyDrainFor(runtime),
      receiver = receiverState(session.receiver);
    if (
      receiver &&
      !receiver.failure &&
      receiver.probes.peer &&
      (presence.hasReceiver(session.id, session.bindingGeneration, receiver.generation) ||
        legacy?.receiver(session.id, session.bindingGeneration, receiver.generation))
    )
      return 'listening';
    if (
      presence.hasSession(session.id, session.bindingGeneration) ||
      legacy?.session(session.id, session.bindingGeneration)
    )
      return 'online';
  }
  return address.lastUpstreamSessionId ? 'resumable' : 'offline';
}

function pending(snapshot: OwnerStateSnapshot, sessionId: string, addressId: string, now: string) {
  return snapshot.messages
    .by('targetAddressId', addressId)
    .filter(
      (message) =>
        message.awaitingPresence === 1 &&
        message.expiresAt > now &&
        !message.cancelRequestedAt &&
        (['queued', 'leased'].includes(message.status) ||
          (message.status === 'accepted' &&
            message.deliverySessionId === sessionId &&
            message.leaseOwner?.startsWith('relay:'))),
    );
}

export async function queueOwnedPresenceNotices(
  runtime: OwnerRuntime,
  sessionId: string,
  keyring: Keyring,
): Promise<Array<{ message_id: string; conversation_id: string; status: string }>> {
  runtime.assertOwner();
  const initial = runtime.state.snapshot(),
    session = initial.sessions.get(sessionId),
    address = session?.agentBusAddressId ? initial.addresses.get(session.agentBusAddressId) : undefined;
  if (
    !address ||
    !session ||
    session.endedAt ||
    ownedAddressPresence(runtime, initial, address) !== 'listening' ||
    !pending(initial, sessionId, address.id, new Date().toISOString()).length
  )
    return [];
  const result = await mutateOwnerState(runtime, {
    kind: 'messaging.presence.return',
    payload: { sessionId },
    authorize: requireOwnedMessaging,
    prepare(context) {
      const now = new Date().toISOString(),
        snapshot = context.snapshot,
        current = snapshot.sessions.get(sessionId);
      const target = current?.agentBusAddressId
        ? snapshot.addresses.get(current.agentBusAddressId)
        : undefined;
      if (
        !current ||
        current.endedAt ||
        !target ||
        ownedAddressPresence(runtime, snapshot, target) !== 'listening'
      )
        return [];
      ownedAddress(snapshot, target.id);
      const waiting = pending(snapshot, sessionId, target.id, now),
        bySender = new Map<string, typeof waiting>();
      for (const message of waiting) {
        const group = bySender.get(message.senderAddressId) ?? [];
        group.push(message);
        bySender.set(message.senderAddressId, group);
      }
      const receipts: Array<{ message_id: string; conversation_id: string; status: string }> = [];
      for (const [senderId, messages] of bySender) {
        const sender = snapshot.addresses.get(senderId),
          senderSession = sender?.currentSessionId
            ? snapshot.sessions.get(sender.currentSessionId)
            : undefined;
        if (!sender || !senderSession || !isPresent(ownedAddressPresence(runtime, snapshot, sender)))
          continue;
        try {
          ownedAddress(snapshot, senderId);
        } catch (error) {
          if (error instanceof ApiError && [403, 404, 423].includes(error.status)) continue;
          throw error;
        }
        const presenceNoticeKey = `${sessionId}:${senderSession.id}`;
        if (snapshot.messages.all().some((message) => message.presenceNoticeKey === presenceNoticeKey))
          continue;
        const server = stageServerAddress(context, now),
          conversationId = randomUUID(),
          messageId = randomUUID();
        const conversation = {
          id: conversationId,
          addressAId: server.id,
          addressBId: sender.id,
          createdByAddressId: server.id,
          nextSequence: 2,
          status: 'open',
          lastActivityAt: now,
          canceledBy: null,
          cancelReason: null,
          canceledAt: null,
          createdAt: now,
          updatedAt: now,
        };
        context.draft.upsert('agentBusConversations', conversation);
        context.write(async (tx) => {
          await tx.insert(agentBusConversations).values(conversation);
        });
        const details = {
          address: target.address,
          name: target.launchName,
          session_id: sessionId,
          waiting_message_count: messages.length,
          waiting_message_ids: messages.slice(0, 256).map((message) => message.id),
          message_ids_truncated: messages.length > 256,
          observed_at: now,
        };
        const content = `PRESENCE/1\n${target.launchName ?? target.address} (${target.address}) is ready to receive again; your waiting messages can now be delivered. This is an informational server presence update, not proof of acceptance or reading and not a work request. No reply required; finish with agent_listen once and yield.\n${JSON.stringify(details)}`;
        stageQueuedMessage(context, {
          ...newQueuedMessage({
            id: messageId,
            conversationId,
            sequence: 1,
            sender: server,
            senderSessionId: null,
            target: sender,
            kind: 'presence_notice',
            deliveryClass: 'notice',
            content,
            contentEnc: encrypt(content, keyring),
            clientMessageId: randomUUID(),
            expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
            now,
          }),
          targetSessionId: senderSession.id,
          presenceNoticeKey,
        });
        receipts.push({ message_id: messageId, conversation_id: conversationId, status: 'queued' });
      }
      for (const message of waiting)
        stageUpdate(context, 'agentBusMessages', message.id, { awaitingPresence: 0 });
      return receipts;
    },
  });
  return result as Array<{ message_id: string; conversation_id: string; status: string }>;
}
