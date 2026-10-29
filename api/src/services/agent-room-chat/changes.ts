import { and, asc, eq, gt, sql } from 'drizzle-orm';
import { agentRoomChanges } from '../../db/schema.js';
import type { Database } from '../../db/client.js';
import type { RoomChangeKind } from '../../control-plane/state/room-heads.js';
import { nowIso } from '../../util/timestamp.js';

export type { RoomChangeKind } from '../../control-plane/state/room-heads.js';
/** Most change rows one delta read or one change listing returns. */
export const ROOM_DELTA_LIMIT = 500;

/**
 * Plain-database room mutations append their change row in the caller's transaction.
 * Owner mode uses `stageRoomChange` (control-plane/state/room-heads.ts) instead.
 * Kinds: `event` (ref = event id), `receipt` (ref = event id whose deliveries changed,
 * agent address whose read position moved, or null for an operator read position),
 * `member` (ref = address id), `status` (ref = null; open/adjourning/adjourned).
 */
export async function recordRoomChange(
  tx: Pick<Database, 'insert'>,
  roomId: string,
  kind: RoomChangeKind,
  refId: string | null = null,
  createdAt = nowIso(),
): Promise<void> {
  await tx.insert(agentRoomChanges).values({ roomId, kind, refId, createdAt });
}

type Reader = Pick<Database, 'select'>;

/** Oldest retained and newest change sequence, globally (retention prunes by age). */
export async function roomChangeBounds(db: Reader, roomId?: string): Promise<{ min: number; max: number; roomMax: number }> {
  const [row] = await db
    .select({
      min: sql<number | null>`MIN(${agentRoomChanges.seq})`,
      max: sql<number | null>`MAX(${agentRoomChanges.seq})`,
    })
    .from(agentRoomChanges);
  const [room] = roomId
    ? await db
        .select({ max: sql<number | null>`MAX(${agentRoomChanges.seq})` })
        .from(agentRoomChanges)
        .where(eq(agentRoomChanges.roomId, roomId))
    : [];
  return { min: Number(row?.min ?? 0), max: Number(row?.max ?? 0), roomMax: Number(room?.max ?? 0) };
}

/**
 * A cursor needs a resync when rows after it may have been pruned: retention deletes the
 * oldest rows globally, so `after + 1 < MIN(seq)` means a gap. AUTO_INCREMENT gaps from
 * rolled-back inserts can make this conservative; a resync is always safe.
 */
export function roomCursorExpired(after: number, bounds: { min: number; max: number }): boolean {
  return after > 0 && bounds.max > 0 && after + 1 < bounds.min;
}

export async function roomChangesAfter(db: Reader, roomId: string, after: number) {
  const rows = await db
    .select()
    .from(agentRoomChanges)
    .where(and(eq(agentRoomChanges.roomId, roomId), gt(agentRoomChanges.seq, after)))
    .orderBy(asc(agentRoomChanges.seq))
    .limit(ROOM_DELTA_LIMIT + 1);
  return { rows: rows.slice(0, ROOM_DELTA_LIMIT), hasMore: rows.length > ROOM_DELTA_LIMIT };
}

/** Per-room newest sequence for every room changed after the cursor. */
export async function roomHeadsAfter(db: Reader, after: number) {
  const rows = await db
    .select({ roomId: agentRoomChanges.roomId, seq: sql<number>`MAX(${agentRoomChanges.seq})` })
    .from(agentRoomChanges)
    .where(gt(agentRoomChanges.seq, after))
    .groupBy(agentRoomChanges.roomId)
    .orderBy(sql`MAX(${agentRoomChanges.seq})`)
    .limit(ROOM_DELTA_LIMIT + 1);
  return rows.map((r) => ({ roomId: r.roomId, seq: Number(r.seq) }));
}
