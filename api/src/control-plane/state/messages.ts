import { recordMessagingRowChange } from './messaging-totals.js';
import {
  agentBusAddresses,
  agentBusMessages,
  type AgentBusAddress,
  type AgentBusMessage,
} from '../../db/schema.js';
import { ConflictError } from '../../http/errors.js';
import { sha256 } from '../../security/hash.js';
import { SERVER_ADDRESS_ID, SERVER_PUBLICATION_TOPIC } from '../../services/agent-messaging/groups.js';
import type { OwnerMutationContext } from './runtime.js';

/** New messages enter RAM only after MySQL returns their global dispatch order. */
export function stageQueuedMessage(
  context: OwnerMutationContext,
  input: typeof agentBusMessages.$inferInsert,
): () => AgentBusMessage {
  const complete: Omit<AgentBusMessage, 'dispatchOrder'> = {
    replyToMessageId: null,
    redriveOfMessageId: null,
    senderName: null,
    targetName: null,
    requestedTarget: null,
    senderSessionId: null,
    targetSessionId: null,
    presenceNoticeKey: null,
    awaitingPresence: 0,
    kind: 'message',
    deliveryClass: 'information',
    deliveryTiming: 'after_turn',
    coalesceKey: null,
    relatedWorkId: null,
    eventCount: 1,
    eventFirstAt: null,
    eventLastAt: null,
    digestId: null,
    supersededById: null,
    presentedAt: null,
    executionContractVersion: 1,
    workKind: null,
    taskResultStatus: null,
    executionVersion: 1,
    status: 'queued',
    attempts: 0,
    leaseOwner: null,
    leaseUntil: null,
    claimId: null,
    ownershipMode: 'connection',
    ownerInstanceId: null,
    relayGeneration: null,
    targetBindingGeneration: null,
    deliverySessionId: null,
    deliveryUpstreamSessionId: null,
    lastErrorCode: null,
    lastErrorEnc: null,
    cancelRequestedAt: null,
    acceptedAt: null,
    completedAt: null,
    ambiguousAt: null,
    deadAt: null,
    expiredAt: null,
    canceledAt: null,
    ...input,
  };
  let result: AgentBusMessage | undefined;
  context.write(async (tx) => {
    const [inserted] = await tx.insert(agentBusMessages).values(complete);
    const dispatchOrder = Number(inserted.insertId);
    if (!Number.isSafeInteger(dispatchOrder) || dispatchOrder <= 0)
      throw new Error('Message insert returned no safe dispatch order');
    result = { ...complete, dispatchOrder };
    recordMessagingRowChange(context.draft, 'agentBusMessages', null, result);
    context.draft.upsert('agentBusMessages', result);
    const conversation = context.draft.table('agentBusConversations').get(result.conversationId);
    if (!conversation) throw new Error('Queued message conversation is absent');
    context.draft.upsert('agentBusConversations', {
      ...conversation,
      lastToASequence:
        result.targetAddressId === conversation.addressAId
          ? Math.max(conversation.lastToASequence, result.sequence)
          : conversation.lastToASequence,
      lastToBSequence:
        result.targetAddressId === conversation.addressBId
          ? Math.max(conversation.lastToBSequence, result.sequence)
          : conversation.lastToBSequence,
    });
  });
  return () => {
    if (!result) throw new Error('Message result requested before persistence');
    return result;
  };
}

export function stageServerAddress(context: OwnerMutationContext, now: string): AgentBusAddress {
  const row = context.draft.table('agentBusAddresses').get(SERVER_ADDRESS_ID);
  if (row) {
    if (
      row.engine !== 'server' ||
      row.hostId !== 0 ||
      row.currentSessionId !== null ||
      row.enabled !== 1 ||
      row.archivedAt !== null
    )
      throw new ConflictError(
        'Reserved Server identity conflicts',
        'agent_messaging_server_identity_conflict',
      );
    return row;
  }
  const created: AgentBusAddress = {
    id: SERVER_ADDRESS_ID,
    address: SERVER_PUBLICATION_TOPIC,
    displayAlias: null,
    launchName: null,
    hostId: 0,
    engine: 'server',
    username: 'Server',
    cwd: '/',
    cwdHash: sha256('/'),
    enabled: 1,
    currentSessionId: null,
    lastUpstreamSessionId: null,
    bindingGeneration: 0,
    continuity: 'server',
    adapterProtocol: null,
    adapterCapabilities: null,
    readiness: 'offline',
    receiveHeartbeatAt: null,
    lastSeenAt: now,
    archivedAt: null,
    createdAt: now,
    updatedAt: now,
  };
  context.draft.upsert('agentBusAddresses', created);
  context.write(async (tx) => {
    await tx.insert(agentBusAddresses).values(created);
  });
  return created;
}
