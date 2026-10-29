import { randomUUID } from 'node:crypto';
import { and, eq, gt, isNotNull, isNull } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import { companionDevices, companionNotifications } from '../../db/schema.js';
import type { OwnerMutationContext } from '../../control-plane/state/runtime.js';
import { isoOffsetSeconds, nowIso } from '../../util/timestamp.js';

/** The operator identity behind a room read position; `deviceId` is the device that read it. */
export interface RoomReader {
  adminId?: number;
  deviceId?: string;
}

/** Silent room read-sync job: lets sibling devices clear the same room's badge. No content. */
export function roomReadJob(deviceId: string, roomId: string, readAt: string) {
  const now = nowIso();
  return {
    id: randomUUID(),
    deviceId,
    sourceKey: `room_read:${roomId}:${readAt}`,
    kind: 'room_read',
    targetId: roomId,
    expiresAt: isoOffsetSeconds(3600),
    createdAt: now,
    nextAttemptAt: now,
    state: 'pending',
    attempts: 0,
  };
}

/** Plain database: enqueue in the read-position transaction (reads.ts pattern, read_sync_protocol 1 only). */
export async function enqueueRoomReadSync(
  tx: Pick<Database, 'select' | 'insert'>,
  reader: RoomReader,
  roomId: string,
  readAt: string,
): Promise<void> {
  if (!reader.adminId) return;
  const devices = await tx
    .select({ id: companionDevices.id, readSyncProtocol: companionDevices.readSyncProtocol, notifications: companionDevices.notifications })
    .from(companionDevices)
    .where(
      and(
        eq(companionDevices.userId, reader.adminId),
        isNull(companionDevices.revokedAt),
        gt(companionDevices.expiresAt, nowIso()),
        isNotNull(companionDevices.fcmTokenEnc),
      ),
    );
  for (const device of devices) {
    if (device.id === reader.deviceId || device.readSyncProtocol !== 1 || !device.notifications) continue;
    const job = roomReadJob(device.id, roomId, readAt);
    await tx.insert(companionNotifications).values(job).onDuplicateKeyUpdate({ set: { sourceKey: job.sourceKey } });
  }
}

/** Owner mode: stage the same jobs in the read-position command. */
export function stageRoomReadSync(
  ctx: Pick<OwnerMutationContext, 'draft' | 'write'>,
  reader: RoomReader,
  roomId: string,
  readAt: string,
): void {
  if (!reader.adminId) return;
  for (const device of ctx.draft.table('companionDevices').by('userId', reader.adminId)) {
    if (
      device.id === reader.deviceId ||
      device.revokedAt ||
      device.expiresAt <= nowIso() ||
      device.readSyncProtocol !== 1 ||
      !device.notifications ||
      !device.pushTokenDigest
    )
      continue;
    const job = roomReadJob(device.id, roomId, readAt);
    if (ctx.draft.table('companionNotifications').all().some((j) => j.deviceId === device.id && j.sourceKey === job.sourceKey))
      continue;
    ctx.draft.upsert('companionNotifications', job);
    ctx.write(async (tx) => {
      await tx.insert(companionNotifications).values(job);
    });
  }
}
