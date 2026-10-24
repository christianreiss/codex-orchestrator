import { persistAuditLog } from '../audit-log.js';
import { randomUUID } from 'node:crypto';
import { and, eq, ne } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import { agentBusMessages, agentTaskResults } from '../../db/schema.js';
import { ConflictError, NotFoundError, ValidationError } from '../../http/errors.js';
import type { Keyring } from '../../security/keyring.js';
import { encrypt } from '../../security/secret-box.js';
import { sha256 } from '../../security/hash.js';
import { nowIso, isoOffsetSeconds } from '../../util/timestamp.js';
import { isEngine } from '../../util/engine.js';
import { wsPublisher } from '../../ws/publisher.js';
import type { Json } from '../../control-plane/commands.js';
import { ownerPresence } from '../../control-plane/presence.js';
import type { StateRow } from '../../control-plane/state/catalog.js';
import type { OwnerStateSnapshot } from '../../control-plane/state/store.js';
import {
  mutateOwnerState,
  type OwnerMutationContext,
  type OwnerRuntime,
} from '../../control-plane/state/runtime.js';
import { stageUpdate } from '../../control-plane/state/rows.js';
import { stageQueuedMessage } from '../../control-plane/state/messages.js';
import { ownedAddress, requireOwnedMessaging } from '../../control-plane/state/messaging.js';
import { assertOwnedHousekeeping } from '../../control-plane/state/session-lifecycle.js';
import { quotaRecoveryAllowed } from '../quota-observation.js';
import { daemonAccepting } from '../host-daemon/policy.js';
import { receiverState } from '../agent-receiver-state.js';
import { ownedReceiverReady } from '../../control-plane/streams/receiver.js';
import {
  deliveryBackoffSeconds,
  normalizeErrorCode,
  normalizeOptionalText,
  normalizeUuid,
} from './normalize.js';
import { messageMetadata, newQueuedMessage } from './views.js';
import type { AgentMessagingOutcome } from './types.js';
import {
  AGENT_MESSAGING_CONFERENCE_MEMBER_MESSAGE_CAP,
  AGENT_MESSAGING_DEFAULT_TTL_SECONDS,
  AGENT_MESSAGING_MAX_DELIVERY_ATTEMPTS,
  TERMINAL_MESSAGE_STATUSES,
} from './constants.js';
import { taskResultSchema, unknownTaskResult, type TaskResult } from './task-execution.js';

export type OwnedMessage = StateRow<'agentBusMessages'>;
const json = (value: unknown): Json => JSON.parse(JSON.stringify(value)) as Json;
const lost = () =>
  new ConflictError('Message lease is no longer owned by this delivery', 'agent_messaging_lease_lost');

/** A connection is authority only for its exact receiver/native/relay incarnation. */
export function deliveryAttachment(
  runtime: OwnerRuntime,
  snapshot: OwnerStateSnapshot,
  leaseOwner: string,
  expectedInstance?: string | null,
): string {
  requireOwnedMessaging(snapshot);
  const presence = ownerPresence(runtime);
  if (leaseOwner.startsWith('relay:')) {
    const [, id, generation] = leaseOwner.split(':'),
      relay = snapshot.table('agentBusRelays').get(id!);
    if (
      !relay ||
      relay.status !== 'active' ||
      relay.generation !== Number(generation) ||
      (expectedInstance && expectedInstance !== relay.instanceId)
    )
      throw lost();
    if (
      !presence
        .all()
        .some(
          (a) =>
            a.scope.topic === 'relay' &&
            a.scope.relay_id === relay.id &&
            a.scope.binding_generation === relay.generation &&
            a.scope.native_instance_id === relay.instanceId,
        )
    )
      throw lost();
    return relay.instanceId;
  }
  const id = leaseOwner.startsWith('session:') ? leaseOwner.slice(8) : '',
    session = snapshot.sessions.get(id);
  if (!session || session.endedAt || !session.agentBusAddressId) throw lost();
  const address = ownedAddress(snapshot, session.agentBusAddressId);
  if (address.currentSessionId !== id || address.bindingGeneration !== session.bindingGeneration)
    throw lost();
  const receiver = receiverState(session.receiver);
  if (receiver) {
    if (!ownedReceiverReady(runtime, session, 'peer')) throw lost();
  }
  const native = snapshot.table('agentNativeControls').get(id);
  if (
    !native ||
    native.bindingGeneration !== session.bindingGeneration ||
    !['ready', 'requested', 'accepted'].includes(native.status) ||
    (expectedInstance && expectedInstance !== native.instanceId)
  )
    throw lost();
  if (
    !presence
      .session(id, session.bindingGeneration, 'session')
      .some((a) => a.scope.native_instance_id === native.instanceId)
  )
    throw lost();
  return native.instanceId;
}

export function assertOwnedDelivery(
  snapshot: OwnerStateSnapshot,
  message: OwnedMessage,
  claimId: string,
  leaseOwner: string,
  relayGeneration: number | null,
): void {
  if (
    message.leaseOwner !== leaseOwner ||
    message.claimId !== claimId ||
    (relayGeneration !== null && message.relayGeneration !== relayGeneration)
  )
    throw lost();
  const target = snapshot.addresses.get(message.targetAddressId);
  if (!target || target.bindingGeneration !== message.targetBindingGeneration)
    throw new ConflictError('Agent address binding changed', 'agent_messaging_binding_stale');
  if (relayGeneration !== null) {
    const relay = snapshot.table('agentBusRelays').get(leaseOwner.split(':')[1]!);
    if (
      !relay ||
      relay.generation !== relayGeneration ||
      relay.status !== 'active' ||
      (message.ownerInstanceId && message.ownerInstanceId !== relay.instanceId)
    )
      throw lost();
  } else {
    const session = snapshot.sessions.get(leaseOwner.slice(8));
    if (
      !session ||
      session.endedAt ||
      target.currentSessionId !== session.id ||
      session.bindingGeneration !== target.bindingGeneration
    )
      throw lost();
    const native = snapshot.table('agentNativeControls').get(session.id);
    if (message.ownerInstanceId && message.ownerInstanceId !== native?.instanceId) throw lost();
  }
}

export function renewOwnedDelivery(
  runtime: OwnerRuntime,
  messageId: string,
  rawClaimId: string,
  leaseOwner: string,
  relayGeneration: number | null,
): Record<string, unknown> {
  runtime.assertOwner();
  const snapshot = runtime.state.snapshot(),
    id = normalizeUuid(messageId, 'message_id'),
    claimId = normalizeUuid(rawClaimId, 'claim_id');
  requireOwnedMessaging(snapshot);
  const message = snapshot.messages.get(id);
  if (!message || !['leased', 'accepted', 'reboot_hold'].includes(message.status)) throw lost();
  assertOwnedDelivery(snapshot, message, claimId, leaseOwner, relayGeneration);
  if (message.status !== 'reboot_hold' && !(message.status === 'accepted' && !message.ownerInstanceId))
    deliveryAttachment(runtime, snapshot, leaseOwner, message.ownerInstanceId);
  if (message.status === 'leased' && message.expiresAt <= nowIso())
    throw new ConflictError('Message expired', 'agent_messaging_message_expired');
  // Compatibility renew is a read of current authority, never a timestamp write.
  return { message_id: id, lease_until: null, ownership_mode: 'connection' };
}

export function stageConferenceSettlement(ctx: OwnerMutationContext, parentId: string, now: string): void {
  for (const member of ctx.draft.table('agentBusConferenceMembers').by('dispatchMessageId', parentId))
    if (member.state === 'dispatched')
      stageUpdate(ctx, 'agentBusConferenceMembers', member.id, {
        state: 'seated',
        dispatchMessageId: null,
        dispatchDeadlineAt: null,
        lastReportAt: now,
        updatedAt: now,
      });
}
export function stageConferenceCharge(ctx: OwnerMutationContext, conversationId: string, now: string): void {
  const member = ctx.draft
    .table('agentBusConferenceMembers')
    .by('conversationId', conversationId)
    .find((m) => m.state !== 'left');
  if (!member) return;
  const spent = member.messageCount + 1;
  stageUpdate(ctx, 'agentBusConferenceMembers', member.id, { messageCount: spent, updatedAt: now });
  if (spent < AGENT_MESSAGING_CONFERENCE_MEMBER_MESSAGE_CAP) return;
  stageUpdate(ctx, 'agentBusConferenceMembers', member.id, {
    state: 'left',
    leftAt: now,
    dispatchMessageId: null,
    dispatchDeadlineAt: null,
    updatedAt: now,
  });
  stageUpdate(ctx, 'agentBusConversations', conversationId, {
    status: 'canceled',
    canceledBy: 'system:conference_budget_spent',
    cancelReason: `Conference budget spent (${AGENT_MESSAGING_CONFERENCE_MEMBER_MESSAGE_CAP} messages)`,
    canceledAt: now,
    updatedAt: now,
  });
}
export function stageDigestPresented(ctx: OwnerMutationContext, root: OwnedMessage, now: string): void {
  if (root.kind === 'digest')
    for (const child of ctx.draft.table('agentBusMessages').by('digestId', root.id))
      if (child.status === 'batched')
        stageUpdate(ctx, 'agentBusMessages', child.id, {
          status: 'digested',
          presentedAt: now,
          updatedAt: now,
        });
}
export function stageOwnedTaskResult(
  ctx: OwnerMutationContext,
  message: OwnedMessage,
  raw: TaskResult,
  keyring: Keyring,
  now: string,
): TaskResult {
  if (!message.workKind || !message.claimId) throw new ValidationError('Only claimed work has a task result');
  const result = taskResultSchema.parse(raw),
    body = JSON.stringify(result),
    bodySha256 = sha256(body);
  const previous = ctx.draft
    .table('agentTaskResults')
    .by('messageId', message.id)
    .find((r) => r.claimId === message.claimId);
  if (previous) {
    if (previous.bodySha256 !== bodySha256)
      throw new ConflictError(
        'A different result already exists for this execution',
        'agent_task_result_conflict',
      );
    return result;
  }
  if (message.status !== 'accepted' && !(message.cancelRequestedAt && message.acceptedAt))
    throw new ConflictError(
      'Task must be accepted before its result is stored',
      'agent_task_result_not_accepted',
    );
  const row = {
    id: randomUUID(),
    messageId: message.id,
    claimId: message.claimId,
    status: result.status,
    bodySha256,
    createdAt: now,
  };
  ctx.draft.upsert('agentTaskResults', row);
  ctx.write(async (tx) => {
    await tx.insert(agentTaskResults).values({ ...row, bodyEnc: encrypt(body, keyring) });
  });
  stageUpdate(ctx, 'agentBusMessages', message.id, { taskResultStatus: result.status });
  return result;
}
async function stageResultReply(
  db: Database,
  ctx: OwnerMutationContext,
  message: OwnedMessage,
  report: TaskResult,
  keyring: Keyring,
  now: string,
): Promise<void> {
  if (message.kind === 'schedule' || message.sourceEngine === 'server') return;
  if (
    ctx.draft
      .table('agentBusMessages')
      .by('replyToMessageId', message.id)
      .some((m) => m.senderAddressId === message.targetAddressId && m.deliveryClass !== 'progress')
  )
    return;
  // Completed replies may have left the active working set. Consult their
  // immutable history only for this explicit result command.
  const [old] = await db
    .select({ id: agentBusMessages.id })
    .from(agentBusMessages)
    .where(
      and(
        eq(agentBusMessages.replyToMessageId, message.id),
        eq(agentBusMessages.senderAddressId, message.targetAddressId),
        ne(agentBusMessages.deliveryClass, 'progress'),
      ),
    )
    .limit(1);
  if (old) return;
  const conversation = ctx.draft.table('agentBusConversations').get(message.conversationId),
    sender = ctx.draft.table('agentBusAddresses').get(message.targetAddressId),
    target = ctx.draft.table('agentBusAddresses').get(message.senderAddressId);
  if (
    !conversation ||
    conversation.status !== 'open' ||
    !sender ||
    !target ||
    target.archivedAt ||
    !target.enabled
  )
    return;
  stageQueuedMessage(ctx, {
    ...newQueuedMessage({
      id: randomUUID(),
      conversationId: conversation.id,
      sequence: conversation.nextSequence,
      sender,
      senderSessionId: message.deliverySessionId,
      target,
      kind: 'reply',
      deliveryClass: 'coordination',
      content: report.summary,
      contentEnc: encrypt(report.summary, keyring),
      clientMessageId: randomUUID(),
      expiresAt: isoOffsetSeconds(AGENT_MESSAGING_DEFAULT_TTL_SECONDS),
      now,
    }),
    replyToMessageId: message.id,
  });
  stageUpdate(ctx, 'agentBusConversations', conversation.id, {
    nextSequence: conversation.nextSequence + 1,
    lastActivityAt: now,
    updatedAt: now,
  });
  stageConferenceCharge(ctx, conversation.id, now);
}

export function ownedFreshStartAllowed(snapshot: OwnerStateSnapshot, message: OwnedMessage): boolean {
  const grant = snapshot.table('agentFreshStartGrants').get(message.id),
    target = snapshot.addresses.get(message.targetAddressId);
  return !!(
    message.kind !== 'schedule' &&
    message.workKind &&
    grant &&
    target &&
    grant.targetAddressId === target.id &&
    grant.bindingGeneration === target.bindingGeneration &&
    grant.executionVersion === message.executionVersion &&
    !grant.consumedAt
  );
}
export async function assertOwnedScheduleAcceptance(
  db: Database,
  snapshot: OwnerStateSnapshot,
  message: OwnedMessage,
  upstreamSessionId: string | null,
): Promise<void> {
  if (message.kind !== 'schedule') return;
  const run = snapshot.table('agentScheduleRuns').by('messageId', message.id)[0],
    target = snapshot.addresses.get(message.targetAddressId);
  const watchdog = run && snapshot.table('agentWatchdogs').by('scheduleId', run.scheduleId)[0];
  if (
    watchdog &&
    (!['watching', 'recovering', 'capacity_wait'].includes(watchdog.status) ||
      watchdog.deadlineAt <= nowIso() ||
      target?.lastUpstreamSessionId !== watchdog.nativeSessionId ||
      (upstreamSessionId && upstreamSessionId !== watchdog.nativeSessionId))
  )
    throw new ConflictError(
      'Watchdog recovery expired or native binding changed',
      'watchdog_recovery_unavailable',
    );
  const quota = watchdog?.quotaAccountId
    ? { account_id: watchdog.quotaAccountId, window: watchdog.quotaWindow }
    : run?.quotaRecovery;
  if (
    quota &&
    target &&
    isEngine(target.engine) &&
    !(await quotaRecoveryAllowed(db, target.engine, quota.account_id, quota.window))
  )
    throw new ConflictError('Quota recovery policy changed', 'quota_recovery_disabled');
}

export interface OwnedAckInput {
  claimId: string;
  outcome: AgentMessagingOutcome;
  taskResult?: TaskResult;
  upstreamSessionId?: string | null;
  errorCode?: string | null;
  error?: string | null;
}
export async function acknowledgeOwnedDelivery(
  db: Database,
  runtime: OwnerRuntime,
  keyring: Keyring,
  messageId: string,
  input: OwnedAckInput,
  leaseOwner: string,
  relayGeneration: number | null,
  deliverySessionId: string | null,
): Promise<Record<string, unknown>> {
  const id = normalizeUuid(messageId, 'message_id'),
    claimId = normalizeUuid(input.claimId, 'claim_id');
  const errorCode = normalizeErrorCode(input.errorCode),
    errorText = normalizeOptionalText(input.error, 4096),
    upstreamSessionId = normalizeOptionalText(input.upstreamSessionId, 255);
  let requireAttachment: OwnedMessage | undefined;
  const result = await mutateOwnerState(runtime, {
    kind: 'messaging.ack',
    principal: leaseOwner,
    id: `${claimId}:${input.outcome}`,
    payload: json({
      messageId: id,
      claimId,
      outcome: input.outcome,
      taskResult: input.taskResult ?? null,
      upstreamSessionId,
      errorCode,
      errorText,
      deliverySessionId,
    }),
    authorize(snapshot) {
      requireOwnedMessaging(snapshot);
      if (requireAttachment)
        deliveryAttachment(runtime, snapshot, leaseOwner, requireAttachment.ownerInstanceId);
    },
    async prepare(ctx) {
      const snapshot = ctx.snapshot;
      let message = snapshot.messages.get(id);
      if (!message) {
        const [historical] = await db
          .select()
          .from(agentBusMessages)
          .where(eq(agentBusMessages.id, id))
          .limit(1);
        if (!historical) throw new NotFoundError('Message not found', 'agent_messaging_message_not_found');
        message = historical;
        // Explicit receipt replay only. A missing live row indicates a broken
        // hydration contract and must never silently mutate cold state.
        if (!TERMINAL_MESSAGE_STATUSES.includes(message.status as (typeof TERMINAL_MESSAGE_STATUSES)[number]))
          throw new Error('Active delivery missing from owned working set');
      }
      assertOwnedDelivery(snapshot, message, claimId, leaseOwner, relayGeneration);
      if (message.status === 'reboot_hold') return json({ message: messageMetadata(message) });
      if (input.taskResult && (!message.workKind || input.outcome !== 'completed'))
        throw new ValidationError('Only completed work deliveries accept a task result');
      if (TERMINAL_MESSAGE_STATUSES.includes(message.status as (typeof TERMINAL_MESSAGE_STATUSES)[number])) {
        if (message.cancelRequestedAt && snapshot.messages.has(message.id)) {
          const now = nowIso();
          // Revocation cannot erase a late fact from the exact original offer.
          // It remains terminal and never re-enters dispatch.
          if (input.outcome === 'accepted' && !message.acceptedAt)
            message = stageUpdate(ctx, 'agentBusMessages', message.id, { acceptedAt: now, updatedAt: now });
          if (input.outcome === 'completed' && message.acceptedAt) {
            if (message.workKind) {
              const report = stageOwnedTaskResult(
                ctx,
                message,
                input.taskResult ?? unknownTaskResult,
                keyring,
                now,
              );
              message = stageUpdate(ctx, 'agentBusMessages', message.id, {
                taskResultStatus: report.status,
                completedAt: message.completedAt ?? now,
                updatedAt: now,
              });
            } else
              message = stageUpdate(ctx, 'agentBusMessages', message.id, {
                completedAt: message.completedAt ?? now,
                updatedAt: now,
              });
          }
        } else if (input.taskResult) stageOwnedTaskResult(ctx, message, input.taskResult, keyring, nowIso());
        return json({ message: messageMetadata(message) });
      }
      const now = nowIso(),
        target = snapshot.addresses.get(message.targetAddressId)!;
      if (
        message.kind === 'presence_notice' &&
        (relayGeneration !== null ||
          target.currentSessionId !== message.targetSessionId ||
          !message.targetSessionId ||
          snapshot.sessions.get(message.targetSessionId)?.endedAt)
      )
        throw lost();
      if (input.outcome === 'accepted') {
        if (message.status === 'accepted') return json({ message: messageMetadata(message) });
        if (message.status !== 'leased')
          throw new ConflictError('Only a leased message can be accepted', 'agent_messaging_ack_invalid');
        requireAttachment = message;
        deliveryAttachment(runtime, snapshot, leaseOwner, message.ownerInstanceId);
        await assertOwnedScheduleAcceptance(db, snapshot, message, upstreamSessionId);
        if (ownedFreshStartAllowed(snapshot, message))
          stageUpdate(ctx, 'agentFreshStartGrants', message.id, {
            consumedAt: now,
            consumedClaimId: claimId,
          });
        const remote = snapshot.table('hostDaemonSessions').by('addressId', message.targetAddressId)[0];
        if (relayGeneration !== null && remote?.activeMessageId === message.id) {
          const daemon = snapshot.daemons.get(remote.hostId);
          if (!daemon || !daemonAccepting(daemon.settings))
            throw new ConflictError('Host daemon deadline expired or disabled', 'daemon_disabled');
        }
      }
      if (
        ['accepted', 'completed'].includes(input.outcome) &&
        message.status === 'leased' &&
        message.expiresAt <= now
      )
        throw new ConflictError('Message expired before acceptance', 'agent_messaging_message_expired');
      if (input.outcome === 'retry' && message.status === 'accepted')
        throw new ConflictError('Accepted delivery cannot be retried safely', 'agent_messaging_ack_invalid');
      const shared = {
        deliverySessionId: deliverySessionId ?? message.deliverySessionId,
        deliveryUpstreamSessionId: upstreamSessionId ?? message.deliveryUpstreamSessionId,
        lastErrorCode: errorCode,
        lastErrorEnc: errorText ? encrypt(errorText, keyring) : null,
        updatedAt: now,
      };
      let patch: Partial<typeof agentBusMessages.$inferInsert>;
      switch (input.outcome) {
        case 'accepted':
          patch = {
            ...shared,
            status: 'accepted',
            acceptedAt: message.kind === 'schedule' ? now : (message.acceptedAt ?? now),
            leaseUntil: null,
            ownershipMode: 'connection',
          };
          break;
        case 'completed':
          patch = {
            ...shared,
            status: 'completed',
            acceptedAt: message.acceptedAt ?? now,
            completedAt: now,
            leaseUntil: null,
          };
          break;
        case 'ambiguous':
          patch = { ...shared, status: 'ambiguous', ambiguousAt: now, leaseUntil: null };
          break;
        case 'dead':
          patch = { ...shared, status: 'dead', deadAt: now, leaseUntil: null };
          break;
        case 'retry':
          patch =
            message.attempts >= AGENT_MESSAGING_MAX_DELIVERY_ATTEMPTS
              ? {
                  ...shared,
                  status: 'dead',
                  deadAt: now,
                  lastErrorCode: errorCode ?? 'delivery_attempts_exhausted',
                  leaseUntil: null,
                }
              : {
                  ...shared,
                  status: 'queued',
                  nextAttemptAt: isoOffsetSeconds(deliveryBackoffSeconds(message.attempts)),
                  leaseOwner: null,
                  leaseUntil: null,
                  claimId: null,
                  relayGeneration: null,
                  ownerInstanceId: null,
                };
          break;
      }
      if (input.outcome === 'completed' && message.workKind) {
        const report = stageOwnedTaskResult(
          ctx,
          message,
          input.taskResult ?? unknownTaskResult,
          keyring,
          now,
        );
        patch.taskResultStatus = report.status;
        if (input.taskResult) await stageResultReply(db, ctx, message, report, keyring, now);
        stageConferenceSettlement(ctx, message.id, now);
      }
      const changed = stageUpdate(ctx, 'agentBusMessages', id, patch);
      if (input.outcome === 'completed') stageDigestPresented(ctx, message, now);
      if (upstreamSessionId && !['retry', 'dead'].includes(input.outcome)) {
        assertOwnedHousekeeping(ctx, target.hostId, target.engine);
        stageUpdate(ctx, 'agentBusAddresses', target.id, {
          lastUpstreamSessionId: upstreamSessionId,
          continuity: 'native',
          readiness: target.currentSessionId ? target.readiness : 'resumable',
          lastSeenAt: now,
          updatedAt: now,
        });
      }
      const action = ['completed', 'dead', 'ambiguous'].includes(changed.status)
        ? `agent_message.${changed.status}`
        : 'agent_message.delivery';
      ctx.write(async (tx) => {
        await persistAuditLog(tx, {
          hostId: target.hostId,
          action,
          engine: target.engine,
          details: JSON.stringify({
            message_id: id,
            conversation_id: message.conversationId,
            status: changed.status,
            attempts: changed.attempts,
            error_code: changed.lastErrorCode,
          }),
          createdAt: now,
        });
      });
      return json({ message: messageMetadata(changed) });
    },
  });
  wsPublisher.publish('agent_messaging.message.changed', { message_id: id });
  return result as Record<string, unknown>;
}
