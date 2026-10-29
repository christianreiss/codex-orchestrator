import { deliveryTimingReceipt, captureQueuePolicy } from './smart-queue.js';
import { receiverState } from '../agent-receiver-state.js';
import { randomUUID } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import { agentBusMessages } from '../../db/schema.js';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../../http/errors.js';
import type { Keyring } from '../../security/keyring.js';
import { decrypt, encrypt } from '../../security/secret-box.js';
import { nowIso, isoOffsetSeconds } from '../../util/timestamp.js';
import { wsPublisher } from '../../ws/publisher.js';
import type { Json } from '../../control-plane/commands.js';
import { mutateOwnerState, type OwnerRuntime } from '../../control-plane/state/runtime.js';
import { ownedAddress, ownedBridge, ownedRelay } from '../../control-plane/state/messaging.js';
import { stageUpdate } from '../../control-plane/state/rows.js';
import { stageQueuedMessage } from '../../control-plane/state/messages.js';
import { assertOwnedHousekeeping } from '../../control-plane/state/session-lifecycle.js';
import { ownedAddressPresence } from '../../control-plane/state/presence-notices.js';
import {
  assertQueuePolicyReplay,
  coalescedEventStats,
  queuePolicy,
  type QueuePolicy,
} from './smart-queue.js';
import {
  assertOwnedDelivery,
  stageConferenceCharge,
  stageConferenceSettlement,
  stageOwnedTaskResult,
  ownedTaskResultReceipt,
  type OwnedMessage,
} from './owned-delivery.js';
import {
  jsonRecord,
  normalizeMessageBody,
  normalizeMessageTtl,
  normalizeOptionalText,
  normalizeUuid,
} from './normalize.js';
import { messageForParticipant, messageMetadata, newQueuedMessage } from './views.js';
import { deliveryHint } from './presence-feedback.js';
import { SERVER_ADDRESS_ID } from './groups.js';
import { TERMINAL_MESSAGE_STATUSES } from './constants.js';
import { unknownTaskResult, type TaskResult } from './task-execution.js';

export type ReplyActor =
  | { kind: 'session'; id: string; token: string }
  | { kind: 'relay'; id: string; token: string };
export interface OwnedReplyInput {
  content: string;
  clientMessageId: string;
  ttlSeconds?: number | null;
  claimId?: string;
  taskResult?: TaskResult;
  queue?: QueuePolicy;
  deliverySessionId?: string | null;
  upstreamSessionId?: string | null;
}
const json = (value: unknown): Json => JSON.parse(JSON.stringify(value)) as Json;

export async function replyOwnedMessage(
  db: Database,
  runtime: OwnerRuntime,
  keyring: Keyring,
  actor: ReplyActor,
  parentMessageId: string,
  input: OwnedReplyInput,
): Promise<Record<string, unknown>> {
  input = { ...input, queue: captureQueuePolicy(input.queue) };
  const parentId = normalizeUuid(parentMessageId, 'message_id'),
    clientMessageId = normalizeUuid(input.clientMessageId, 'client_message_id'),
    content = normalizeMessageBody(input.content),
    ttl = normalizeMessageTtl(input.ttlSeconds);
  const claimId = input.claimId ? normalizeUuid(input.claimId, 'claim_id') : null,
    upstream = normalizeOptionalText(input.upstreamSessionId, 255),
    deliverySessionId = input.deliverySessionId
      ? normalizeUuid(input.deliverySessionId, 'delivery_session_id')
      : null;
  const first = runtime.state.snapshot();
  const session = actor.kind === 'session' ? ownedBridge(first, actor.id, actor.token).session : null,
    relay = actor.kind === 'relay' ? ownedRelay(first, actor.id, actor.token).relay : null;
  const leaseOwner = relay ? `relay:${relay.id}:${relay.generation}` : `session:${actor.id}`;
  if (session && !session.agentBusAddressId)
    throw new ConflictError('Agent session has no messaging address', 'agent_messaging_address_missing');
  let created = false,
    targetForValidation: string | undefined;
  const result = (await mutateOwnerState(runtime, {
    kind: 'messaging.reply',
    principal: relay ? leaseOwner : `agent:${session!.agentBusAddressId}`,
    id: clientMessageId,
    payload: json({
      parentId,
      clientMessageId,
      content,
      ttl,
      claimId,
      taskResult: input.taskResult ?? null,
      queue: input.queue ?? null,
      deliverySessionId,
      upstream,
    }),
    authorize(snapshot) {
      if (relay) {
        if (ownedRelay(snapshot, actor.id, actor.token).relay.generation !== relay.generation)
          throw new ConflictError('Relay generation changed', 'agent_messaging_lease_lost');
      } else ownedBridge(snapshot, actor.id, actor.token, { generation: session!.bindingGeneration });
      if (targetForValidation) ownedAddress(snapshot, targetForValidation);
    },
    async prepare(ctx) {
      const snapshot = ctx.snapshot;
      let parent: OwnedMessage | undefined = snapshot.messages.get(parentId);
      if (!parent) {
        const [old] = await db
          .select()
          .from(agentBusMessages)
          .where(eq(agentBusMessages.id, parentId))
          .limit(1);
        parent = old;
      }
      const senderId = session?.agentBusAddressId ?? parent?.targetAddressId;
      if (!parent || !senderId || parent.targetAddressId !== senderId)
        throw new NotFoundError('Message not found', 'agent_messaging_message_not_found');
      const sender = ownedAddress(snapshot, senderId),
        target = snapshot.addresses.get(parent.senderAddressId);
      if (!target)
        throw new NotFoundError('Message participant not found', 'agent_messaging_address_not_found');
      if (target.id === SERVER_ADDRESS_ID)
        throw new ConflictError(
          'Server publications are informational; use the operator portal conversation to respond',
          'agent_messaging_server_publication_reply',
        );
      if (
        session &&
        (sender.currentSessionId !== session.id || sender.bindingGeneration !== session.bindingGeneration)
      )
        throw new ConflictError('Agent address binding changed', 'agent_messaging_binding_stale');
      if (relay) {
        const username =
          jsonRecord(relay.capabilities)?.host_daemon === true
            ? `${sender.username}:daemon`
            : sender.username;
        if (sender.hostId !== relay.hostId || username !== relay.username)
          throw new ForbiddenError(
            'Relay does not own this delivery address',
            'agent_messaging_relay_target_mismatch',
          );
      }
      let policy = queuePolicy(input.taskResult ? { ...input.queue, delivery_class: 'coordination' } : input.queue);
      if (
        (relay && (parent.workKind || parent.deliveryClass === 'coordination')) ||
        (!input.queue && parent.deliveryClass === 'coordination')
      )
        policy = { ...policy, deliveryClass: 'coordination' };
      if (parent.kind === 'presence_notice')
        throw new ConflictError(
          'Presence notices are informational and cannot be replied to',
          'agent_messaging_presence_notice_reply',
        );
      if (input.taskResult && (!parent.workKind || !claimId))
        throw new ValidationError('Task result requires claimed work');
      if (parent.workKind && !claimId)
        throw new ConflictError(
          'Work replies require the accepted delivery claim',
          'agent_task_result_not_accepted',
        );
      if (
        !parent.workKind &&
        parent.attempts > 0 &&
        !['completed', 'digested', 'superseded'].includes(parent.status) &&
        !claimId
      )
        throw new ConflictError(
          'A delivered message requires its current claim; use send for a new follow-up',
          'agent_messaging_lease_lost',
        );
      if (claimId) assertOwnedDelivery(snapshot, parent, claimId, leaseOwner, relay?.generation ?? null);
      const canceledAccepted = !!parent.cancelRequestedAt && !!parent.acceptedAt;
      if (
        relay &&
        (!claimId || (!['leased', 'accepted', 'completed'].includes(parent.status) && !canceledAccepted))
      )
        throw new ConflictError(
          'Message lease is no longer owned by this delivery',
          'agent_messaging_lease_lost',
        );
      const progress = !!parent.workKind && !input.taskResult && policy.deliveryClass === 'progress';
      if (progress && parent.status !== 'accepted')
        throw new ConflictError(
          'Progress replies require accepted, unfinished work',
          'agent_task_result_not_accepted',
        );
      const now = nowIso();
      // The work's recorded outcome. The reply row never carries one, so its
      // message.task_result_status stays null (feedback 706ceff7).
      let recorded: Json | undefined;
      if (parent.workKind && !progress) {
        const report = stageOwnedTaskResult(ctx, parent, input.taskResult ?? unknownTaskResult, keyring, now);
        recorded = ownedTaskResultReceipt(ctx, parent, report, now);
        if (parent.status !== 'completed')
          stageUpdate(ctx, 'agentBusMessages', parent.id, {
            status: canceledAccepted ? parent.status : 'completed',
            taskResultStatus: report.status,
            completedAt: parent.completedAt ?? now,
            leaseUntil: null,
            updatedAt: now,
          });
        // A canceled conversation grants no new delivery. Keep the exact late
        // result as durable bookkeeping without reopening or executing work.
        if (
          canceledAccepted &&
          snapshot.table('agentBusConversations').get(parent.conversationId)?.status !== 'open'
        ) {
          return () =>
            json({
              message: messageMetadata(ctx.draft.table('agentBusMessages').get(parent!.id)!, sender, target),
              result_recorded: true,
              task_result: recorded!,
              delivery_suppressed: 'conversation_canceled',
            });
        }
      }
      const [existing] = await db
        .select()
        .from(agentBusMessages)
        .where(
          relay
            ? and(
                eq(agentBusMessages.replyToMessageId, parent.id),
                eq(agentBusMessages.senderAddressId, sender.id),
              )
            : and(
                eq(agentBusMessages.senderAddressId, sender.id),
                eq(agentBusMessages.clientMessageId, clientMessageId),
              ),
        )
        .limit(1);
      if (existing) {
        if (!relay) assertQueuePolicyReplay(existing, policy);
        if (
          existing.targetAddressId !== target.id ||
          existing.conversationId !== parent.conversationId ||
          existing.replyToMessageId !== parent.id ||
          existing.kind !== 'reply' ||
          decrypt(existing.contentEnc, keyring) !== content
        )
          throw new ConflictError(
            'Client message ID was already used with different content',
            'agent_messaging_idempotency_conflict',
          );
        return json({
          message: messageForParticipant(existing, content, sender, target),
          ...(recorded ? { task_result: recorded } : {}),
        });
      }
      ownedAddress(snapshot, target.id);
      targetForValidation = target.id;
      if (policy.relatedWorkId) {
        let related = snapshot.messages.get(policy.relatedWorkId);
        if (!related) {
          const [old] = await db
            .select()
            .from(agentBusMessages)
            .where(eq(agentBusMessages.id, policy.relatedWorkId))
            .limit(1);
          related = old;
        }
        if (!related || related.targetAddressId !== target.id || !related.workKind)
          throw new NotFoundError(
            'Related work does not belong to this recipient',
            'agent_messaging_message_not_found',
          );
      }
      const conversation = ctx.draft.table('agentBusConversations').get(parent.conversationId);
      if (
        !conversation ||
        ![conversation.addressAId, conversation.addressBId].includes(sender.id) ||
        ![conversation.addressAId, conversation.addressBId].includes(target.id)
      )
        throw new NotFoundError('Conversation not found', 'agent_messaging_conversation_not_found');
      if (conversation.status !== 'open')
        throw new ConflictError('Conversation is canceled', 'agent_messaging_conversation_canceled');
      if (claimId && !parent.workKind) {
        if (!['leased', 'accepted'].includes(parent.status))
          throw new ConflictError('Delivery lease ended', 'agent_messaging_lease_lost');
        if (parent.status === 'leased' && parent.expiresAt <= now)
          throw new ConflictError('Message expired before acceptance', 'agent_messaging_message_expired');
        stageUpdate(ctx, 'agentBusMessages', parent.id, {
          status: 'completed',
          acceptedAt: parent.acceptedAt ?? now,
          completedAt: now,
          leaseUntil: null,
          updatedAt: now,
        });
      }
      const id = randomUUID();
      const replaced =
        !relay && policy.coalesceKey && ['progress', 'notice'].includes(policy.deliveryClass)
          ? snapshot.messages
              .by('targetAddressId', target.id)
              .filter(
                (row) =>
                  row.senderAddressId === sender.id &&
                  row.status === 'queued' &&
                  !row.workKind &&
                  row.expiresAt > now &&
                  ['message', 'reply'].includes(row.kind) &&
                  row.deliveryClass === policy.deliveryClass &&
                  (row.deliveryTiming ?? 'after_turn') === policy.deliveryTiming &&
                  row.coalesceKey === policy.coalesceKey &&
                  row.relatedWorkId === policy.relatedWorkId,
              )
          : [];
      if (replaced.length) {
        const ids = replaced.map((row) => row.id);
        ctx.write(async (tx) => {
          await tx
            .update(agentBusMessages)
            .set({ supersededById: id, updatedAt: now })
            .where(
              and(
                eq(agentBusMessages.targetAddressId, target.id),
                eq(agentBusMessages.status, 'superseded'),
                inArray(agentBusMessages.supersededById, ids),
              ),
            );
        });
        for (const row of snapshot.messages.by('targetAddressId', target.id))
          if (row.status === 'superseded' && row.supersededById && ids.includes(row.supersededById))
            ctx.draft.upsert('agentBusMessages', { ...row, supersededById: id, updatedAt: now });
        for (const row of replaced)
          stageUpdate(ctx, 'agentBusMessages', row.id, {
            status: 'superseded',
            supersededById: id,
            updatedAt: now,
          });
      }
      const message = stageQueuedMessage(ctx, {
        ...newQueuedMessage({
          id,
          conversationId: conversation.id,
          sequence: conversation.nextSequence,
          sender,
          senderSessionId: session?.id ?? deliverySessionId,
          target,
          kind: 'reply',
          content,
          contentEnc: encrypt(content, keyring),
          clientMessageId,
          expiresAt: isoOffsetSeconds(ttl),
          now,
        }),
        ...policy,
        ...(replaced.length ? coalescedEventStats(replaced, now) : {}),
        replyToMessageId: parent.id,
        awaitingPresence: ownedAddressPresence(runtime, snapshot, target) === 'listening' ? 0 : 1,
      });
      if (!progress) stageConferenceSettlement(ctx, parent.id, now);
      stageConferenceCharge(ctx, conversation.id, now);
      stageUpdate(ctx, 'agentBusConversations', conversation.id, {
        nextSequence: conversation.nextSequence + 1,
        lastActivityAt: now,
        updatedAt: now,
      });
      if (relay) {
        if (
          !TERMINAL_MESSAGE_STATUSES.includes(parent.status as (typeof TERMINAL_MESSAGE_STATUSES)[number]) ||
          snapshot.messages.has(parent.id)
        )
          stageUpdate(ctx, 'agentBusMessages', parent.id, {
            deliverySessionId: deliverySessionId ?? parent.deliverySessionId,
            deliveryUpstreamSessionId: upstream ?? parent.deliveryUpstreamSessionId,
            updatedAt: now,
          });
        if (upstream) {
          assertOwnedHousekeeping(ctx, sender.hostId, sender.engine);
          stageUpdate(ctx, 'agentBusAddresses', sender.id, {
            lastUpstreamSessionId: upstream,
            continuity: 'native',
            readiness: sender.currentSessionId ? sender.readiness : 'resumable',
            lastSeenAt: now,
            updatedAt: now,
          });
        }
      }
      created = true;
      return () =>
        json({
          message: messageForParticipant(message(), content, sender, target),
          ...(recorded ? { task_result: recorded } : {}),
        });
    },
  })) as { message: Record<string, unknown> };
  const current = runtime.state.snapshot(),
    message = current.messages.get(String(result.message.id)),
    sender = message && current.addresses.get(message.senderAddressId),
    target = current.addresses.get(String((result.message.target as { id?: string })?.id));
  if (message && sender && target)
    result.message = relay
      ? messageMetadata(message, sender, target)
      : messageForParticipant(message, content, sender, target);
  if (created)
    wsPublisher.publish('agent_messaging.message.changed', {
      message_id: result.message.id,
      conversation_id: result.message.conversation_id,
      status: result.message.status,
    });
  if (relay) return { ...result, created, message: result.message };
  const presence = target ? ownedAddressPresence(runtime, current, target) : 'offline';
  return {
    ...result,
    created,
    message: result.message,
    ...deliveryTimingReceipt(String(result.message.delivery_timing ?? 'after_turn'), !!target?.currentSessionId &&
      receiverState(current.sessions.get(target.currentSessionId)?.receiver)?.delivery_timing_v1 === true),
    recipient_presence: presence,
    observed_at: nowIso(),
    delivery_hint: deliveryHint(presence),
  };
}
