import { stagePortalEvent } from './portal-events.js';
import { type AgentSession } from '../../db/schema.js';
import type { Keyring } from '../../security/keyring.js';
import { encrypt } from '../../security/secret-box.js';
import type { OwnerMutationContext } from './runtime.js';
import type { StateRow } from './catalog.js';
import { stageUpdate } from './rows.js';
import { stageSessionFinish } from './session-lifecycle.js';
import type { WatchdogFailure } from '../../services/watchdog-lifecycle.js';

export function stageUndeliveredNotice(
  context: OwnerMutationContext,
  message: Readonly<StateRow<'agentMessages'>>,
  now: string,
  keyring: Keyring,
): void {
  if (!['message', 'close'].includes(message.kind)) return;
  const close = message.kind === 'close';
  const payload = close
    ? {
        summary:
          'The close request could not be delivered to this agent. Use Force end to close the channel.',
      }
    : {
        message_id: message.messageId,
        summary: 'The agent never picked this up. It was not delivered.',
        delivery_status: 'canceled',
      };
  stagePortalEvent(context, {
    sessionId: message.sessionId,
    clientEventId: `server:${close ? 'close' : 'message'}-dead:${message.messageId}`,
    eventType: close ? 'attention' : 'message_canceled',
    source: 'portal',
    payloadEnc: encrypt(JSON.stringify(payload), keyring),
    createdAt: now,
  });
}
export function stageExpireAnswerPrompts(
  context: OwnerMutationContext,
  messageIds: readonly string[],
  now: string,
): void {
  const ids = new Set(messageIds);
  for (const row of context.draft.table('agentPrompts').all()) {
    if (row.status !== 'answered' || !row.answerMessageId || !ids.has(row.answerMessageId)) continue;
    stageUpdate(context, 'agentPrompts', row.id, {
      status: 'expired',
      answeredByUserId: null,
      answerMessageId: null,
      answeredAt: null,
      expiresAt: now,
      version: row.version + 1,
    });
  }
}
export function stageCancelSessionPending(
  context: OwnerMutationContext,
  sessionId: string,
  now: string,
  keyring: Keyring,
  options: { keepLeasedClose?: boolean; keepOpenPrompts?: boolean } = {},
): void {
  const pending = context.draft
    .table('agentMessages')
    .all()
    .filter((row) => row.sessionId === sessionId && row.status === 'queued');
  const answers = pending.filter((row) => row.kind === 'answer').map((row) => row.messageId);
  for (const row of pending) {
    stageUpdate(context, 'agentMessages', row.id, {
      status: 'canceled',
      canceledAt: now,
      leaseOwner: null,
      leaseUntil: null,
      updatedAt: now,
    });
    stageUndeliveredNotice(context, row, now, keyring);
  }
  if (!options.keepOpenPrompts)
    for (const row of context.draft.table('agentPrompts').all()) {
      if (row.sessionId === sessionId && row.status === 'open')
        stageUpdate(context, 'agentPrompts', row.id, {
          status: 'expired',
          expiresAt: now,
          version: row.version + 1,
        });
    }
  stageExpireAnswerPrompts(context, answers, now);
}
export function stagePortalSessionFinish(
  context: OwnerMutationContext,
  session: AgentSession,
  status: 'completed' | 'failed',
  expiresAt: string,
  now: string,
  keyring: Keyring,
  watchdogFailure?: WatchdogFailure,
): boolean {
  if (
    !session.closeRequestedAt &&
    context.draft
      .table('agentRebootHandoffs')
      .all()
      .some((row) => row.oldSessionId === session.id && row.status === 'armed')
  )
    return false;
  const bound = session.agentBusAddressId
    ? context.draft.table('agentBusAddresses').get(session.agentBusAddressId)
    : undefined;
  const ownedBinding = bound?.currentSessionId === session.id ? bound : undefined;
  if (ownedBinding && status === 'completed' && !session.closeRequestedAt)
    for (const message of context.draft.table('agentBusMessages').all()) {
      if (
        message.targetAddressId === ownedBinding.id &&
        message.deliverySessionId === session.id &&
        message.targetBindingGeneration === ownedBinding.bindingGeneration &&
        message.status === 'accepted' &&
        message.relayGeneration !== null &&
        message.leaseOwner?.startsWith('relay:') &&
        ((message.ownershipMode === 'connection' && message.ownerInstanceId !== null) ||
          (message.leaseUntil && message.leaseUntil > now))
      ) {
        stageUpdate(context, 'agentBusMessages', message.id, {
          targetBindingGeneration: ownedBinding.bindingGeneration + 1,
          updatedAt: now,
        });
      }
    }
  stageSessionFinish(context, session, status, now, watchdogFailure);
  if (ownedBinding) {
    const upstream = session.upstreamSessionId ?? ownedBinding.lastUpstreamSessionId;
    stageUpdate(context, 'agentBusAddresses', ownedBinding.id, {
      bindingGeneration: ownedBinding.bindingGeneration + 1,
      adapterProtocol: null,
      adapterCapabilities: null,
      lastUpstreamSessionId: upstream,
      readiness: upstream ? 'resumable' : 'offline',
      lastSeenAt:
        session.heartbeatAt > ownedBinding.lastSeenAt ? session.heartbeatAt : ownedBinding.lastSeenAt,
    });
    stageUpdate(context, 'agentSessions', session.id, { bindingGeneration: session.bindingGeneration + 1 });
  }
  stageUpdate(context, 'agentSessions', session.id, {
    status,
    relayEnabled: 0,
    relayHeartbeatAt: null,
    endedAt: now,
    expiresAt,
    activeTurnId: null,
    updatedAt: now,
  });
  const keepOpenPrompts =
    status === 'completed' &&
    context.draft
      .table('hostDaemonPortalBindings')
      .all()
      .some((row) => row.portalSessionId === session.id);
  stageCancelSessionPending(context, session.id, now, keyring, { keepOpenPrompts });
  return true;
}
