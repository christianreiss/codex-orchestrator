import { agentRoomChanges, agentRoomEvents } from '../../db/schema.js';
import type { OwnerMutationContext } from './runtime.js';
import type { OwnerStateSnapshot, OwnerStateDraft } from './store.js';
export interface RoomHead {
  eventCount: number;
  lastAt: string | null;
  actorCounts: Record<string, number>;
}
export const emptyRoomHead = (): RoomHead => ({ eventCount: 0, lastAt: null, actorCounts: {} });
export function roomHead(snapshot: OwnerStateSnapshot, id: string): RoomHead | undefined {
  return (
    snapshot.table('agentBusGroups').get(id)?.roomHead ??
    snapshot.table('agentBusConferences').get(id)?.roomHead ??
    snapshot.table('agentScopes').get(id)?.roomHead
  );
}
function changeHead(
  ctx: Pick<OwnerMutationContext, 'draft'>,
  id: string,
  update: (head: RoomHead) => RoomHead,
) {
  for (const table of ['agentBusGroups', 'agentBusConferences', 'agentScopes'] as const) {
    const row = ctx.draft.table(table).get(id);
    if (row) {
      ctx.draft.upsert(table, { ...row, roomHead: update(row.roomHead ?? emptyRoomHead()) });
      return;
    }
  }
  throw new Error('Room event parent is absent from owner state');
}
/** RAM head of the cold agent_room_changes log; the owner room-push wake source. */
export const ROOM_CHANGE_HEAD_SETTING = 'owner_room_change_seq';
/** `reaction` and `pin` (0119) carry the annotated event id as ref, like `event`. */
export type RoomChangeKind = 'event' | 'receipt' | 'member' | 'status' | 'reaction' | 'pin';
/** Append one metadata-only change row in the same owner persistence transaction. */
export function stageRoomChange(
  ctx: Pick<OwnerMutationContext, 'draft' | 'write'>,
  roomId: string,
  kind: RoomChangeKind,
  refId: string | null,
  createdAt = new Date().toISOString(),
): void {
  ctx.write(async (tx) => {
    const [inserted] = await tx.insert(agentRoomChanges).values({ roomId, kind, refId, createdAt });
    const seq = Number(inserted.insertId);
    if (!Number.isSafeInteger(seq) || seq < 1) throw new Error('Invalid room change cursor');
    if (seq > Number(ctx.draft.view().setting(ROOM_CHANGE_HEAD_SETTING) ?? 0))
      ctx.draft.upsert('versions', { name: ROOM_CHANGE_HEAD_SETTING, version: String(seq), updatedAt: createdAt });
  });
}
export function stageRoomEvent(ctx: OwnerMutationContext, row: typeof agentRoomEvents.$inferSelect): void {
  ctx.draft.upsert('agentRoomEvents', row);
  ctx.write(async (tx) => tx.insert(agentRoomEvents).values(row));
  stageRoomChange(ctx, row.roomId, 'event', row.id, row.createdAt);
  changeHead(ctx, row.roomId, (head) => ({
    eventCount: head.eventCount + 1,
    lastAt: !head.lastAt || row.createdAt > head.lastAt ? row.createdAt : head.lastAt,
    actorCounts: { ...head.actorCounts, [row.actor]: (head.actorCounts[row.actor] ?? 0) + 1 },
  }));
  for (const read of ctx.draft.table('agentRoomReads').all())
    if (read.roomId === row.roomId && row.actor !== 'admin:' + read.adminId && row.createdAt > read.readAt)
      ctx.draft.upsert('agentRoomReads', { ...read, unreadCount: read.unreadCount + 1 });
}
/** Retention supplies actual deleted metadata even when its body is cold. */
export function stageRoomEventDeletion(
  ctx: Pick<OwnerMutationContext, 'draft'>,
  row: Pick<typeof agentRoomEvents.$inferSelect, 'id' | 'roomId' | 'actor' | 'createdAt'>,
  remainingLastAt?: string | null,
): void {
  ctx.draft.remove('agentRoomEvents', row.id);
  if (!roomHead(ctx.draft.view(), row.roomId)) return;
  changeHead(ctx, row.roomId, (head) => {
    const actorCounts = { ...head.actorCounts },
      count = (actorCounts[row.actor] ?? 0) - 1;
    if (count > 0) actorCounts[row.actor] = count;
    else delete actorCounts[row.actor];
    const eventCount = Math.max(0, head.eventCount - 1);
    if (eventCount > 0 && row.createdAt === head.lastAt && remainingLastAt === undefined)
      throw new Error('Deleting the room event head requires the remaining durable event timestamp');
    return {
      ...head,
      eventCount,
      lastAt: eventCount === 0 ? null : remainingLastAt === undefined ? head.lastAt : remainingLastAt,
      actorCounts,
    };
  });
  for (const read of ctx.draft.table('agentRoomReads').all())
    if (read.roomId === row.roomId && row.actor !== 'admin:' + read.adminId && row.createdAt > read.readAt)
      ctx.draft.upsert('agentRoomReads', { ...read, unreadCount: Math.max(0, read.unreadCount - 1) });
}

export function projectRoomEventDeletion(
  draft: OwnerStateDraft,
  row: Pick<typeof agentRoomEvents.$inferSelect, 'id' | 'roomId' | 'actor' | 'createdAt'>,
  remainingLastAt?: string | null,
): void {
  stageRoomEventDeletion({ draft }, row, remainingLastAt);
}
/** Keep rate-limit metadata and exact unfinished conference-delivery dependencies. */
export function pruneRoomEventMetadata(draft: OwnerStateDraft): void {
  for (const delivery of draft.table('agentRoomDeliveries').all()) {
    const message = delivery.messageId ? draft.table('agentBusMessages').get(delivery.messageId) : undefined,
      event = draft.table('agentRoomEvents').get(delivery.eventId),
      conference = event ? draft.table('agentBusConferences').get(event.roomId) : undefined;
    if (
      message &&
      (['queued', 'leased', 'accepted', 'reboot_hold', 'batched', 'ambiguous'].includes(message.status) ||
        message.taskResultStatus === 'unknown')
    )
      continue;
    if (
      message &&
      conference &&
      conference.status !== 'adjourned' &&
      message.senderAddressId === '00000000-0000-4000-8000-000000000001' &&
      !['completed', 'dead', 'expired', 'canceled', 'ambiguous'].includes(message.status)
    )
      continue;
    draft.remove('agentRoomDeliveries', [delivery.eventId, delivery.addressId]);
  }
}
