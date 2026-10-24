import { and, asc, desc, eq, gt } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import { agentBusMessages, agentTaskResults } from '../../db/schema.js';
import { ConflictError, NotFoundError } from '../../http/errors.js';
import type { Keyring } from '../../security/keyring.js';
import { decrypt } from '../../security/secret-box.js';
import type { OwnerRuntime } from '../../control-plane/state/runtime.js';
import { ownedBridge } from '../../control-plane/state/messaging.js';
import { normalizeUuid } from './normalize.js';
import { conversationMetadata, messageForParticipant } from './views.js';
import { taskResultSchema } from './task-execution.js';
import {
  AGENT_MESSAGING_MAILBOX_PAGE_SIZE,
  AGENT_MESSAGING_MISSED_WINDOW_SECONDS,
  AGENT_MESSAGING_WAIT_PAGE_SIZE,
} from './constants.js';

function reader(runtime: OwnerRuntime, id: string, token: string) {
  runtime.assertOwner();
  const snapshot = runtime.state.snapshot(),
    session = ownedBridge(snapshot, id, token).session;
  const address = session.agentBusAddressId && snapshot.addresses.get(session.agentBusAddressId);
  if (
    !address ||
    address.currentSessionId !== session.id ||
    address.bindingGeneration !== session.bindingGeneration
  )
    throw new ConflictError('Agent address binding changed', 'agent_messaging_binding_stale');
  return { snapshot, session, address };
}
export async function waitOwnedMessages(
  db: Database,
  runtime: OwnerRuntime,
  keyring: Keyring,
  sessionId: string,
  token: string,
  conversationId: string,
  afterSequence = 0,
): Promise<Record<string, unknown>> {
  const id = normalizeUuid(conversationId, 'conversation_id'),
    after = Math.max(0, Math.trunc(afterSequence));
  const auth = reader(runtime, sessionId, token),
    conversation = auth.snapshot.table('agentBusConversations').get(id);
  if (!conversation || ![conversation.addressAId, conversation.addressBId].includes(auth.address.id))
    throw new NotFoundError('Conversation not found', 'agent_messaging_conversation_not_found');
  const last =
    conversation.addressAId === auth.address.id ? conversation.lastToASequence : conversation.lastToBSequence;
  if (last <= after)
    return {
      conversation: conversationMetadata(conversation),
      messages: [],
      has_more: false,
      next_sequence: after,
    };
  // Only requested bodies/history cross the database boundary. The durable
  // incoming cursor above proves an unchanged mailbox needs no SELECT.
  const fetched = await db
    .select()
    .from(agentBusMessages)
    .where(
      and(
        eq(agentBusMessages.conversationId, id),
        eq(agentBusMessages.targetAddressId, auth.address.id),
        gt(agentBusMessages.sequence, after),
      ),
    )
    .orderBy(asc(agentBusMessages.sequence))
    .limit(AGENT_MESSAGING_WAIT_PAGE_SIZE + 1);
  const current = reader(runtime, sessionId, token);
  if (
    current.address.id !== auth.address.id ||
    current.session.bindingGeneration !== auth.session.bindingGeneration
  )
    throw new ConflictError('Agent address binding changed', 'agent_messaging_binding_stale');
  const rows = fetched.slice(0, AGENT_MESSAGING_WAIT_PAGE_SIZE);
  return {
    conversation: conversationMetadata(
      current.snapshot.table('agentBusConversations').get(id) ?? conversation,
    ),
    messages: rows.map((row) => {
      const sender = current.snapshot.addresses.get(row.senderAddressId),
        target = current.snapshot.addresses.get(row.targetAddressId);
      if (!sender || !target) throw new Error('Message participant absent');
      return messageForParticipant(
        current.snapshot.messages.get(row.id) ?? row,
        decrypt(row.contentEnc, keyring),
        sender,
        target,
      );
    }),
    has_more: fetched.length > AGENT_MESSAGING_WAIT_PAGE_SIZE,
    next_sequence: rows.at(-1)?.sequence ?? after,
  };
}
export async function getOwnedMessage(
  db: Database,
  runtime: OwnerRuntime,
  keyring: Keyring,
  sessionId: string,
  token: string,
  messageId: string,
): Promise<Record<string, unknown>> {
  const id = normalizeUuid(messageId, 'message_id'),
    auth = reader(runtime, sessionId, token);
  const [body] = await db.select().from(agentBusMessages).where(eq(agentBusMessages.id, id)).limit(1);
  if (!body || ![body.senderAddressId, body.targetAddressId].includes(auth.address.id))
    throw new NotFoundError('Message not found', 'agent_messaging_message_not_found');
  const results = await db
    .select()
    .from(agentTaskResults)
    .where(eq(agentTaskResults.messageId, id))
    .orderBy(desc(agentTaskResults.createdAt))
    .limit(100);
  const current = reader(runtime, sessionId, token);
  if (
    current.address.id !== auth.address.id ||
    current.session.bindingGeneration !== auth.session.bindingGeneration
  )
    throw new ConflictError('Agent address binding changed', 'agent_messaging_binding_stale');
  const sender = current.snapshot.addresses.get(body.senderAddressId),
    target = current.snapshot.addresses.get(body.targetAddressId);
  if (!sender || !target) throw new Error('Message participant absent');
  return {
    message: {
      ...messageForParticipant(
        current.snapshot.messages.get(id) ?? body,
        decrypt(body.contentEnc, keyring),
        sender,
        target,
      ),
      task_results: results.map((result) => ({
        claim_id: result.claimId,
        created_at: result.createdAt,
        task_result: taskResultSchema.parse(JSON.parse(decrypt(result.bodyEnc, keyring))),
      })),
    },
  };
}
export function peekOwnedMailbox(
  runtime: OwnerRuntime,
  sessionId: string,
  token: string,
): Record<string, unknown> {
  const { snapshot, address } = reader(runtime, sessionId, token),
    now = new Date().toISOString(),
    missedAfter = new Date(Date.now() - AGENT_MESSAGING_MISSED_WINDOW_SECONDS * 1000).toISOString();
  const rows = snapshot.messages
    .by('targetAddressId', address.id)
    .filter(
      (row) =>
        (row.status === 'queued' && row.expiresAt > now) ||
        (row.status === 'expired' && row.expiredAt && row.expiredAt > missedAfter),
    )
    .sort(
      (a, b) =>
        Number(b.status === 'queued') - Number(a.status === 'queued') || a.dispatchOrder - b.dispatchOrder,
    )
    .slice(0, AGENT_MESSAGING_MAILBOX_PAGE_SIZE);
  const pending: Record<string, unknown>[] = [],
    missed: Record<string, unknown>[] = [];
  for (const row of rows) {
    const sender = snapshot.addresses.get(row.senderAddressId);
    if (!sender) continue;
    const from = {
      address: sender.address,
      alias: sender.displayAlias,
      engine: sender.engine,
      fqdn: snapshot.hosts.get(sender.hostId)?.fqdn ?? null,
    };
    if (row.status === 'queued')
      pending.push({
        message_id: row.id,
        conversation_id: row.conversationId,
        kind: row.kind,
        from,
        expires_at: row.expiresAt,
      });
    else missed.push({ from, expired_at: row.expiredAt });
  }
  return { pending, missed };
}
