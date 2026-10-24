import { conversationMetadata } from './views.js';
import { NotFoundError } from '../../http/errors.js';
import type { OwnerMutationContext, OwnerRuntime } from '../../control-plane/state/runtime.js';
import { mutateOwnerState } from '../../control-plane/state/runtime.js';
import { stageUpdate } from '../../control-plane/state/rows.js';
import { ownedBridge } from '../../control-plane/state/messaging.js';
import { normalizeUuid, normalizeOptionalText } from './normalize.js';

/** Revoke delivery without erasing the identity of work that may have started. */
export function stageCancelOwnedConversation(
  ctx: OwnerMutationContext,
  id: string,
  by: string,
  reason: string,
  now: string,
) {
  const row = ctx.draft.table('agentBusConversations').get(id);
  if (!row) throw new NotFoundError('Conversation not found', 'agent_messaging_conversation_not_found');
  let canceled = 0,
    uncertain = 0;
  if (row.status !== 'canceled')
    stageUpdate(ctx, 'agentBusConversations', id, {
      status: 'canceled',
      canceledBy: by,
      cancelReason: reason,
      canceledAt: now,
      updatedAt: now,
    });
  for (const message of ctx.draft.table('agentBusMessages').by('conversationId', id)) {
    if (!['queued', 'leased', 'accepted', 'batched', 'reboot_hold'].includes(message.status)) continue;
    const offered = ['leased', 'accepted', 'reboot_hold'].includes(message.status);
    stageUpdate(ctx, 'agentBusMessages', message.id, {
      status: offered ? 'ambiguous' : 'canceled',
      cancelRequestedAt: now,
      canceledAt: now,
      ...(offered ? { ambiguousAt: now } : {}),
      leaseUntil: null,
      lastErrorCode: 'conversation_canceled',
      updatedAt: now,
      ...(!offered ? { leaseOwner: null, claimId: null, relayGeneration: null, ownerInstanceId: null } : {}),
    });
    canceled++;
    if (offered) uncertain++;
  }
  return {
    conversation_id: id,
    status: 'canceled',
    conversation: conversationMetadata(ctx.draft.table('agentBusConversations').get(id)!),
    canceled_messages: canceled - uncertain,
    ambiguous_messages: uncertain,
    uncertain_deliveries: uncertain,
  };
}
export async function cancelOwnedConversation(
  runtime: OwnerRuntime,
  id: string,
  by: string,
  reason: string,
  participant?: { sessionId: string; token: string },
) {
  const conversationId = normalizeUuid(id, 'conversation_id'),
    note = normalizeOptionalText(reason, 1000) ?? 'Canceled';
  return mutateOwnerState(runtime, {
    kind: 'messaging.conversation.cancel',
    payload: { id: conversationId, by, reason: note },
    authorize: (s) => {
      if (participant) {
        const session = ownedBridge(s, participant.sessionId, participant.token).session,
          row = s.table('agentBusConversations').get(conversationId);
        if (!row || ![row.addressAId, row.addressBId].includes(session.agentBusAddressId ?? ''))
          throw new NotFoundError('Conversation not found', 'agent_messaging_conversation_not_found');
      }
    },
    prepare: (ctx) =>
      JSON.parse(
        JSON.stringify(stageCancelOwnedConversation(ctx, conversationId, by, note, new Date().toISOString())),
      ),
  });
}
