/** Durable domain results and one-use native replacement authorization. */
import { newQueuedMessage } from './views.js';
import { AGENT_MESSAGING_DEFAULT_TTL_SECONDS } from './constants.js';
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Database } from '../../db/client.js';
import {
  agentBusMessages,
  agentBusConversations,
  agentFreshStartGrants,
  agentTaskResults,
  type AgentBusMessage,
  type AgentBusAddress,
} from '../../db/schema.js';
import type { Keyring } from '../../security/keyring.js';
import { encrypt } from '../../security/secret-box.js';
import { sha256 } from '../../security/hash.js';
import { ConflictError, ValidationError } from '../../http/errors.js';

type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];
const shortText = (limit: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(limit)
    .refine((v) => Buffer.byteLength(v, 'utf8') <= limit);
export const taskResultSchema = z
  .object({
    status: z.enum(['succeeded', 'failed', 'blocked', 'unknown']),
    summary: shortText(4096),
    evidence: z
      .array(z.object({ description: shortText(500), reference: shortText(2048) }).strict())
      .max(20)
      .optional(),
  })
  .strict();
export type TaskResult = z.infer<typeof taskResultSchema>;
export const unknownTaskResult: TaskResult = {
  status: 'unknown',
  summary: 'Transport completed without an explicit task result.',
};

export async function storeTaskResult(
  tx: Tx,
  message: AgentBusMessage,
  raw: unknown,
  keyring: Keyring,
  now: string,
) {
  if (!message.workKind || !message.claimId) throw new ValidationError('Only claimed work has a task result');
  const result = taskResultSchema.parse(raw),
    body = JSON.stringify(result),
    digest = sha256(body);
  const [existing] = await tx
    .select()
    .from(agentTaskResults)
    .where(and(eq(agentTaskResults.messageId, message.id), eq(agentTaskResults.claimId, message.claimId)))
    .limit(1);
  if (existing) {
    if (existing.bodySha256 !== digest)
      throw new ConflictError(
        'A different result already exists for this execution',
        'agent_task_result_conflict',
      );
    return result;
  }
  if (message.status !== 'accepted')
    throw new ConflictError(
      'Task must be accepted before its result is stored',
      'agent_task_result_not_accepted',
    );
  await tx.insert(agentTaskResults).values({
    id: randomUUID(),
    messageId: message.id,
    claimId: message.claimId,
    status: result.status,
    bodyEnc: encrypt(body, keyring),
    bodySha256: digest,
    createdAt: now,
  });
  await tx
    .update(agentBusMessages)
    .set({ taskResultStatus: result.status })
    .where(eq(agentBusMessages.id, message.id));
  return result;
}

export async function approveFreshStart(
  tx: Tx,
  message: AgentBusMessage,
  target: AgentBusAddress,
  version: number,
  reason: string,
  actor: string,
  now: string,
) {
  if (message.kind === 'schedule' || !message.workKind)
    throw new ValidationError('Fresh-start grants apply only to ordinary work');
  const [existing] = await tx
    .select()
    .from(agentFreshStartGrants)
    .where(eq(agentFreshStartGrants.messageId, message.id))
    .limit(1)
    .for('update');
  if (
    existing?.executionVersion === version + 1 &&
    message.executionVersion === version + 1 &&
    existing.reason === reason &&
    existing.approvedBy === actor
  )
    return existing;
  if (message.executionVersion !== version)
    throw new ConflictError('Message changed; retrieve it again', 'agent_execution_version_conflict');
  if (
    !['dead', 'ambiguous'].includes(message.status) ||
    message.lastErrorCode !== 'native_transcript_missing'
  )
    throw new ConflictError(
      'A missing native transcript must be confirmed first',
      'agent_fresh_start_not_blocked',
    );
  if (existing)
    throw new ConflictError(
      'This message already used its replacement grant',
      'agent_fresh_start_already_granted',
    );
  const grant = {
    messageId: message.id,
    targetAddressId: target.id,
    bindingGeneration: target.bindingGeneration,
    executionVersion: version + 1,
    reason,
    approvedBy: actor,
    consumedClaimId: null,
    createdAt: now,
    consumedAt: null,
  };
  await tx.insert(agentFreshStartGrants).values(grant);
  await tx
    .update(agentBusMessages)
    .set({
      executionContractVersion: 2,
      executionVersion: version + 1,
      status: 'queued',
      nextAttemptAt: now,
      leaseOwner: null,
      leaseUntil: null,
      claimId: null,
      relayGeneration: null,
      acceptedAt: null,
      taskResultStatus: null,
      lastErrorCode: null,
      updatedAt: now,
    })
    .where(eq(agentBusMessages.id, message.id));
  return grant;
}

export async function freshStartAllowed(
  tx: Pick<Database, 'select'>,
  message: AgentBusMessage,
  target: AgentBusAddress,
): Promise<boolean> {
  if (message.kind === 'schedule' || !message.workKind) return false;
  const [grant] = await tx
    .select()
    .from(agentFreshStartGrants)
    .where(eq(agentFreshStartGrants.messageId, message.id))
    .limit(1);
  return (
    !!grant &&
    grant.targetAddressId === target.id &&
    grant.bindingGeneration === target.bindingGeneration &&
    grant.executionVersion === message.executionVersion &&
    !grant.consumedAt
  );
}

/** A result-only peer completion still needs a correlated response for its caller. */
export interface TaskResultReplyCore {
  requireAddressLocked(tx: Tx, id: string): Promise<AgentBusAddress>;
  requireConversationLocked(tx: Tx, id: string): Promise<import('../../db/schema.js').AgentBusConversation>;
  chargeConferenceBudgetLocked(tx: Tx, conversationId: string, now: string): Promise<void>;
}
export async function queueTaskResultReply(
  tx: Tx,
  message: AgentBusMessage,
  report: TaskResult,
  keyring: Keyring,
  now: string,
  core: TaskResultReplyCore,
) {
  if (message.kind === 'schedule' || message.sourceEngine === 'server') return;
  const [existing] = await tx
    .select()
    .from(agentBusMessages)
    .where(
      and(
        eq(agentBusMessages.replyToMessageId, message.id),
        eq(agentBusMessages.senderAddressId, message.targetAddressId),
      ),
    )
    .limit(1)
    .for('update');
  if (existing) return;
  const conversation = await core.requireConversationLocked(tx, message.conversationId);
  const sender = await core.requireAddressLocked(tx, message.targetAddressId);
  const target = await core.requireAddressLocked(tx, message.senderAddressId);
  if (conversation.status !== 'open' || target.archivedAt || !target.enabled) return;
  const id = randomUUID();
  await tx
    .insert(agentBusMessages)
    .values({
      ...newQueuedMessage({
        id,
        conversationId: message.conversationId,
        sequence: Number(conversation.nextSequence),
        sender,
        senderSessionId: message.deliverySessionId,
        target,
        kind: 'reply',
        content: report.summary,
        contentEnc: encrypt(report.summary, keyring),
        clientMessageId: randomUUID(),
        expiresAt: new Date(Date.parse(now) + AGENT_MESSAGING_DEFAULT_TTL_SECONDS * 1000).toISOString(),
        now,
      }),
      replyToMessageId: message.id,
    });
  await tx
    .update(agentBusConversations)
    .set({ nextSequence: Number(conversation.nextSequence) + 1, lastActivityAt: now, updatedAt: now })
    .where(eq(agentBusConversations.id, conversation.id));
  await core.chargeConferenceBudgetLocked(tx, conversation.id, now);
}
