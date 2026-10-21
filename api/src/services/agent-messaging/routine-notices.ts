import { and, asc, eq, inArray, isNull, or } from 'drizzle-orm';
import {
  agentBusAddresses,
  agentSessions,
  agentBusMessages,
  gitWorktrees,
  gitMergeRequests,
  type AgentBusMessage,
} from '../../db/schema.js';
import { decrypt } from '../../security/secret-box.js';
import type { Keyring } from '../../security/keyring.js';
import { SERVER_ADDRESS_ID } from './groups.js';
import type { AgentMessagingDb } from './types.js';

const SCAN_LIMIT = 64;
const DIGEST_MEMBER_LIMIT = 50;

/** Match only internally generated, complete routine notices, never peer text. */
export function routineNoticeKind(
  message: AgentBusMessage,
  keyring: Keyring,
): 'scope' | 'role' | 'director' | null {
  if (
    message.senderAddressId !== SERVER_ADDRESS_ID ||
    message.senderSessionId !== null ||
    message.workKind !== null ||
    message.executionContractVersion !== 1 ||
    message.contentBytes > 262144
  )
    return null;
  let content: string;
  try {
    content = decrypt(message.contentEnc, keyring);
  } catch {
    return null;
  }
  if (message.kind === 'publication' && isRoutineRoleNotice(content)) return 'role';
  if (message.kind !== 'presence_notice' || !message.targetSessionId) return null;
  try {
    const body = JSON.parse(content.slice(content.lastIndexOf('\n') + 1));
    if (
      content.startsWith('GIT-DIRECTOR/1\n') &&
      typeof body.clone_id === 'string' &&
      body.clone_id &&
      typeof body.event_id === 'string' &&
      typeof body.observed_at === 'string' &&
      (body.target_branch === undefined || typeof body.target_branch === 'string') &&
      ['work_scope_changed', 'merge_reported'].includes(body.kind)
    )
      return 'director';
    if (!content.startsWith('SCOPE/1\n')) return null;
    if (
      typeof body.scope_id !== 'string' ||
      body.events_truncated !== false ||
      !Array.isArray(body.events) ||
      body.events.length === 0 ||
      body.events.length > 50 ||
      !body.events.every(
        (event: unknown) =>
          event &&
          typeof event === 'object' &&
          ['presence', 'claim'].includes((event as { kind?: string }).kind ?? ''),
      )
    )
      return null;
    return 'scope';
  } catch {
    return null;
  }
}

/** Match the generated informational version/outcome headers, preserving
 * withdrawal alerts, reviews, unknown severities and malformed extensions. */
export function isRoutineRoleNotice(content: string): boolean {
  const [header, instruction] = content.split('\n', 2);
  if (instruction !== 'Informational; no reply required.') return false;
  return (
    /^ROLE-UPDATE\/1 role=[a-z0-9][a-z0-9._-]* version=[1-9]\d* previous=(?:none|[1-9]\d*) sha=[a-f0-9]{12}$/.test(
      header!,
    ) ||
    /^ROLE-PROPOSAL\/1 role=[a-z0-9][a-z0-9._-]* proposal_id=[a-f0-9-]{36} status=(?:applied|rejected|superseded|held)(?: version=[1-9]\d*)?$/.test(
      header!,
    )
  );
}

async function mayRetire(tx: AgentMessagingDb, message: AgentBusMessage, keyring: Keyring): Promise<boolean> {
  const kind = routineNoticeKind(message, keyring);
  if (kind !== 'director') return kind !== null;
  const payload = JSON.parse(decrypt(message.contentEnc, keyring).split('\n').at(-1)!);
  const [target] = await tx
    .select({ address: agentBusAddresses, session: agentSessions })
    .from(agentBusAddresses)
    .innerJoin(agentSessions, eq(agentSessions.id, agentBusAddresses.currentSessionId))
    .where(eq(agentBusAddresses.id, message.targetAddressId))
    .limit(1);
  if (
    !target ||
    target.session.endedAt ||
    target.session.id !== message.targetSessionId ||
    target.session.agentBusAddressId !== target.address.id ||
    target.address.bindingGeneration !== target.session.bindingGeneration ||
    message.targetBindingGeneration !== target.session.bindingGeneration
  )
    return false;
  const waiters = await tx
    .select({ worktree: gitWorktrees })
    .from(gitWorktrees)
    .innerJoin(gitMergeRequests, eq(gitMergeRequests.worktreeId, gitWorktrees.id))
    .where(
      and(
        eq(gitWorktrees.cloneId, payload.clone_id),
        eq(gitMergeRequests.cloneId, payload.clone_id),
        eq(gitWorktrees.agentBusAddressId, message.targetAddressId),
        eq(gitWorktrees.status, 'active'),
        eq(gitMergeRequests.verdict, 'wait'),
        isNull(gitMergeRequests.completedAt),
        or(
          isNull(gitWorktrees.agentSessionId),
          isNull(gitWorktrees.agentBindingGeneration),
          and(
            eq(gitWorktrees.agentSessionId, target.session.id),
            eq(gitWorktrees.agentBindingGeneration, target.session.bindingGeneration),
          ),
        ),
        // Legacy scope-change payloads omitted the previous target branch.
        // Any current clone waiter may need that release/recheck notification.
        payload.kind === 'work_scope_changed' || payload.target_branch === undefined
          ? undefined
          : eq(gitMergeRequests.targetBranch, payload.target_branch),
      ),
    )
    .limit(1);
  // Incomplete bindings are ambiguous. Preserve them rather than retire a recheck.
  return waiters.length === 0;
}

function unpresented(message: AgentBusMessage) {
  return (
    message.status === 'queued' &&
    message.attempts === 0 &&
    message.acceptedAt === null &&
    message.presentedAt === null &&
    message.ambiguousAt === null &&
    message.leaseOwner === null &&
    message.leaseUntil === null &&
    message.deliverySessionId === null &&
    message.relayGeneration === null &&
    message.claimId === null
  );
}

/** Called only under the normal bus claim gate. No notifications are generated. */
export async function retireRoutineNotice(
  tx: AgentMessagingDb,
  message: AgentBusMessage,
  keyring: Keyring,
  now: string,
): Promise<boolean> {
  if (!unpresented(message)) return false;
  let ids: string[];
  if (await mayRetire(tx, message, keyring)) ids = [message.id];
  else if (
    message.kind === 'digest' &&
    message.senderAddressId === SERVER_ADDRESS_ID &&
    message.senderSessionId === null &&
    message.workKind === null &&
    message.executionContractVersion === 1 &&
    message.contentBytes <= 262144
  ) {
    const members = await tx
      .select()
      .from(agentBusMessages)
      .where(eq(agentBusMessages.digestId, message.id))
      .orderBy(asc(agentBusMessages.dispatchOrder))
      .limit(DIGEST_MEMBER_LIMIT + 1)
      .for('update');
    if (
      !members.length ||
      members.length > DIGEST_MEMBER_LIMIT ||
      members.some(
        (member) =>
          member.status !== 'batched' ||
          member.attempts !== 0 ||
          member.acceptedAt !== null ||
          member.presentedAt !== null ||
          member.ambiguousAt !== null ||
          member.leaseOwner !== null ||
          member.leaseUntil !== null ||
          member.deliverySessionId !== null ||
          member.relayGeneration !== null ||
          member.claimId !== null ||
          member.targetAddressId !== message.targetAddressId,
      )
    )
      return false;
    // Cross-check the actual presentation against retained originals. Missing,
    // malformed or unknown summaries cannot establish safe retirement.
    try {
      const body = JSON.parse(decrypt(message.contentEnc, keyring));
      if (
        body.digest_id !== message.id ||
        !Array.isArray(body.entries) ||
        body.entries.length !== members.length ||
        !body.entries.every(
          (entry: { message_id?: unknown }) => entry && typeof entry.message_id === 'string',
        ) ||
        new Set(body.entries.map((entry: { message_id: string }) => entry.message_id)).size !==
          members.length ||
        members.some(
          (member) => !body.entries.some((entry: { message_id: string }) => entry.message_id === member.id),
        ) ||
        (body.presentation !== undefined && body.presentation !== 'peer_batch_v1')
      )
        return false;
    } catch {
      return false;
    }
    for (const member of members) if (!(await mayRetire(tx, member, keyring))) return false;
    ids = [message.id, ...members.map((member) => member.id)];
  } else return false;
  await tx
    .update(agentBusMessages)
    .set({
      status: 'canceled',
      canceledAt: now,
      leaseOwner: null,
      leaseUntil: null,
      claimId: null,
      lastErrorCode: 'routine_notice_retired',
      updatedAt: now,
    })
    .where(
      and(
        inArray(agentBusMessages.id, ids),
        inArray(agentBusMessages.status, ['queued', 'batched']),
        isNull(agentBusMessages.acceptedAt),
        isNull(agentBusMessages.presentedAt),
      ),
    );
  return true;
}

/** Bound the pre-presentation scan. A full page disables digest creation for this poll;
 * candidate-time retirement protects later rows without unbounded queue scans. */
export async function retireRoutineNotices(
  tx: AgentMessagingDb,
  keyring: Keyring,
  targetIds: string[],
  now: string,
) {
  const rows = await tx
    .select()
    .from(agentBusMessages)
    .where(
      and(
        inArray(agentBusMessages.targetAddressId, targetIds),
        eq(agentBusMessages.senderAddressId, SERVER_ADDRESS_ID),
        eq(agentBusMessages.status, 'queued'),
        eq(agentBusMessages.attempts, 0),
        isNull(agentBusMessages.acceptedAt),
        isNull(agentBusMessages.presentedAt),
        inArray(agentBusMessages.kind, ['presence_notice', 'publication', 'digest']),
      ),
    )
    .orderBy(asc(agentBusMessages.dispatchOrder))
    .limit(SCAN_LIMIT)
    .for('update');
  for (const row of rows) await retireRoutineNotice(tx, row, keyring, now);
  return { complete: rows.length < SCAN_LIMIT };
}
