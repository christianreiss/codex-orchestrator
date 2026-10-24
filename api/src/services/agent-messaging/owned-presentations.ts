import { randomUUID } from 'node:crypto';
import { eq, inArray, and } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import { agentBusConversations, agentBusMessages, type AgentBusMessage } from '../../db/schema.js';
import type { Keyring } from '../../security/keyring.js';
import { decrypt, encrypt } from '../../security/secret-box.js';
import {
  mutateOwnerState,
  type OwnerMutationContext,
  type OwnerRuntime,
} from '../../control-plane/state/runtime.js';
import { stageUpdate } from '../../control-plane/state/rows.js';
import { stageQueuedMessage, stageServerAddress } from '../../control-plane/state/messages.js';
import { requireOwnedMessaging } from '../../control-plane/state/messaging.js';
import type { OwnerStateSnapshot } from '../../control-plane/state/store.js';
import { newQueuedMessage } from './views.js';
import { SERVER_ADDRESS_ID } from './groups.js';
import { routineNoticeKind } from './routine-notices.js';
import { DIGEST_MAX_BYTES, DIGEST_MAX_ENTRIES } from './smart-queue.js';
import { PEER_BATCH_MAX_BYTES, PEER_BATCH_MAX_ENTRIES } from './peer-batch.js';
import type { OwnedMessage } from './owned-delivery.js';

function unpresented(row: OwnedMessage): boolean {
  return (
    ['queued', 'batched'].includes(row.status) &&
    row.attempts === 0 &&
    !row.acceptedAt &&
    !row.presentedAt &&
    !row.ambiguousAt &&
    !row.leaseOwner &&
    !row.claimId &&
    !row.deliverySessionId
  );
}
function routineRetirable(snapshot: OwnerStateSnapshot, row: AgentBusMessage, keyring: Keyring): boolean {
  const kind = routineNoticeKind(row, keyring);
  if (kind !== 'director') return kind !== null;
  const payload = JSON.parse(decrypt(row.contentEnc, keyring).split('\n').at(-1)!);
  const address = snapshot.addresses.get(row.targetAddressId),
    session = address?.currentSessionId && snapshot.sessions.get(address.currentSessionId);
  if (
    !address ||
    !session ||
    session.endedAt ||
    session.id !== row.targetSessionId ||
    session.agentBusAddressId !== address.id ||
    address.bindingGeneration !== session.bindingGeneration ||
    row.targetBindingGeneration !== session.bindingGeneration
  )
    return false;
  return !snapshot
    .table('gitWorktrees')
    .by('cloneId', payload.clone_id)
    .some(
      (worktree) =>
        worktree.agentBusAddressId === row.targetAddressId &&
        worktree.status === 'active' &&
        (!worktree.agentSessionId ||
          !worktree.agentBindingGeneration ||
          (worktree.agentSessionId === session.id &&
            worktree.agentBindingGeneration === session.bindingGeneration)) &&
        snapshot
          .table('gitMergeRequests')
          .by('worktreeId', worktree.id)
          .some(
            (request) =>
              request.cloneId === payload.clone_id &&
              request.verdict === 'wait' &&
              !request.completedAt &&
              (payload.kind === 'work_scope_changed' ||
                payload.target_branch === undefined ||
                request.targetBranch === payload.target_branch),
          ),
    );
}
async function coldMessages(db: Database, ids: readonly string[]): Promise<Map<string, AgentBusMessage>> {
  return ids.length
    ? new Map(
        (
          await db
            .select()
            .from(agentBusMessages)
            .where(inArray(agentBusMessages.id, [...ids]))
        ).map((row) => [row.id, row]),
      )
    : new Map();
}
function cancel(ctx: OwnerMutationContext, row: OwnedMessage, now: string, reason?: string): void {
  stageUpdate(ctx, 'agentBusMessages', row.id, {
    status: 'canceled',
    canceledAt: now,
    leaseUntil: null,
    claimId: null,
    ...(reason ? { lastErrorCode: reason } : {}),
    updatedAt: now,
  });
}

/** Presentation is a durable transform of queued information, never acceptance. */
export async function prepareOwnedPresentations(
  db: Database,
  runtime: OwnerRuntime,
  keyring: Keyring,
  targetIds: readonly string[],
  options: { smart: boolean; peer: boolean; relay: boolean },
): Promise<void> {
  runtime.assertOwner();
  const initial = runtime.state.snapshot(),
    now = new Date().toISOString(),
    targets = new Set(targetIds);
  const possible = initial.messages.all().filter((row) => targets.has(row.targetAddressId));
  const routine = possible.some(
    (row) =>
      row.senderAddressId === SERVER_ADDRESS_ID &&
      unpresented(row) &&
      ['presence_notice', 'publication', 'digest'].includes(row.kind),
  );
  const roots = possible.some(
    (row) =>
      row.kind === 'digest' &&
      !row.acceptedAt &&
      !row.presentedAt &&
      !row.ambiguousAt &&
      ['queued', 'expired', 'dead', 'canceled'].includes(row.status),
  );
  const information = possible.filter(
    (row) =>
      row.status === 'queued' &&
      !row.workKind &&
      row.expiresAt > now &&
      ['message', 'reply', 'publication', 'presence_notice'].includes(row.kind),
  );
  const batching =
    !options.relay &&
    options.smart &&
    (options.peer
      ? information.length >= 2 && information.some((row) => Date.parse(row.createdAt) <= Date.now() - 60_000)
      : information.length > 1 ||
        information.some((row) => row.eventCount > 1 || Date.parse(row.createdAt) <= Date.now() - 60_000));
  if (!routine && !roots && !batching) return;
  await mutateOwnerState(runtime, {
    kind: 'messaging.prepare_presentations',
    payload: { targetIds: [...targetIds], ...options },
    authorize: requireOwnedMessaging,
    async prepare(ctx) {
      const now = new Date().toISOString();
      for (const targetId of targetIds) {
        const target = ctx.draft.table('agentBusAddresses').get(targetId);
        if (!target || (options.relay && target.currentSessionId)) continue;
        for (const child of ctx.draft.table('agentBusMessages').by('targetAddressId', targetId))
          if (child.status === 'batched' && child.expiresAt <= now)
            stageUpdate(ctx, 'agentBusMessages', child.id, {
              status: 'expired',
              expiredAt: now,
              updatedAt: now,
            });
        // A leased root may already have been presented. Never reconstruct it
        // from a timer or a disappeared connection.
        for (const root of ctx.draft
          .table('agentBusMessages')
          .by('targetAddressId', targetId)
          .filter(
            (row) =>
              row.kind === 'digest' &&
              !row.acceptedAt &&
              !row.presentedAt &&
              !row.ambiguousAt &&
              ['queued', 'expired', 'dead', 'canceled'].includes(row.status),
          )) {
          const children = ctx.draft.table('agentBusMessages').by('digestId', root.id);
          let fullDisabled = false;
          if (!options.peer && !options.relay && options.smart && root.status === 'queued') {
            const bodies = await coldMessages(db, [root.id]);
            fullDisabled =
              JSON.parse(decrypt(bodies.get(root.id)!.contentEnc, keyring)).presentation === 'peer_batch_v1';
          }
          if (
            !options.relay &&
            root.status === 'queued' &&
            options.smart &&
            !fullDisabled &&
            children.every((row) => row.status === 'batched')
          )
            continue;
          if (root.status === 'queued') cancel(ctx, root, now);
          for (const child of children)
            if (child.status === 'batched')
              stageUpdate(ctx, 'agentBusMessages', child.id, {
                status: 'queued',
                digestId: null,
                updatedAt: now,
              });
        }
        const noticeRows = ctx.draft
          .table('agentBusMessages')
          .by('targetAddressId', targetId)
          .filter(
            (row) =>
              row.senderAddressId === SERVER_ADDRESS_ID &&
              row.status === 'queued' &&
              unpresented(row) &&
              ['presence_notice', 'publication', 'digest'].includes(row.kind),
          )
          .sort((a, b) => a.dispatchOrder - b.dispatchOrder)
          .slice(0, 64);
        const bodies = await coldMessages(
          db,
          noticeRows.map((row) => row.id),
        );
        for (const row of noticeRows) {
          const cold = bodies.get(row.id);
          if (!cold) throw new Error('Queued notice body missing');
          if (routineRetirable(ctx.draft.view(), cold, keyring)) {
            cancel(ctx, row, now, 'routine_notice_retired');
            continue;
          }
          if (row.kind !== 'digest') continue;
          const members = ctx.draft.table('agentBusMessages').by('digestId', row.id);
          if (
            !members.length ||
            members.length > 50 ||
            members.some(
              (member) =>
                member.status !== 'batched' || !unpresented(member) || member.targetAddressId !== targetId,
            )
          )
            continue;
          let body: { digest_id?: string; presentation?: string; entries?: Array<{ message_id?: string }> };
          try {
            body = JSON.parse(decrypt(cold.contentEnc, keyring));
          } catch {
            continue;
          }
          if (
            body.digest_id !== row.id ||
            !Array.isArray(body.entries) ||
            body.entries.length !== members.length ||
            new Set(body.entries.map((entry) => entry.message_id)).size !== members.length ||
            members.some((member) => !body.entries!.some((entry) => entry?.message_id === member.id)) ||
            (body.presentation !== undefined && body.presentation !== 'peer_batch_v1')
          )
            continue;
          const originals = await coldMessages(
            db,
            members.map((member) => member.id),
          );
          if (
            members.every(
              (member) =>
                originals.has(member.id) &&
                routineRetirable(ctx.draft.view(), originals.get(member.id)!, keyring),
            )
          )
            for (const member of [row, ...members]) cancel(ctx, member, now, 'routine_notice_retired');
        }
        if (options.relay || !options.smart || noticeRows.length === 64) continue;
        if (
          ctx.draft
            .table('agentBusMessages')
            .by('targetAddressId', targetId)
            .some((row) => row.kind === 'digest' && ['queued', 'leased', 'accepted'].includes(row.status))
        )
          continue;
        let pending = ctx.draft
          .table('agentBusMessages')
          .by('targetAddressId', targetId)
          .filter(
            (row) =>
              row.status === 'queued' &&
              !row.workKind &&
              row.expiresAt > now &&
              (options.peer
                ? row.attempts === 0 &&
                  !row.taskResultStatus &&
                  ['message', 'reply', 'publication'].includes(row.kind)
                : row.deliveryClass !== 'coordination' &&
                  ['message', 'reply', 'publication', 'presence_notice'].includes(row.kind)),
          )
          .sort((a, b) => a.dispatchOrder - b.dispatchOrder);
        if (options.peer) {
          const parentIds = [
            ...new Set(pending.flatMap((row) => (row.replyToMessageId ? [row.replyToMessageId] : []))),
          ];
          const parents = await coldMessages(
            db,
            parentIds.filter((id) => !ctx.draft.table('agentBusMessages').has(id)),
          );
          pending = pending.filter((row) => {
            const parent =
              row.replyToMessageId &&
              (ctx.draft.table('agentBusMessages').get(row.replyToMessageId) ??
                parents.get(row.replyToMessageId));
            return !parent || (!parent.workKind && !['request', 'task', 'schedule'].includes(parent.kind));
          });
        } else {
          const groups = new Map<string, OwnedMessage[]>();
          for (const row of pending)
            if (row.coalesceKey && ['progress', 'notice'].includes(row.deliveryClass)) {
              const key = JSON.stringify([
                row.senderAddressId,
                row.deliveryClass,
                row.coalesceKey,
                row.relatedWorkId,
              ]);
              const group = groups.get(key) ?? [];
              group.push(row);
              groups.set(key, group);
            }
          for (const group of [...groups.values()]
            .filter((rows) => rows.length > 1)
            .slice(0, DIGEST_MAX_ENTRIES)) {
            const latest = group.at(-1)!,
              replaced = group.slice(0, -1),
              ids = replaced.map((row) => row.id);
            ctx.write(async (tx) => {
              await tx
                .update(agentBusMessages)
                .set({ supersededById: latest.id, updatedAt: now })
                .where(
                  and(
                    eq(agentBusMessages.targetAddressId, targetId),
                    eq(agentBusMessages.status, 'superseded'),
                    inArray(agentBusMessages.supersededById, ids),
                  ),
                );
            });
            for (const row of ctx.draft.table('agentBusMessages').by('targetAddressId', targetId))
              if (row.status === 'superseded' && row.supersededById && ids.includes(row.supersededById))
                ctx.draft.upsert('agentBusMessages', { ...row, supersededById: latest.id, updatedAt: now });
            for (const row of replaced)
              stageUpdate(ctx, 'agentBusMessages', row.id, {
                status: 'superseded',
                supersededById: latest.id,
                updatedAt: now,
              });
            stageUpdate(ctx, 'agentBusMessages', latest.id, {
              eventCount: group.reduce((sum, row) => sum + row.eventCount, 0),
              eventFirstAt: group.map((row) => row.eventFirstAt ?? row.createdAt).sort()[0]!,
              eventLastAt: latest.createdAt,
            });
          }
          pending = pending.flatMap((row) => {
            const current = ctx.draft.table('agentBusMessages').get(row.id)!;
            return current.status === 'queued' ? [current] : [];
          });
        }
        if (
          options.peer
            ? pending.length < 2 || Date.parse(pending[0]!.createdAt) > Date.now() - 60_000
            : !pending.length ||
              (pending.length === 1 &&
                pending[0]!.eventCount === 1 &&
                Date.parse(pending[0]!.createdAt) > Date.now() - 60_000)
        )
          continue;
        const id = randomUUID(),
          limit = options.peer ? PEER_BATCH_MAX_ENTRIES : DIGEST_MAX_ENTRIES,
          originals = await coldMessages(
            db,
            pending.slice(0, limit).map((row) => row.id),
          );
        const entries: Array<Record<string, unknown>> = [],
          selected: OwnedMessage[] = [];
        for (const row of pending.slice(0, limit)) {
          const cold = originals.get(row.id);
          if (!cold) throw new Error('Queued message body missing');
          const content = decrypt(cold.contentEnc, keyring);
          const entry = options.peer
            ? {
                message_id: row.id,
                conversation_id: row.conversationId,
                sequence: row.sequence,
                reply_to_message_id: row.replyToMessageId,
                kind: row.kind,
                sender: {
                  address: `agent:${row.senderAddressId}`,
                  name: row.senderName,
                  engine: row.sourceEngine,
                },
                created_at: row.createdAt,
                delivery_class: row.deliveryClass,
                related_work_id: row.relatedWorkId,
                event_count: row.eventCount,
                content,
              }
            : {
                message_id: row.id,
                sender: row.senderName ?? `agent:${row.senderAddressId}`,
                created_at: row.createdAt,
                age_seconds: Math.max(0, Math.floor((Date.now() - Date.parse(row.createdAt)) / 1000)),
                delivery_class: row.deliveryClass,
                preview: Array.from(content).slice(0, 240).join(''),
                event_count: row.eventCount,
                first_at: row.eventFirstAt ?? row.createdAt,
                last_at: row.eventLastAt ?? row.createdAt,
              };
          const bytes = Buffer.byteLength(
            JSON.stringify(
              options.peer
                ? { presentation: 'peer_batch_v1', digest_id: id, entries: [...entries, entry] }
                : { digest_id: id, remaining: pending.length, entries: [...entries, entry] },
            ),
          );
          if (bytes > (options.peer ? PEER_BATCH_MAX_BYTES - 128 : DIGEST_MAX_BYTES)) break;
          entries.push(entry);
          selected.push(row);
        }
        if (!selected.length) continue;
        const body = JSON.stringify(
          options.peer
            ? {
                presentation: 'peer_batch_v1',
                digest_id: id,
                total: pending.length,
                next_after: selected.length < pending.length ? selected.at(-1)!.dispatchOrder : null,
                entries,
              }
            : { digest_id: id, remaining: Math.max(0, pending.length - selected.length), entries },
        );
        const sender = stageServerAddress(ctx, now),
          conversation = {
            id: randomUUID(),
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
        ctx.write(async (tx) => {
          await tx.insert(agentBusConversations).values(conversation);
        });
        const members = options.peer ? pending : selected;
        stageQueuedMessage(
          ctx,
          newQueuedMessage({
            id,
            conversationId: conversation.id,
            sequence: 1,
            sender,
            senderSessionId: null,
            target,
            kind: 'digest',
            deliveryClass:
              options.peer && pending.some((row) => row.deliveryClass === 'coordination')
                ? 'coordination'
                : 'information',
            content: body,
            contentEnc: encrypt(body, keyring),
            clientMessageId: id,
            expiresAt: members.map((row) => row.expiresAt).sort()[0]!,
            now,
          }),
        );
        for (const row of members)
          stageUpdate(ctx, 'agentBusMessages', row.id, { status: 'batched', digestId: id, updatedAt: now });
      }
      return null;
    },
  });
}
