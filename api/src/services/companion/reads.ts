import { UnauthorizedError } from '../../http/errors.js';
import { randomUUID } from 'node:crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { RouteContext } from '../../routes/index.js';
import { adminUsers, agentEvents, companionDevices, companionNotifications, companionReads, hostDaemonSessions } from '../../db/schema.js';
import { mutateOwnerState, ownerRuntimeFor } from '../../control-plane/state/runtime.js';
import { roleHasCapability } from '../../security/capabilities.js';
import { wsPublisher } from '../../ws/publisher.js';
import { isoOffsetSeconds, nowIso } from '../../util/timestamp.js';

/** Markers contain no transcript text or device credentials. Writes are explicit,
 * monotonic and restricted to real assistant events in the authorized projection. */
export async function companionReadCursors(
  ctx: RouteContext, userId: number, sessions: Array<Record<string, unknown>>,
  aliases: ReadonlyMap<string, string>, submitted?: Readonly<Record<string, number>>, deviceId?: string,
): Promise<Record<string, number>> {
  const owner = ownerRuntimeFor(ctx.db);
  owner?.assertOwner();
  const rows = owner ? owner.state.snapshot().table('companionReads').by('userId', userId)
    : await ctx.db.select().from(companionReads).where(eq(companionReads.userId, userId));
  const visible = new Set(sessions.map(s => String(s.id)));
  const markers = Object.fromEntries(rows.filter(r => visible.has(r.sessionId)).map(r => [r.sessionId, r.readCursor]));
  const advances = Object.entries(submitted ?? {}).filter(([id, cursor]) => visible.has(id) && cursor > (markers[id] ?? 0));
  if (!advances.length) return markers;
  const events = await ctx.db.select({ id: agentEvents.id, sessionId: agentEvents.sessionId }).from(agentEvents)
    .where(and(inArray(agentEvents.id, advances.map(([, cursor]) => cursor)), eq(agentEvents.eventType, 'assistant_message')));
  const candidates = advances.filter(([id, cursor]) => events.some(e => e.id === cursor && (aliases.get(e.sessionId) ?? e.sessionId) === id));
  if (!candidates.length) return markers;
  const jobs = (deviceId: string, sessionId: string, cursor: number) => ({ id: randomUUID(), deviceId,
    sourceKey: `read:${sessionId}:${cursor}`, kind: 'read', targetId: sessionId, expiresAt: isoOffsetSeconds(3600),
    createdAt: nowIso(), nextAttemptAt: nowIso(), state: 'pending', attempts: 0 });
  let changed = false;
  if (owner) {
    await mutateOwnerState(owner, { kind: 'companion.reads', payload: { userId, candidates }, prepare(context) {
      const principal = deviceId ? context.draft.table('companionDevices').get(deviceId) : undefined;
      if (!principal || principal.userId !== userId || principal.revokedAt || principal.expiresAt <= nowIso()) throw new UnauthorizedError('Device revoked', 'device_revoked');
      const user = context.draft.table('adminUsers').get(userId);
      if (!user?.active || !roleHasCapability(user.accessLevel, 'agent_portal.read') || !roleHasCapability(user.accessLevel, 'agent_portal.reveal_transcript')) return null;
      for (const [sessionId, readCursor] of candidates) {
        const remote = context.draft.table('hostDaemonSessions').get(sessionId);
        if ((remote && remote.owner !== `admin:${userId}`) || (!remote && [...aliases.values()].includes(sessionId))) continue;
        const old = context.draft.table('companionReads').get([userId, sessionId]);
        if (old && old.readCursor >= readCursor) continue;
        const row = { userId, sessionId, readCursor, updatedAt: nowIso() };
        context.draft.upsert('companionReads', row);
        context.write(async tx => { await tx.insert(companionReads).values(row).onDuplicateKeyUpdate({ set: { readCursor: sql`GREATEST(read_cursor, ${readCursor})`, updatedAt: row.updatedAt } }); });
        for (const device of context.draft.table('companionDevices').by('userId', userId)) {
          if (device.revokedAt || device.expiresAt <= nowIso() || device.readSyncProtocol !== 1 || !device.notifications || !device.pushTokenDigest) continue;
          const job = jobs(device.id, sessionId, readCursor);
          context.draft.upsert('companionNotifications', job);
          context.write(async tx => { await tx.insert(companionNotifications).values(job); });
        }
        changed = true;
      }
      return null;
    } });
  } else {
    await ctx.db.transaction(async tx => {
      const [user] = await tx.select().from(adminUsers).where(eq(adminUsers.id, userId)).for('update');
      const [principal] = deviceId ? await tx.select().from(companionDevices).where(eq(companionDevices.id, deviceId)).for('update') : [];
      if (!principal || principal.userId !== userId || principal.revokedAt || principal.expiresAt <= nowIso()) throw new UnauthorizedError('Device revoked', 'device_revoked');
      if (!user?.active || !roleHasCapability(user.accessLevel, 'agent_portal.read') || !roleHasCapability(user.accessLevel, 'agent_portal.reveal_transcript')) return;
      const devices = await tx.select().from(companionDevices).where(eq(companionDevices.userId, userId));
      for (const [sessionId, readCursor] of candidates) {
        const [remote] = await tx.select().from(hostDaemonSessions).where(eq(hostDaemonSessions.id, sessionId)).for('update');
        if ((remote && remote.owner !== `admin:${userId}`) || (!remote && [...aliases.values()].includes(sessionId))) continue;
        const [old] = await tx.select().from(companionReads).where(and(eq(companionReads.userId, userId), eq(companionReads.sessionId, sessionId)));
        if (old && old.readCursor >= readCursor) continue;
        await tx.insert(companionReads).values({ userId, sessionId, readCursor, updatedAt: nowIso() })
          .onDuplicateKeyUpdate({ set: { readCursor: sql`GREATEST(read_cursor, ${readCursor})`, updatedAt: nowIso() } });
        for (const device of devices) {
          if (device.revokedAt || device.expiresAt <= nowIso() || device.readSyncProtocol !== 1 || !device.notifications || !device.fcmTokenEnc) continue;
          await tx.insert(companionNotifications).values(jobs(device.id, sessionId, readCursor));
        }
        changed = true;
      }
    });
  }
  if (changed) wsPublisher.publish('companion.devices.changed', {});
  // Re-read: an overlapping request may already have advanced farther.
  owner?.assertOwner();
  const current = owner ? owner.state.snapshot().table('companionReads').by('userId', userId)
    : await ctx.db.select().from(companionReads).where(eq(companionReads.userId, userId));
  return Object.fromEntries(current.filter(r => visible.has(r.sessionId)).map(r => [r.sessionId, r.readCursor]));
}
