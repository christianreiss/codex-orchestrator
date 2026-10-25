/** Full-content presentation, never semantic coalescing or work acceptance. */
import { randomUUID } from 'node:crypto';
import { and, asc, count, eq, gt, inArray, isNull, sql, type SQL } from 'drizzle-orm';
import { agentBusConversations, agentBusMessages, type AgentBusAddress } from '../../db/schema.js';
import { decrypt, encrypt } from '../../security/secret-box.js';
import { nowIso } from '../../util/timestamp.js';
import type { AgentMessagingDb } from './types.js';
import type { SmartQueueCore } from './smart-queue.js';
import { newQueuedMessage } from './views.js';

export const PEER_BATCH_MAX_BYTES = 12_000;
export const PEER_BATCH_MAX_ENTRIES = 20;

/** Retain the first original at the presentation's priority class and FIFO position without rewriting history. */
export function presentationOrder(id: SQL, kind: SQL, order: SQL, deliveryClass: SQL): SQL {
  return sql`CASE WHEN ${kind} = 'digest' THEN COALESCE((SELECT MIN(member.dispatch_order)
    FROM agent_bus_messages member WHERE member.digest_id = ${id}
    AND (${deliveryClass} <> 'coordination' OR member.delivery_class = 'coordination')), ${order}) ELSE ${order} END`;
}

export async function preparePeerBatch(tx: AgentMessagingDb, target: AgentBusAddress, core: SmartQueueCore) {
  const now = nowIso();
  const [active] = await tx
    .select({ id: agentBusMessages.id })
    .from(agentBusMessages)
    .where(
      and(
        eq(agentBusMessages.targetAddressId, target.id),
        eq(agentBusMessages.kind, 'digest'),
        inArray(agentBusMessages.status, ['queued', 'leased', 'accepted']),
      ),
    )
    .limit(1);
  if (active) return;
  const pending = and(
    eq(agentBusMessages.targetAddressId, target.id),
    eq(agentBusMessages.status, 'queued'),
    eq(agentBusMessages.deliveryTiming, 'after_turn'),
    eq(agentBusMessages.attempts, 0),
    isNull(agentBusMessages.workKind),
    isNull(agentBusMessages.taskResultStatus),
    gt(agentBusMessages.expiresAt, now),
    inArray(agentBusMessages.kind, ['message', 'reply', 'publication']),
    sql`NOT EXISTS (SELECT 1 FROM agent_bus_messages parent WHERE parent.id = ${agentBusMessages.replyToMessageId}
          AND (parent.work_kind IS NOT NULL OR parent.kind IN ('request','task','schedule')))`,
  );
  const originals = await tx
    .select()
    .from(agentBusMessages)
    .where(pending)
    .orderBy(asc(agentBusMessages.dispatchOrder))
    .limit(PEER_BATCH_MAX_ENTRIES)
    .for('update');
  if (originals.length < 2 || Date.parse(originals[0]!.createdAt) > Date.now() - 60_000) return;
  const [stats] = await tx
    .select({
      total: count(),
      expiresAt: sql<string>`MIN(${agentBusMessages.expiresAt})`,
      coordination: sql<number>`MAX(${agentBusMessages.deliveryClass} = 'coordination')`,
    })
    .from(agentBusMessages)
    .where(pending);
  const entries: Array<Record<string, unknown>> = [];
  const selected: typeof originals = [];
  const id = randomUUID();
  for (const m of originals) {
    const entry = {
      message_id: m.id,
      conversation_id: m.conversationId,
      sequence: m.sequence,
      reply_to_message_id: m.replyToMessageId,
      kind: m.kind,
      sender: { address: `agent:${m.senderAddressId}`, name: m.senderName, engine: m.sourceEngine },
      created_at: m.createdAt,
      delivery_class: m.deliveryClass,
      related_work_id: m.relatedWorkId,
      event_count: m.eventCount,
      content: decrypt(m.contentEnc, core.keyring),
    };
    if (
      Buffer.byteLength(
        JSON.stringify({ presentation: 'peer_batch_v1', digest_id: id, entries: [...entries, entry] }),
      ) >
      PEER_BATCH_MAX_BYTES - 128
    )
      break;
    entries.push(entry);
    selected.push(m);
  }
  const total = Number(stats!.total);
  const body = JSON.stringify({
    presentation: 'peer_batch_v1',
    digest_id: id,
    total,
    next_after: selected.length < total ? (selected.at(-1)?.dispatchOrder ?? 0) : null,
    entries,
  });
  const server = await core.server(tx);
  const conversationId = randomUUID();
  await tx.insert(agentBusConversations).values({
    id: conversationId,
    addressAId: server.id,
    addressBId: target.id,
    createdByAddressId: server.id,
    nextSequence: 2,
    status: 'open',
    lastActivityAt: now,
    createdAt: now,
    updatedAt: now,
  });
  await tx.insert(agentBusMessages).values(
    newQueuedMessage({
      id,
      conversationId,
      sequence: 1,
      sender: server,
      senderSessionId: null,
      target,
      kind: 'digest',
      deliveryClass: Number(stats!.coordination) === 1 ? 'coordination' : 'information',
      content: body,
      contentEnc: encrypt(body, core.keyring),
      clientMessageId: id,
      expiresAt: stats!.expiresAt,
      now,
    }),
  );
  // Materialize IDs before UPDATE: MySQL rejects a correlated self-read in
  // an UPDATE predicate. Keep update packets bounded even for a large backlog.
  const members = await tx
    .select({ id: agentBusMessages.id })
    .from(agentBusMessages)
    .where(pending)
    .for('update');
  for (let offset = 0; offset < members.length; offset += 500) {
    await tx
      .update(agentBusMessages)
      .set({ status: 'batched', digestId: id, updatedAt: now })
      .where(
        inArray(
          agentBusMessages.id,
          members.slice(offset, offset + 500).map((m) => m.id),
        ),
      );
  }
}
