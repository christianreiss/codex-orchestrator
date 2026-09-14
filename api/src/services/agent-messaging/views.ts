/**
 * Row-to-wire projections and the neutral queued-message row builder.
 *
 * Part of the `agent-messaging` module; the public interface is the
 * `AgentMessagingService` facade in `../agent-messaging.ts`.
 */

import {
  agentBusMessages,
  type AgentBusAddress,
  type AgentBusConferenceMember,
  type AgentBusConversation,
  type AgentBusMessage,
} from '../../db/schema.js';
import { type AgentAddressPresence } from '../agent-presence.js';
import { AGENT_MESSAGING_CONFERENCE_MEMBER_MESSAGE_CAP } from './constants.js';
import { jsonRecord } from './normalize.js';
import type { MessageDelivery } from './types.js';

/**
 * One queued message row, with every column that has no per-call meaning set to
 * its neutral value.
 *
 * `sendMessage`, `replyMessage`, `replyFromRelayDelivery` and `redriveMessage`
 * each carry their own hand-written copy of this 30-field literal. Those are
 * left alone; this exists so `joinCall` does not become the fifth.
 */
export function newQueuedMessage(input: {
  id: string;
  conversationId: string;
  sequence: number;
  sender: AgentBusAddress;
  senderSessionId: string | null;
  target: AgentBusAddress;
  kind: string;
  content: string;
  contentEnc: string;
  clientMessageId: string;
  expiresAt: string;
  now: string;
}): typeof agentBusMessages.$inferInsert {
  return {
    id: input.id,
    conversationId: input.conversationId,
    sequence: input.sequence,
    replyToMessageId: null,
    redriveOfMessageId: null,
    senderAddressId: input.sender.id,
    senderSessionId: input.senderSessionId,
    targetAddressId: input.target.id,
    sourceEngine: input.sender.engine,
    targetEngine: input.target.engine,
    kind: input.kind,
    contentEnc: input.contentEnc,
    contentBytes: Buffer.byteLength(input.content, 'utf8'),
    clientMessageId: input.clientMessageId,
    status: 'queued',
    attempts: 0,
    nextAttemptAt: input.now,
    leaseOwner: null,
    leaseUntil: null,
    claimId: null,
    relayGeneration: null,
    targetBindingGeneration: null,
    deliverySessionId: null,
    deliveryUpstreamSessionId: null,
    expiresAt: input.expiresAt,
    lastErrorCode: null,
    lastErrorEnc: null,
    cancelRequestedAt: null,
    acceptedAt: null,
    completedAt: null,
    ambiguousAt: null,
    deadAt: null,
    expiredAt: null,
    canceledAt: null,
    createdAt: input.now,
    updatedAt: input.now,
  };
}

/**
 * Roster projection.
 *
 * `fqdn` and `engine` are read off the joined host and address rather than off
 * the member row, because a member declares only its `purpose`. Everything else
 * about who it is comes from what the fleet already knows, so a participant
 * cannot misreport the box it is running on.
 */
export function publicConferenceMember(
  member: AgentBusConferenceMember,
  address: AgentBusAddress,
  fqdn: string | null,
): Record<string, unknown> {
  return {
    address: address.address,
    alias: address.displayAlias,
    engine: address.engine,
    fqdn,
    username: address.username,
    cwd: address.cwd,
    role: member.role,
    purpose: member.purpose,
    mode: member.mode,
    state: member.state,
    messages_used: member.messageCount,
    messages_budget: AGENT_MESSAGING_CONFERENCE_MEMBER_MESSAGE_CAP,
    dispatched_at: member.dispatchedAt,
    dispatch_deadline_at: member.dispatchDeadlineAt,
    last_report_at: member.lastReportAt,
    joined_at: member.joinedAt,
  };
}

/**
 * `presence` is supplied only by the surfaces that enumerate peers, because it
 * is the one field here that cannot be read off the address row — deriving it
 * needs the joined session. Point payloads (a registration ack, the peer on a
 * call) omit it rather than guess: an absent field is honest, a stale one is
 * the bug this whole change removes. `readiness` is retained on the wire for
 * compatibility and carries no liveness meaning for a non-relay session.
 */
export function publicAddress(address: AgentBusAddress, fqdn?: string, presence?: AgentAddressPresence): Record<string, unknown> {
  return {
    id: address.id,
    address: address.address,
    alias: address.displayAlias,
    engine: address.engine,
    host_id: address.hostId,
    ...(fqdn ? { fqdn } : {}),
    username: address.username,
    cwd: address.cwd,
    enabled: address.enabled === 1,
    continuity: address.continuity,
    ...(presence ? { presence } : {}),
    readiness: address.readiness,
    adapter_protocol: address.adapterProtocol,
    adapter_capabilities: jsonRecord(address.adapterCapabilities),
    binding_generation: address.bindingGeneration,
    receive_heartbeat_at: address.receiveHeartbeatAt,
    last_seen_at: address.lastSeenAt,
    created_at: address.createdAt,
  };
}

export function messageMetadata(message: AgentBusMessage, sender?: AgentBusAddress, target?: AgentBusAddress): Record<string, unknown> {
  return {
    id: message.id,
    conversation_id: message.conversationId,
    sequence: message.sequence,
    reply_to_message_id: message.replyToMessageId,
    redrive_of_message_id: message.redriveOfMessageId,
    sender: sender ? publicAddress(sender) : { id: message.senderAddressId, engine: message.sourceEngine },
    target: target ? publicAddress(target) : { id: message.targetAddressId, engine: message.targetEngine },
    kind: message.kind,
    content_bytes: message.contentBytes,
    status: message.status,
    attempts: message.attempts,
    expires_at: message.expiresAt,
    last_error_code: message.lastErrorCode,
    accepted_at: message.acceptedAt,
    completed_at: message.completedAt,
    ambiguous_at: message.ambiguousAt,
    dead_at: message.deadAt,
    expired_at: message.expiredAt,
    canceled_at: message.canceledAt,
    created_at: message.createdAt,
    updated_at: message.updatedAt,
  };
}

export function messageForParticipant(message: AgentBusMessage, content: string, sender: AgentBusAddress, target: AgentBusAddress): Record<string, unknown> {
  return { ...messageMetadata(message, sender, target), content };
}

export function deliveryView(message: AgentBusMessage, content: string, sender: AgentBusAddress, target: AgentBusAddress): MessageDelivery {
  return {
    message_id: message.id,
    conversation_id: message.conversationId,
    sequence: message.sequence,
    reply_to_message_id: message.replyToMessageId,
    kind: message.kind,
    content,
    content_bytes: message.contentBytes,
    sender: publicAddress(sender),
    target: {
      ...publicAddress(target),
      upstream_session_id: target.lastUpstreamSessionId,
    },
    attempts: message.attempts,
    claim_id: message.claimId!,
    lease_owner: message.leaseOwner!,
    lease_until: message.leaseUntil!,
    expires_at: message.expiresAt,
  };
}

export function conversationMetadata(conversation: AgentBusConversation): Record<string, unknown> {
  return {
    id: conversation.id,
    address_a_id: conversation.addressAId,
    address_b_id: conversation.addressBId,
    created_by_address_id: conversation.createdByAddressId,
    status: conversation.status,
    next_sequence: conversation.nextSequence,
    last_activity_at: conversation.lastActivityAt,
    canceled_by: conversation.canceledBy,
    cancel_reason: conversation.cancelReason,
    canceled_at: conversation.canceledAt,
    created_at: conversation.createdAt,
    updated_at: conversation.updatedAt,
  };
}
