/** Durable presentation policy; it never merges work executions or changes authority. */
import { randomUUID } from 'node:crypto';
import { and, asc, count, desc, eq, gt, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import {
  agentBusConversations,
  agentBusMessages,
  type AgentBusAddress,
  type AgentBusMessage,
} from '../../db/schema.js';
import type { Env } from '../../env.js';
import { ConflictError, NotFoundError, ValidationError } from '../../http/errors.js';
import { encrypt, decrypt } from '../../security/secret-box.js';
import type { Keyring } from '../../security/keyring.js';
import { nowIso } from '../../util/timestamp.js';
import type { AgentMessagingDb } from './types.js';
import { newQueuedMessage } from './views.js';

export const queuePolicySchema = z.object({
  delivery_class: z.enum(['information', 'progress', 'notice', 'coordination']).optional(),
  coalesce_key: z.string().trim().min(1).max(128).optional(),
  related_work_id: z.string().uuid().optional(),
});
export type QueuePolicy = z.infer<typeof queuePolicySchema>;
export const DIGEST_MAX_BYTES = 8192;
export const DIGEST_MAX_ENTRIES = 20;

export function queuePolicy(input: QueuePolicy | undefined, work = false) {
  const v = queuePolicySchema.parse(input ?? {});
  const deliveryClass = v.delivery_class ?? 'information';
  if (v.coalesce_key && !['progress', 'notice'].includes(deliveryClass))
    throw new ValidationError('Only progress and notices can be coalesced');
  if (work && (deliveryClass !== 'information' || v.coalesce_key || v.related_work_id))
    throw new ValidationError('Work requests cannot be condensed or routed as coordination');
  return { deliveryClass, coalesceKey: v.coalesce_key ?? null, relatedWorkId: v.related_work_id ?? null };
}
export function smartQueueAllowed(env: Env, hostId: number, receiver: unknown): boolean {
  const allowed =
    env.CXX_QUEUE_DELIVERY_V1_HOST_IDS?.split(',')
      .map((x) => x.trim())
      .filter(Boolean) ?? [];
  return (
    env.CXX_QUEUE_DELIVERY_V1_ENABLED === true &&
    (!allowed.length || allowed.includes(String(hostId))) &&
    !!receiver &&
    typeof receiver === 'object' &&
    (receiver as { queue_delivery_v1?: boolean }).queue_delivery_v1 === true
  );
}
export function assertQueuePolicyReplay(message: AgentBusMessage, policy: ReturnType<typeof queuePolicy>) {
  if (
    (message.deliveryClass ?? 'information') !== policy.deliveryClass ||
    (message.coalesceKey ?? null) !== policy.coalesceKey ||
    (message.relatedWorkId ?? null) !== policy.relatedWorkId
  )
    throw new ConflictError(
      'Client message ID was already used with different delivery metadata',
      'agent_messaging_idempotency_conflict',
    );
}
export async function validateRelatedWork(
  tx: AgentMessagingDb,
  relatedWorkId: string | null,
  targetId: string,
) {
  if (!relatedWorkId) return;
  const [work] = await tx
    .select({ id: agentBusMessages.id })
    .from(agentBusMessages)
    .where(
      and(
        eq(agentBusMessages.id, relatedWorkId),
        eq(agentBusMessages.targetAddressId, targetId),
        isNotNull(agentBusMessages.workKind),
      ),
    )
    .limit(1);
  if (!work)
    throw new NotFoundError(
      'Related work does not belong to this recipient',
      'agent_messaging_message_not_found',
    );
}

/** Event totals a new keyed update inherits from the pending rows it replaces. */
export function coalescedEventStats(
  replaced: Array<Pick<AgentBusMessage, 'eventCount' | 'eventFirstAt' | 'createdAt'>>,
  now: string,
) {
  let eventCount = 1;
  let eventFirstAt = now;
  for (const m of replaced) {
    eventCount += Number(m.eventCount ?? 1);
    const first = m.eventFirstAt ?? m.createdAt;
    if (first < eventFirstAt) eventFirstAt = first;
  }
  return { eventCount, eventFirstAt, eventLastAt: now };
}

/**
 * Send-time coalescing, independent of digest presentation (queue_delivery_v1).
 * Caller holds the target address lock and has just inserted `messageId`.
 * Only still-queued, never leased/accepted/batched, repeats are superseded.
 */
export async function coalescePendingRepeats(
  tx: AgentMessagingDb,
  input: {
    messageId: string;
    senderAddressId: string;
    targetAddressId: string;
    policy: ReturnType<typeof queuePolicy>;
    now: string;
  },
): Promise<string[]> {
  const { policy, now } = input;
  if (!policy.coalesceKey || !['progress', 'notice'].includes(policy.deliveryClass)) return [];
  const replaced = await tx
    .select()
    .from(agentBusMessages)
    .where(
      and(
        eq(agentBusMessages.targetAddressId, input.targetAddressId),
        eq(agentBusMessages.senderAddressId, input.senderAddressId),
        eq(agentBusMessages.status, 'queued'),
        isNull(agentBusMessages.workKind),
        gt(agentBusMessages.expiresAt, now),
        inArray(agentBusMessages.kind, ['message', 'reply']),
        eq(agentBusMessages.deliveryClass, policy.deliveryClass),
        sql`BINARY ${agentBusMessages.coalesceKey} = BINARY ${policy.coalesceKey}`,
        policy.relatedWorkId
          ? eq(agentBusMessages.relatedWorkId, policy.relatedWorkId)
          : isNull(agentBusMessages.relatedWorkId),
        sql`${agentBusMessages.id} <> ${input.messageId}`,
      ),
    )
    .for('update');
  if (!replaced.length) return [];
  const ids = replaced.map((m) => m.id);
  // Flatten: digest retrieval follows one superseded_by_id level only.
  await tx
    .update(agentBusMessages)
    .set({ supersededById: input.messageId, updatedAt: now })
    .where(
      and(
        eq(agentBusMessages.targetAddressId, input.targetAddressId),
        eq(agentBusMessages.status, 'superseded'),
        inArray(agentBusMessages.supersededById, ids),
      ),
    );
  await tx
    .update(agentBusMessages)
    .set({ status: 'superseded', supersededById: input.messageId, updatedAt: now })
    .where(and(inArray(agentBusMessages.id, ids), eq(agentBusMessages.status, 'queued')));
  await tx
    .update(agentBusMessages)
    .set(coalescedEventStats(replaced, now))
    .where(eq(agentBusMessages.id, input.messageId));
  return ids;
}

export interface SmartQueueCore {
  keyring: Keyring;
  server(tx: AgentMessagingDb): Promise<AgentBusAddress>;
}
/** Caller holds the existing bus/admission locks. Never touch leased/accepted originals. */
export async function prepareSmartDigest(
  tx: AgentMessagingDb,
  target: AgentBusAddress,
  core: SmartQueueCore,
) {
  const now = nowIso();
  // An existing presentation owns its originals. Never create a second copy.
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
    isNull(agentBusMessages.workKind),
    gt(agentBusMessages.expiresAt, now),
    inArray(agentBusMessages.kind, ['message', 'reply', 'publication', 'presence_notice']),
    sql`${agentBusMessages.deliveryClass} <> 'coordination'`,
  );
  // A singleton keyed update must not add several round-trips under the bus
  // lock. Find only real duplicate streams, in one indexed queue scan.
  const groups = await tx
    .select({
      senderAddressId: agentBusMessages.senderAddressId,
      deliveryClass: agentBusMessages.deliveryClass,
      coalesceKey: agentBusMessages.coalesceKey,
      relatedWorkId: agentBusMessages.relatedWorkId,
    })
    .from(agentBusMessages)
    .where(
      and(
        pending,
        inArray(agentBusMessages.deliveryClass, ['progress', 'notice']),
        isNotNull(agentBusMessages.coalesceKey),
      ),
    )
    .groupBy(
      agentBusMessages.senderAddressId,
      agentBusMessages.deliveryClass,
      agentBusMessages.coalesceKey,
      sql`BINARY ${agentBusMessages.coalesceKey}`,
      agentBusMessages.relatedWorkId,
    )
    .having(sql`COUNT(*) > 1`)
    .orderBy(sql`MIN(${agentBusMessages.dispatchOrder})`)
    .limit(DIGEST_MAX_ENTRIES);
  for (const message of groups) {
    const same = and(
      pending,
      eq(agentBusMessages.senderAddressId, message.senderAddressId),
      eq(agentBusMessages.deliveryClass, message.deliveryClass),
      sql`BINARY ${agentBusMessages.coalesceKey} = BINARY ${message.coalesceKey}`,
      message.relatedWorkId
        ? eq(agentBusMessages.relatedWorkId, message.relatedWorkId)
        : isNull(agentBusMessages.relatedWorkId),
    );
    const [latest] = await tx
      .select()
      .from(agentBusMessages)
      .where(same)
      .orderBy(desc(agentBusMessages.dispatchOrder))
      .limit(1)
      .for('update');
    const [stats] = await tx
      .select({
        n: sql<number>`SUM(${agentBusMessages.eventCount})`,
        first: sql<string>`MIN(COALESCE(${agentBusMessages.eventFirstAt}, ${agentBusMessages.createdAt}))`,
      })
      .from(agentBusMessages)
      .where(same);
    if (!latest) continue;
    // Flatten earlier coalescing after a certainly-unpresented rollback, so
    // digest retrieval still reaches every retained event without recursion.
    const replaced = await tx
      .select({ id: agentBusMessages.id })
      .from(agentBusMessages)
      .where(and(same, sql`${agentBusMessages.id} <> ${latest.id}`));
    if (replaced.length)
      await tx
        .update(agentBusMessages)
        .set({ supersededById: latest.id, updatedAt: now })
        .where(
          and(
            eq(agentBusMessages.targetAddressId, target.id),
            eq(agentBusMessages.status, 'superseded'),
            inArray(
              agentBusMessages.supersededById,
              replaced.map((x) => x.id),
            ),
          ),
        );
    await tx
      .update(agentBusMessages)
      .set({ status: 'superseded', supersededById: latest.id, updatedAt: now })
      .where(and(same, sql`${agentBusMessages.id} <> ${latest.id}`));
    await tx
      .update(agentBusMessages)
      .set({
        eventCount: Number(stats?.n ?? 1),
        eventFirstAt: stats?.first ?? latest.createdAt,
        eventLastAt: latest.createdAt,
      })
      .where(eq(agentBusMessages.id, latest.id));
  }
  const originals = await tx
    .select()
    .from(agentBusMessages)
    .where(pending)
    .orderBy(asc(agentBusMessages.dispatchOrder))
    .limit(DIGEST_MAX_ENTRIES + 1)
    .for('update');
  if (
    !originals.length ||
    (originals.length === 1 &&
      Date.parse(originals[0]!.createdAt) > Date.now() - 60_000 &&
      originals[0]!.eventCount === 1)
  )
    return;
  const [total] = await tx.select({ n: count() }).from(agentBusMessages).where(pending);
  const digestId = randomUUID();
  const entries: Array<Record<string, unknown>> = [];
  const selected: AgentBusMessage[] = [];
  for (const m of originals.slice(0, DIGEST_MAX_ENTRIES)) {
    const entry = {
      message_id: m.id,
      sender: m.senderName ?? `agent:${m.senderAddressId}`,
      created_at: m.createdAt,
      age_seconds: Math.max(0, Math.floor((Date.now() - Date.parse(m.createdAt)) / 1000)),
      delivery_class: m.deliveryClass,
      preview: Array.from(decrypt(m.contentEnc, core.keyring)).slice(0, 240).join(''),
      event_count: m.eventCount,
      first_at: m.eventFirstAt ?? m.createdAt,
      last_at: m.eventLastAt ?? m.createdAt,
    };
    if (
      Buffer.byteLength(
        JSON.stringify({
          digest_id: digestId,
          remaining: Number(total?.n ?? 0),
          entries: [...entries, entry],
        }),
        'utf8',
      ) > DIGEST_MAX_BYTES
    )
      break;
    entries.push(entry);
    selected.push(m);
  }
  if (!selected.length) return;
  const body = JSON.stringify({
    digest_id: digestId,
    remaining: Math.max(0, Number(total?.n ?? 0) - selected.length),
    entries,
  });
  const server = await core.server(tx);
  const conversationId = randomUUID();
  await tx
    .insert(agentBusConversations)
    .values({
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
  await tx
    .insert(agentBusMessages)
    .values(
      newQueuedMessage({
        id: digestId,
        conversationId,
        sequence: 1,
        sender: server,
        senderSessionId: null,
        target,
        kind: 'digest',
        content: body,
        contentEnc: encrypt(body, core.keyring),
        clientMessageId: digestId,
        expiresAt: selected.map((x) => x.expiresAt).sort()[0]!,
        now,
      }),
    );
  await tx
    .update(agentBusMessages)
    .set({ status: 'batched', digestId, updatedAt: now })
    .where(
      inArray(
        agentBusMessages.id,
        selected.map((m) => m.id),
      ),
    );
}
/** Rollback restores only certainly unpresented groups. Ambiguous/accepted groups never replay. */
export async function restoreUnpresentedDigests(tx: AgentMessagingDb, targetId: string, disabled: boolean) {
  const now = nowIso();
  await tx
    .update(agentBusMessages)
    .set({ status: 'expired', expiredAt: now, updatedAt: now })
    .where(
      and(
        eq(agentBusMessages.targetAddressId, targetId),
        eq(agentBusMessages.status, 'batched'),
        sql`${agentBusMessages.expiresAt} <= ${now}`,
      ),
    );
  const roots = await tx
    .select()
    .from(agentBusMessages)
    .where(
      and(
        eq(agentBusMessages.targetAddressId, targetId),
        eq(agentBusMessages.kind, 'digest'),
        inArray(agentBusMessages.status, ['queued', 'leased', 'expired', 'dead', 'canceled']),
      ),
    )
    .for('update');
  for (const root of roots) {
    // Accepted/uncertain presentations may already be in the native transcript.
    if (root.acceptedAt) continue;
    const [changedMember] = await tx
      .select({ id: agentBusMessages.id })
      .from(agentBusMessages)
      .where(and(eq(agentBusMessages.digestId, root.id), sql`${agentBusMessages.status} <> 'batched'`))
      .limit(1);
    if (
      !changedMember &&
      !(['expired', 'dead', 'canceled'].includes(root.status) || (disabled && root.status === 'queued'))
    )
      continue;
    if (['queued', 'leased'].includes(root.status))
      await tx
        .update(agentBusMessages)
        .set({ status: 'canceled', canceledAt: now, leaseUntil: null, updatedAt: now })
        .where(eq(agentBusMessages.id, root.id));
    await tx
      .update(agentBusMessages)
      .set({ status: 'queued', digestId: null, updatedAt: now })
      .where(and(eq(agentBusMessages.digestId, root.id), eq(agentBusMessages.status, 'batched')));
  }
}
export async function presentDigest(tx: AgentMessagingDb, root: AgentBusMessage, now: string) {
  if (root.kind !== 'digest') return;
  await tx
    .update(agentBusMessages)
    .set({ status: 'digested', presentedAt: now, updatedAt: now })
    .where(and(eq(agentBusMessages.digestId, root.id), eq(agentBusMessages.status, 'batched')));
}
