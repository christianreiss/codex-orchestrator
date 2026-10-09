import { randomUUID } from 'node:crypto';
import { and, eq, gt, inArray, isNull, ne, or, sql } from 'drizzle-orm';
import { agentBusAddresses, agentBusConversations, agentBusMessages, agentSessions, type AgentBusAddress } from '../../db/schema.js';
import type { Env } from '../../env.js';
import { ApiError } from '../../http/errors.js';
import type { Keyring } from '../../security/keyring.js';
import { encrypt } from '../../security/secret-box.js';
import { deriveAddressPresence, isPresent, type AgentAddressPresence } from '../agent-presence.js';
import { newQueuedMessage } from './views.js';
import type { AgentMessagingDb } from './types.js';

export function deliveryHint(presence: AgentAddressPresence): string {
  if (presence === 'listening') return 'Stored by the server; recipient is online and ready to receive. Not yet proof of acceptance or reading.';
  if (presence === 'online') return 'Stored by the server; recipient is online but reception is not ready. Delivery is waiting.';
  if (presence === 'disabled') return 'Stored receipt; recipient is now disabled. Check the message status for delivery outcome.';
  return 'Stored by the server; recipient is offline. Delivery is waiting; a background worker may resume the existing conversation.';
}

export async function recipientSnapshot(tx: AgentMessagingDb, address: AgentBusAddress, env: Env, now = new Date()) {
  const [session] = address.currentSessionId
    ? await tx.select().from(agentSessions).where(eq(agentSessions.id, address.currentSessionId)).limit(1)
    : [];
  const presence = deriveAddressPresence(address, session, new Date(now.getTime() - env.AGENT_PORTAL_HEARTBEAT_FRESH_SECONDS * 1000).toISOString(), now.getTime());
  return { recipient_presence: presence, observed_at: now.toISOString(), delivery_hint: deliveryHint(presence) };
}

/** Called under the bus gate, before FIFO selection. Session-scoped mail must never wake a replacement. */
export async function discardPresenceNotices(tx: AgentMessagingDb, now: string, targetIds?: string[]) {
  await tx.update(agentBusMessages).set({ status: 'canceled', canceledAt: now, leaseOwner: null, leaseUntil: null, lastErrorCode: 'presence_notice_session_ended', updatedAt: now }).where(and(
    eq(agentBusMessages.kind, 'presence_notice'),
    inArray(agentBusMessages.status, ['queued', 'leased', 'accepted']),
    ...(targetIds ? [inArray(agentBusMessages.targetAddressId, targetIds)] : []),
    sql`NOT EXISTS (SELECT 1 FROM agent_sessions AS notice_session INNER JOIN agent_bus_addresses AS notice_address ON notice_address.id = ${agentBusMessages.targetAddressId} WHERE notice_session.id = ${agentBusMessages.targetSessionId} AND notice_session.ended_at IS NULL AND notice_address.current_session_id = notice_session.id)`,
  ));
}

export async function markWaitingForPresence(tx: AgentMessagingDb, targetId: string) {
  await tx.update(agentBusMessages).set({ awaitingPresence: 1 }).where(and(
    eq(agentBusMessages.targetAddressId, targetId), inArray(agentBusMessages.status, ['queued', 'leased']), ne(agentBusMessages.kind, 'presence_notice'),
  ));
}

export interface PresenceFeedbackCore {
  env: Env;
  keyring: Keyring;
  server(tx: AgentMessagingDb): Promise<AgentBusAddress>;
  assertAddressEligibleLocked(tx: AgentMessagingDb, address: AgentBusAddress): Promise<void>;
}

/** One return per recipient launch and sender launch; bus locking makes discovery and insertion atomic. */
export async function queuePresenceNotices(tx: AgentMessagingDb, sessionId: string, core: PresenceFeedbackCore) {
  const receipts: Array<{ message_id: string; conversation_id: string; status: string }> = [];
  const now = new Date();
  const [session] = await tx.select().from(agentSessions).where(eq(agentSessions.id, sessionId)).limit(1);
  if (!session?.agentBusAddressId || session.endedAt) return receipts;
  const [address] = await tx.select().from(agentBusAddresses).where(eq(agentBusAddresses.id, session.agentBusAddressId)).limit(1);
  if (!address || address.currentSessionId !== sessionId) return receipts;
  const cutoff = new Date(now.getTime() - core.env.AGENT_PORTAL_HEARTBEAT_FRESH_SECONDS * 1000).toISOString();
  if (deriveAddressPresence(address, session, cutoff, now.getTime()) !== 'listening') return receipts;
  await core.assertAddressEligibleLocked(tx, address);
  // The worker accepts its first message before launching A. Include only that
  // launch's accepted relay delivery; unrelated accepted work is not waiting.
  const pending = await tx.select().from(agentBusMessages).where(and(
    eq(agentBusMessages.targetAddressId, address.id), eq(agentBusMessages.awaitingPresence, 1),
    gt(agentBusMessages.expiresAt, now.toISOString()), isNull(agentBusMessages.cancelRequestedAt),
    or(inArray(agentBusMessages.status, ['queued', 'leased']), and(eq(agentBusMessages.status, 'accepted'), eq(agentBusMessages.deliverySessionId, sessionId), sql`${agentBusMessages.leaseOwner} LIKE 'relay:%'`)),
  )).for('update');
  const bySender = new Map<string, typeof pending>();
  for (const message of pending) {
    const group = bySender.get(message.senderAddressId) ?? [];
    group.push(message); bySender.set(message.senderAddressId, group);
  }
  for (const [senderId, messages] of bySender) {
    const [sender] = await tx.select().from(agentBusAddresses).where(eq(agentBusAddresses.id, senderId)).limit(1);
    if (!sender?.currentSessionId) continue;
    const [senderSession] = await tx.select().from(agentSessions).where(eq(agentSessions.id, sender.currentSessionId)).limit(1);
    if (!isPresent(deriveAddressPresence(sender, senderSession, cutoff, now.getTime()))) continue;
    // Eligibility may have changed independently of transport presence. Do not
    // let a suspended sender prevent A's reception from coming back.
    try { await core.assertAddressEligibleLocked(tx, sender); } catch (error) {
      if (error instanceof ApiError && [403, 404, 423].includes(error.status)) continue;
      throw error;
    }
    const key = `${sessionId}:${senderSession!.id}`;
    const [existing] = await tx.select({ id: agentBusMessages.id }).from(agentBusMessages).where(eq(agentBusMessages.presenceNoticeKey, key)).limit(1);
    if (existing) continue;
    const server = await core.server(tx);
    const conversationId = randomUUID();
    const instant = now.toISOString();
    await tx.insert(agentBusConversations).values({ id: conversationId, addressAId: server.id, addressBId: sender.id, createdByAddressId: server.id, nextSequence: 2, status: 'open', lastActivityAt: instant, createdAt: instant, updatedAt: instant });
    const details = { address: address.address, name: address.launchName, session_id: sessionId, waiting_message_count: messages.length, waiting_message_ids: messages.slice(0, 256).map(message => message.id), message_ids_truncated: messages.length > 256, observed_at: instant };
    const content = `PRESENCE/1\n${address.launchName ?? address.address} (${address.address}) is ready to receive again; your waiting messages can now be delivered. This is an informational server presence update, not proof of acceptance or reading and not a work request. No reply required; finish with agent_listen once and yield.\n${JSON.stringify(details)}`;
    const messageId = randomUUID();
    await tx.insert(agentBusMessages).values({
      ...newQueuedMessage({ id: messageId, conversationId, sequence: 1, sender: server, senderSessionId: null, target: sender, kind: 'presence_notice', content, contentEnc: encrypt(content, core.keyring), clientMessageId: randomUUID(), expiresAt: new Date(now.getTime() + 24 * 3600_000).toISOString(), now: instant }),
      targetSessionId: senderSession!.id, presenceNoticeKey: key,
    });
    receipts.push({ message_id: messageId, conversation_id: conversationId, status: 'queued' });
  }
  // Consume this return event even when a sender was offline: it must not turn
  // into a delayed "A returned" notification on that sender's next launch.
  if (pending.length) await tx.update(agentBusMessages).set({ awaitingPresence: 0 }).where(inArray(agentBusMessages.id, pending.map(message => message.id)));
  return receipts;
}
