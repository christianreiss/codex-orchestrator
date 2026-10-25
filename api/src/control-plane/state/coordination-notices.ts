import { randomUUID } from 'node:crypto';
import { agentBusConversations } from '../../db/schema.js';
import { ApiError } from '../../http/errors.js';
import type { Keyring } from '../../security/keyring.js';
import { encrypt } from '../../security/secret-box.js';
import { newQueuedMessage } from '../../services/agent-messaging/views.js';
import type { StateRow } from './catalog.js';
import type { OwnerMutationContext } from './runtime.js';
import { ownedAddress } from './messaging.js';
import { stageQueuedMessage, stageServerAddress } from './messages.js';

/** Stage the exact notice and its delivery binding with the caller's mutation. */
export function stageCoordinationNotice(
  ctx: OwnerMutationContext,
  keyring: Keyring,
  session: StateRow<'agentSessions'>,
  content: string,
  options: {
    roomQuestion?: boolean;
    expiresAt?: string;
    clientMessageId?: string;
    deliveryClass?: 'notice' | 'coordination';
    ttlSeconds?: number;
  } = {},
): string | undefined {
  if (!session.agentBusAddressId || session.endedAt) return;
  const target = ctx.draft.table('agentBusAddresses').get(session.agentBusAddressId);
  if (
    !target ||
    target.currentSessionId !== session.id ||
    target.bindingGeneration !== session.bindingGeneration
  )
    return;
  try {
    ownedAddress(ctx.draft.view(), target.id);
  } catch (error) {
    if (error instanceof ApiError && [403, 404, 423].includes(error.status)) return;
    throw error;
  }
  const now = new Date().toISOString(),
    sender = stageServerAddress(ctx, now),
    conversationId = randomUUID(),
    messageId = randomUUID();
  const conversation = {
    id: conversationId,
    addressAId: sender.id,
    addressBId: target.id,
    createdByAddressId: sender.id,
    nextSequence: 2,
    status: 'open',
    lastActivityAt: now,
    canceledBy: null,
    cancelReason: null,
    canceledAt: null,
    createdAt: now,
    updatedAt: now,
  };
  ctx.draft.upsert('agentBusConversations', conversation);
  ctx.write(async (tx) => tx.insert(agentBusConversations).values(conversation));
  stageQueuedMessage(ctx, {
    ...newQueuedMessage({
      id: messageId,
      conversationId,
      sequence: 1,
      sender,
      senderSessionId: null,
      target,
      kind: options.roomQuestion ? 'message' : 'presence_notice',
      deliveryClass: options.roomQuestion ? 'coordination' : (options.deliveryClass ?? 'notice'),
      content,
      contentEnc: encrypt(content, keyring),
      clientMessageId: options.clientMessageId ?? randomUUID(),
      expiresAt: options.expiresAt ?? new Date(Date.now() + (options.ttlSeconds ?? 86400) * 1000).toISOString(),
      now,
    }),
    targetSessionId: session.id,
    targetBindingGeneration: target.bindingGeneration,
  });
  return messageId;
}
