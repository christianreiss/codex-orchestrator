import { deliveryTimingReceipt, captureQueuePolicy } from './smart-queue.js';
import { receiverState } from '../agent-receiver-state.js';
import { randomUUID } from 'node:crypto';
import { and, asc, eq, inArray } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import {
  agentBusConversations,
  agentBusMessages,
  type AgentBusAddress,
  type AgentBusConversation,
} from '../../db/schema.js';
import { ConflictError, NotFoundError, ValidationError } from '../../http/errors.js';
import type { Keyring } from '../../security/keyring.js';
import { decrypt, encrypt } from '../../security/secret-box.js';
import { isoOffsetSeconds, nowIso } from '../../util/timestamp.js';
import { wsPublisher } from '../../ws/publisher.js';
import type { Json } from '../../control-plane/commands.js';
import { mutateOwnerState, type OwnerRuntime } from '../../control-plane/state/runtime.js';
import type { OwnerStateSnapshot } from '../../control-plane/state/store.js';
import { ownedAddress, ownedBridge } from '../../control-plane/state/messaging.js';
import { translateOwnedAgent } from '../../control-plane/state/names.js';
import { stageQueuedMessage } from '../../control-plane/state/messages.js';
import { stageUpdate } from '../../control-plane/state/rows.js';
import { ownedAddressPresence } from '../../control-plane/state/presence-notices.js';
import { deliveryHint } from './presence-feedback.js';
import {
  assertQueuePolicyReplay,
  coalescedEventStats,
  queuePolicy,
  type QueuePolicy,
} from './smart-queue.js';
import { normalizeMessageBody, normalizeMessageTtl, normalizeUuid } from './normalize.js';
import { messageForParticipant, newQueuedMessage } from './views.js';

export interface OwnedSendInput {
  to: string;
  content: string;
  clientMessageId: string;
  conversationId?: string | null;
  ttlSeconds?: number | null;
  kind?: 'message' | 'request';
  queue?: QueuePolicy;
}
const json = (value: unknown): Json => JSON.parse(JSON.stringify(value)) as Json;
export function resolveOwnedRecipient(
  snapshot: OwnerStateSnapshot,
  raw: string,
  allowInactive = false,
): AgentBusAddress {
  let value = String(raw ?? '')
    .trim()
    .toLowerCase();
  if (/^[0-9a-f]{8}-[0-9a-f-]{27}$/.test(value)) value = `agent:${value}`;
  if (value && !value.startsWith('agent:'))
    value = String(translateOwnedAgent(snapshot, value, nowIso()).address);
  if (!value) throw new ValidationError('to is required', { param: 'to' });
  const row = snapshot.addresses
    .all()
    .find((address) => address.address === value || address.displayAlias === value);
  if (!row || (!allowInactive && (row.archivedAt || row.enabled !== 1)))
    throw new NotFoundError('Agent address not found', 'agent_messaging_address_not_found');
  return row;
}
export async function sendOwnedMessage(
  db: Database,
  runtime: OwnerRuntime,
  keyring: Keyring,
  sessionId: string,
  token: string,
  input: OwnedSendInput,
): Promise<Record<string, unknown>> {
  input = { ...input, queue: captureQueuePolicy(input.queue) };
  runtime.assertOwner();
  const first = ownedBridge(runtime.state.snapshot(), sessionId, token).session;
  if (!first.agentBusAddressId)
    throw new ConflictError('Agent session has no messaging address', 'agent_messaging_address_missing');
  const content = normalizeMessageBody(input.content),
    clientMessageId = normalizeUuid(input.clientMessageId, 'client_message_id'),
    ttlSeconds = normalizeMessageTtl(input.ttlSeconds);
  const requested = input.to.trim().toLowerCase();
  let created = false,
    authorizedTarget: string | undefined;
  const response = await mutateOwnerState(runtime, {
    kind: 'messaging.send',
    principal: `agent:${first.agentBusAddressId}`,
    id: clientMessageId,
    payload: json({
      to: requested,
      content,
      clientMessageId,
      conversationId: input.conversationId ?? null,
      ttlSeconds,
      kind: input.kind ?? 'message',
      queue: input.queue ?? null,
    }),
    authorize(snapshot) {
      ownedBridge(snapshot, sessionId, token, { generation: first.bindingGeneration });
      if (authorizedTarget) ownedAddress(snapshot, authorizedTarget);
    },
    async prepare(context) {
      const snapshot = context.snapshot,
        session = ownedBridge(snapshot, sessionId, token).session;
      const sender = ownedAddress(snapshot, session.agentBusAddressId!);
      if (sender.currentSessionId !== session.id || sender.bindingGeneration !== session.bindingGeneration)
        throw new ConflictError('Agent address binding changed', 'agent_messaging_binding_stale');
      let policy = queuePolicy(input.queue, input.kind === 'request');
      // Immutable opening metadata and pre-owner idempotency history are cold.
      // These reads happen only for an explicit send, never as an idle probe.
      if (!input.queue && input.kind !== 'request' && input.conversationId) {
        const opening = snapshot.messages
          .by('conversationId', input.conversationId)
          .find((message) => message.sequence === 1);
        const [historical] = opening
          ? []
          : await db
              .select({ deliveryClass: agentBusMessages.deliveryClass })
              .from(agentBusMessages)
              .where(eq(agentBusMessages.conversationId, input.conversationId))
              .orderBy(asc(agentBusMessages.sequence))
              .limit(1);
        if ((opening ?? historical)?.deliveryClass === 'coordination')
          policy = { ...policy, deliveryClass: 'coordination' };
      }
      const [legacy] = await db
        .select()
        .from(agentBusMessages)
        .where(
          and(
            eq(agentBusMessages.senderAddressId, sender.id),
            eq(agentBusMessages.clientMessageId, clientMessageId),
          ),
        )
        .limit(1);
      const target =
        legacy && legacy.requestedTarget === requested
          ? snapshot.addresses.get(legacy.targetAddressId)
          : resolveOwnedRecipient(snapshot, input.to, !!legacy);
      if (!target) throw new NotFoundError('Agent address not found', 'agent_messaging_address_not_found');
      if (legacy) {
        assertQueuePolicyReplay(legacy, policy);
        if (
          legacy.targetAddressId !== target.id ||
          (input.conversationId && legacy.conversationId !== input.conversationId) ||
          legacy.replyToMessageId !== null ||
          legacy.kind !== (input.kind ?? 'message') ||
          decrypt(legacy.contentEnc, keyring) !== content
        )
          throw new ConflictError(
            'Client message ID was already used with different content',
            'agent_messaging_idempotency_conflict',
          );
        return json({ message: messageForParticipant(legacy, content, sender, target) });
      }
      ownedAddress(snapshot, target.id);
      authorizedTarget = target.id;
      if (sender.id === target.id)
        throw new ValidationError('An agent cannot message itself', { param: 'to' });
      if (policy.relatedWorkId) {
        const active = snapshot.messages.get(policy.relatedWorkId);
        const [historical] = active
          ? []
          : await db
              .select({
                targetAddressId: agentBusMessages.targetAddressId,
                workKind: agentBusMessages.workKind,
              })
              .from(agentBusMessages)
              .where(eq(agentBusMessages.id, policy.relatedWorkId))
              .limit(1);
        const related = active ?? historical;
        if (!related || related.targetAddressId !== target.id || !related.workKind)
          throw new NotFoundError(
            'Related work does not belong to this recipient',
            'agent_messaging_message_not_found',
          );
      }
      const now = nowIso();
      let conversation: AgentBusConversation;
      if (input.conversationId) {
        const row = snapshot
          .table('agentBusConversations')
          .get(normalizeUuid(input.conversationId, 'conversation_id'));
        if (
          !row ||
          ![row.addressAId, row.addressBId].includes(sender.id) ||
          ![row.addressAId, row.addressBId].includes(target.id)
        )
          throw new NotFoundError('Conversation not found', 'agent_messaging_conversation_not_found');
        if (row.status !== 'open')
          throw new ConflictError('Conversation is canceled', 'agent_messaging_conversation_canceled');
        conversation = row;
      } else {
        conversation = {
          id: randomUUID(),
          addressAId: sender.id,
          addressBId: target.id,
          createdByAddressId: sender.id,
          nextSequence: 1,
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
      }
      const id = randomUUID();
      const replaced =
        policy.coalesceKey && ['progress', 'notice'].includes(policy.deliveryClass)
          ? snapshot.messages
              .by('targetAddressId', target.id)
              .filter(
                (message) =>
                  message.senderAddressId === sender.id &&
                  message.status === 'queued' &&
                  !message.workKind &&
                  message.expiresAt > now &&
                  ['message', 'reply'].includes(message.kind) &&
                  message.deliveryClass === policy.deliveryClass &&
                  (message.deliveryTiming ?? 'after_turn') === policy.deliveryTiming &&
                  message.coalesceKey === policy.coalesceKey &&
                  message.relatedWorkId === policy.relatedWorkId,
              )
          : [];
      if (replaced.length) {
        const ids = new Set(replaced.map((message) => message.id));
        // Superseded ancestry is immutable cold history; flatten it in the same
        // command while mirroring any still-retained metadata in RAM.
        context.write(async (tx) => {
          await tx
            .update(agentBusMessages)
            .set({ supersededById: id, updatedAt: now })
            .where(
              and(
                eq(agentBusMessages.targetAddressId, target.id),
                eq(agentBusMessages.status, 'superseded'),
                inArray(agentBusMessages.supersededById, [...ids]),
              ),
            );
        });
        for (const old of snapshot.messages.by('targetAddressId', target.id))
          if (old.status === 'superseded' && old.supersededById && ids.has(old.supersededById))
            context.draft.upsert('agentBusMessages', { ...old, supersededById: id, updatedAt: now });
        for (const old of replaced)
          stageUpdate(context, 'agentBusMessages', old.id, {
            status: 'superseded',
            supersededById: id,
            updatedAt: now,
          });
      }
      const message = stageQueuedMessage(context, {
        ...newQueuedMessage({
          id,
          conversationId: conversation.id,
          sequence: conversation.nextSequence,
          sender,
          senderSessionId: session.id,
          target,
          kind: input.kind ?? 'message',
          content,
          contentEnc: encrypt(content, keyring),
          clientMessageId,
          expiresAt: isoOffsetSeconds(ttlSeconds),
          now,
        }),
        ...policy,
        ...(replaced.length ? coalescedEventStats(replaced, now) : {}),
        requestedTarget: requested,
        awaitingPresence: ownedAddressPresence(runtime, snapshot, target) === 'listening' ? 0 : 1,
      });
      stageUpdate(context, 'agentBusConversations', conversation.id, {
        nextSequence: conversation.nextSequence + 1,
        lastActivityAt: now,
        updatedAt: now,
      });
      created = true;
      return () => json({ message: messageForParticipant(message(), content, sender, target) });
    },
  });
  const result = response as { message: Record<string, unknown> };
  const current = runtime.state.snapshot(),
    message = current.messages.get(String(result.message.id));
  const sender = current.addresses.get(first.agentBusAddressId),
    target = current.addresses.get(String((result.message.target as { id?: string })?.id));
  const presence = target ? ownedAddressPresence(runtime, current, target) : 'offline';
  if (message && sender && target) result.message = messageForParticipant(message, content, sender, target);
  if (created)
    wsPublisher.publish('agent_messaging.message.changed', {
      message_id: result.message.id,
      conversation_id: result.message.conversation_id,
      status: result.message.status,
    });
  return {
    created,
    ...result,
    ...deliveryTimingReceipt(String(result.message.delivery_timing ?? 'after_turn'), !!target?.currentSessionId &&
      receiverState(current.sessions.get(target.currentSessionId)?.receiver)?.delivery_timing_v1 === true),
    recipient_presence: presence,
    observed_at: nowIso(),
    delivery_hint: deliveryHint(presence),
  };
}
