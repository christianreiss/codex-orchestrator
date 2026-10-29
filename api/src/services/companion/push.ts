import { ownerRuntimeFor } from '../../control-plane/state/runtime.js';
import { OwnerCompanionPush } from './push-owner.js';
import { randomUUID } from 'node:crypto';
import { and, asc, eq, gt, isNull, like, lt, lte, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { RouteContext } from '../../routes/index.js';
import {
  adminUsers,
  agentEvents,
  agentRoomChanges,
  agentRoomReads,
  agentSessions,
  agentChatNotices,
  companionRoomPrefs,
  companionDevices,
  companionReads,
  companionFollows,
  companionDaemonFollows,
  hostDaemonPortalBindings,
  hostDaemonSessions,
  companionNotifications,
  companionPairings,
  insecureAuthRequests,
  providerAccounts,
} from '../../db/schema.js';
import {
  QUOTA_PUSH_PREFIX,
  coversQuotaWindow,
  quotaAlerts,
  quotaJobExpiresAt,
  quotaPushAllowed,
  quotaPushData,
  quotaSourceKey,
} from './quota-push.js';
import { roleHasCapability } from '../../security/capabilities.js';
import { decrypt } from '../../security/secret-box.js';
import { isoOffsetSeconds, nowIso } from '../../util/timestamp.js';
import { createAgentPortalService } from '../agent-portal.js';
import { stalePendingReason } from '../insecure-window.js';
import { readFleetEngineState } from '../engine-switch.js';
import { isEngine } from '../../util/engine.js';
import { FcmTransport } from './fcm.js';
import { decodeSummaryPayload, eventSummary, notificationKind } from './summary.js';
import { agentPushData, roomJobData, roomPushAllowed, roomPushCandidates, type RoomPushMode } from './room-push.js';
import { createAgentMessagingService } from '../agent-messaging.js';
import { AgentRoomChat } from '../agent-room-chat/index.js';

export { notificationKind } from './summary.js';
/** A room job whose event or room is gone is canceled, never retried. */
class RoomJobGone extends Error {}

/** Replay durable source rows into a unique per-device outbox. No WS dependency. */
export class CompanionPush {
  readonly transport: FcmTransport;
  private cleanedAt = 0;
  private quotaAt = 0;
  constructor(private readonly ctx: RouteContext) {
    this.transport = new FcmTransport(ctx.env);
  }
  async tick() {
    if (Date.now() - this.cleanedAt >= 60_000) {
      await this.ctx.db.delete(companionPairings).where(lt(companionPairings.expiresAt, nowIso()));
      await this.ctx.db.delete(companionNotifications).where(lt(companionNotifications.expiresAt, isoOffsetSeconds(-86400)));
      this.cleanedAt = Date.now();
    }
    if (!this.transport.configured) return;
    if (Date.now() - this.quotaAt >= 60_000) {
      this.quotaAt = Date.now();
      await this.quotaScan();
    }
    const { db, env, keyring } = this.ctx;
    // Durable cursors/outbox are the wake source. An empty tick must not build
    // the whole agent roster or lock every device just to find no new events.
    // Over-matching is harmless: authorization and delivery stay in the body.
    const [work] = await db.select({ needed: sql<number>`
      EXISTS (SELECT 1 FROM ${companionNotifications}
        WHERE ${companionNotifications.state} = 'pending' AND ${companionNotifications.nextAttemptAt} <= ${nowIso()})
      OR EXISTS (SELECT 1 FROM ${companionDevices}
        WHERE ${companionDevices.revokedAt} IS NULL AND ${companionDevices.expiresAt} > ${nowIso()}
          AND ${companionDevices.notifications} = 1 AND ${companionDevices.fcmTokenEnc} IS NOT NULL
          AND (${companionDevices.eventCursor} < (SELECT MAX(${agentEvents.id}) FROM ${agentEvents})
            OR ${companionDevices.roomChangeCursor} < (SELECT COALESCE(MAX(${agentRoomChanges.seq}), 0) FROM ${agentRoomChanges})
            OR EXISTS (SELECT 1 FROM ${insecureAuthRequests}
              WHERE ${insecureAuthRequests.status} = 'pending')))` })
      .from(sql`(SELECT 1) AS push_work`).limit(1);
    if (!work?.needed) return;
    const portal = createAgentPortalService(db, env, keyring);
    const enabled = await portal.isEnabled();
    const bus = createAgentMessagingService(db, env, keyring);
    const rooms = new AgentRoomChat(db, env, keyring, bus);
    const roomsEnabled = await bus.isEnabled();
    const fleet = await readFleetEngineState(db);
    const visible = enabled
      ? new Set(
          (await portal.listAgentsSnapshot()).sessions
            .filter((s) => isEngine(s.engine) && fleet[s.engine])
            .map((s) => String(s.id)),
        )
      : new Set<string>();
    const bindings = await db
      .select({
        portal: hostDaemonPortalBindings.portalSessionId,
        remote: hostDaemonSessions.id,
        owner: hostDaemonSessions.owner,
      })
      .from(hostDaemonPortalBindings)
      .innerJoin(hostDaemonSessions, eq(hostDaemonSessions.id, hostDaemonPortalBindings.daemonSessionId));
    const remoteByPortal = new Map(bindings.map((b) => [b.portal, b]));
    const ownerByRemote = new Map(bindings.map((b) => [b.remote, b.owner]));
    for (const b of bindings) if (visible.has(b.portal)) visible.add(b.remote);
    const devices = await db
      .select()
      .from(companionDevices)
      .where(and(isNull(companionDevices.revokedAt), gt(companionDevices.expiresAt, nowIso())));
    const pending = await db
      .select()
      .from(insecureAuthRequests)
      .where(eq(insecureAuthRequests.status, 'pending'));
    for (const device of devices) {
      await db.transaction(async (tx) => {
        const [fresh] = await tx
          .select()
          .from(companionDevices)
          .where(eq(companionDevices.id, device.id))
          .for('update');
        if (!fresh || fresh.revokedAt || !fresh.notifications || !fresh.fcmTokenEnc) return;
        const [user] = await tx.select().from(adminUsers).where(eq(adminUsers.id, fresh.userId));
        if (!user?.active) return;
        const follows = new Set(
          (await tx.select().from(companionFollows).where(eq(companionFollows.deviceId, fresh.id))).map(
            (f) => f.sessionId,
          ),
        );
        for (const f of await tx
          .select()
          .from(companionDaemonFollows)
          .where(eq(companionDaemonFollows.deviceId, fresh.id)))
          follows.add(f.daemonSessionId);
        const enqueue = async (sourceKey: string, kind: string, targetId: string, expiresAt: string) => {
          await tx
            .insert(companionNotifications)
            .values({
              id: randomUUID(),
              deviceId: fresh.id,
              sourceKey,
              kind,
              targetId,
              createdAt: nowIso(),
              nextAttemptAt: nowIso(),
              expiresAt,
            })
            .onDuplicateKeyUpdate({ set: { sourceKey } });
        };
        if (roleHasCapability(user.accessLevel, 'hosts.activate_insecure')) {
          for (const request of pending) {
            if (request.updatedAt === request.requestedAt || stalePendingReason(request, Date.now()))
              continue;
            await enqueue(
              `approval:${request.id}`,
              'approval',
              String(request.id),
              isoOffsetSeconds(300, new Date(request.requestedAt)),
            );
          }
        }
        const events = await tx
          .select()
          .from(agentEvents)
          .where(gt(agentEvents.id, fresh.eventCursor))
          .orderBy(asc(agentEvents.id))
          .limit(250);
        for (const event of events) {
          if (
            !enabled ||
            !visible.has(event.sessionId) ||
            !roleHasCapability(user.accessLevel, 'agent_portal.reveal_transcript')
          )
            continue;
          const binding = remoteByPortal.get(event.sessionId);
          const targetId = binding?.owner === `admin:${user.id}` ? binding.remote : event.sessionId;
          const payload = decodeSummaryPayload(event.payloadEnc, this.ctx);
          const kind = notificationKind(event.eventType, follows.has(targetId), payload);
          if (!kind || Date.parse(event.createdAt) < Date.now() - 3600_000) continue;
          if (fresh.visibleSessionId === targetId && (fresh.visibleUntil ?? '') > nowIso()) continue;
          await enqueue(
            payload.notice_id && payload.severity ? `notice:${String(payload.notice_id)}:${String(payload.severity)}` : `event:${event.id}`,
            kind,
            targetId,
            isoOffsetSeconds(3600, new Date(event.createdAt)),
          );
        }
        if (events.length)
          await tx
            .update(companionDevices)
            .set({ eventCursor: events.at(-1)!.id })
            .where(eq(companionDevices.id, fresh.id));
        // Room pushes: the cursor advances over every change kind, only events notify.
        const changes = await tx
          .select()
          .from(agentRoomChanges)
          .where(gt(agentRoomChanges.seq, fresh.roomChangeCursor))
          .orderBy(asc(agentRoomChanges.seq))
          .limit(250);
        if (changes.length) {
          if (roomsEnabled && roomPushAllowed(user.accessLevel)) {
            const prefs = new Map(
              (await tx.select().from(companionRoomPrefs).where(eq(companionRoomPrefs.deviceId, fresh.id))).map(
                (p) => [p.roomId, p.mode as RoomPushMode],
              ),
            );
            for (const candidate of await roomPushCandidates(tx, keyring, changes, {
              operator: { key: `admin:${user.id}`, name: user.name },
              mode: (roomId) => prefs.get(roomId) ?? 'default',
              suppressed: (roomId) => fresh.visibleSessionId === roomId && (fresh.visibleUntil ?? '') > nowIso(),
            }))
              await enqueue(candidate.sourceKey, 'room', candidate.roomId, candidate.expiresAt);
          }
          await tx
            .update(companionDevices)
            .set({ roomChangeCursor: changes.at(-1)!.seq })
            .where(eq(companionDevices.id, fresh.id));
        }
      });
    }
    const jobs = await db
      .select()
      .from(companionNotifications)
      .where(
        and(eq(companionNotifications.state, 'pending'), lte(companionNotifications.nextAttemptAt, nowIso())),
      )
      .orderBy(asc(companionNotifications.createdAt))
      .limit(50);
    for (const job of jobs) {
      // Reserve by conditional update; a crashed worker's lease expires after one minute.
      const [claim] = await db
        .update(companionNotifications)
        .set({ nextAttemptAt: isoOffsetSeconds(60), attempts: job.attempts + 1 })
        .where(
          and(
            eq(companionNotifications.id, job.id),
            eq(companionNotifications.attempts, job.attempts),
            lte(companionNotifications.nextAttemptAt, nowIso()),
          ),
        );
      if (!claim.affectedRows) continue;
      const [row] = await db
        .select({ device: companionDevices, user: adminUsers })
        .from(companionDevices)
        .innerJoin(adminUsers, eq(companionDevices.userId, adminUsers.id))
        .where(eq(companionDevices.id, job.deviceId));
      let eligible =
        !!row?.user.active &&
        !row.device.revokedAt &&
        row.device.expiresAt > nowIso() &&
        !!row.device.notifications &&
        !!row.device.fcmTokenEnc &&
        job.expiresAt > nowIso();
      if (eligible && row) {
        if (job.kind === 'approval') {
          const [request] = await db
            .select()
            .from(insecureAuthRequests)
            .where(eq(insecureAuthRequests.id, Number(job.targetId)));
          eligible =
            roleHasCapability(row.user.accessLevel, 'hosts.activate_insecure') &&
            !!request &&
            request.status === 'pending' &&
            !stalePendingReason(request, Date.now());
        } else if (job.kind === 'quota') {
          eligible = quotaPushAllowed(row.user.accessLevel);
        } else if (job.kind === 'room' || job.kind === 'room_read') {
          eligible = roomPushAllowed(row.user.accessLevel) && (await bus.isEnabled());
          if (job.kind === 'room_read') {
            const [read] = await db
              .select()
              .from(agentRoomReads)
              .where(and(eq(agentRoomReads.roomId, job.targetId), eq(agentRoomReads.adminId, row.user.id)));
            eligible = eligible && row.device.readSyncProtocol === 1 && !!read;
          } else {
            const [pref] = await db
              .select()
              .from(companionRoomPrefs)
              .where(and(eq(companionRoomPrefs.deviceId, job.deviceId), eq(companionRoomPrefs.roomId, job.targetId)));
            if (pref?.mode === 'mute') eligible = false;
            if (row.device.visibleSessionId === job.targetId && (row.device.visibleUntil ?? '') > nowIso())
              eligible = false;
          }
        } else {
          eligible =
            (await portal.isEnabled()) &&
            visible.has(job.targetId) &&
            (!ownerByRemote.has(job.targetId) ||
              ownerByRemote.get(job.targetId) === `admin:${row.user.id}`) &&
            roleHasCapability(row.user.accessLevel, 'agent_portal.reveal_transcript');
          if (job.kind !== 'read' && row.device.visibleSessionId === job.targetId && (row.device.visibleUntil ?? '') > nowIso())
            eligible = false;
          if (job.kind === 'reply') {
            const [follow] = await db
              .select()
              .from(companionFollows)
              .where(
                and(
                  eq(companionFollows.deviceId, job.deviceId),
                  eq(companionFollows.sessionId, job.targetId),
                ),
              );
            const [remoteFollow] = await db
              .select()
              .from(companionDaemonFollows)
              .where(
                and(
                  eq(companionDaemonFollows.deviceId, job.deviceId),
                  eq(companionDaemonFollows.daemonSessionId, job.targetId),
                ),
              );
            eligible = eligible && (!!follow || !!remoteFollow);
          }
        }
      }
      if (row && eligible && (job.kind === 'read' || job.kind === 'reply')) {
        const [read] = await db.select().from(companionReads).where(and(eq(companionReads.userId, row.user.id), eq(companionReads.sessionId, job.targetId)));
        if (job.kind === 'read' && (row.device.readSyncProtocol !== 1 || !read)) eligible = false;
        if (job.kind === 'reply' && Number(/^event:(\d+)$/.exec(job.sourceKey)?.[1] ?? Infinity) <= (read?.readCursor ?? 0)) eligible = false;
      }
      const noticeSource = /^notice:([0-9a-f-]{36}):(important|critical|blocker)$/.exec(job.sourceKey);
      const [sourceNotice] = noticeSource ? await db.select().from(agentChatNotices).where(eq(agentChatNotices.id, noticeSource[1]!)) : [];
      if (noticeSource && (!sourceNotice || sourceNotice.resolvedAt || sourceNotice.severity !== noticeSource[2])) eligible = false;
      if (!eligible || !row) {
        await db
          .update(companionNotifications)
          .set({ state: 'canceled' })
          .where(eq(companionNotifications.id, job.id));
        continue;
      }
      try {
        const data: Record<string, string> = {
          notification_id: job.id,
          device_id: job.deviceId,
          kind: job.kind,
          target_id: job.targetId,
        };
        if (job.kind === 'quota') {
          const [account] = await db.select().from(providerAccounts).where(eq(providerAccounts.id, Number(job.targetId)));
          const quota = await quotaPushData(db, job, account);
          if (!quota) throw new RoomJobGone();
          Object.assign(data, quota);
        } else if (job.kind === 'room') {
          const room = await roomJobData(db, keyring, rooms, job);
          if (!room) throw new RoomJobGone();
          Object.assign(data, room);
        } else if (job.kind === 'room_read') {
          const [read] = await db
            .select()
            .from(agentRoomReads)
            .where(and(eq(agentRoomReads.roomId, job.targetId), eq(agentRoomReads.adminId, row.user.id)));
          Object.assign(data, { room_id: job.targetId, conversation_key: `room:${job.targetId}`, read_at: read?.readAt ?? '' });
        } else if (job.kind === 'read') {
          const [read] = await db.select().from(companionReads).where(and(eq(companionReads.userId, row.user.id), eq(companionReads.sessionId, job.targetId)));
          data.event_cursor = String(read?.readCursor ?? 0);
        } else if (job.kind !== 'approval') {
          // Resolve the outbox's source event, never the session's latest preview:
          // another reply may have arrived while this delivery was retrying.
          const eventId = sourceNotice?.eventId ?? /^event:(\d+)$/.exec(job.sourceKey)?.[1];
          const [event] = eventId
            ? await db
                .select()
                .from(agentEvents)
                .where(eq(agentEvents.id, Number(eventId)))
            : [];
          if (
            event &&
            event.sessionId !== job.targetId &&
            remoteByPortal.get(event.sessionId)?.remote !== job.targetId
          )
            throw new Error('Push source does not belong to conversation');
          data.summary = eventSummary(
            event?.eventType ?? 'assistant_message',
            event ? decodeSummaryPayload(event.payloadEnc, this.ctx) : {},
          );
          if (event) {
            data.event_cursor = String(event.id);
            const [session] = await db
              .select({ launchName: agentSessions.launchName, engine: agentSessions.engine })
              .from(agentSessions)
              .where(eq(agentSessions.id, event.sessionId));
            Object.assign(
              data,
              agentPushData({
                targetId: job.targetId,
                agentName: session?.launchName ?? null,
                engine: session?.engine ?? null,
                eventId: event.id,
                createdAt: event.createdAt,
                eventType: event.eventType,
                payload: decodeSummaryPayload(event.payloadEnc, this.ctx),
              }),
            );
          }
          if (sourceNotice) { data.notice_id = sourceNotice.id; data.severity = sourceNotice.severity; }
        }
        const outcome = await this.transport.send(
          decrypt(row.device.fcmTokenEnc!, keyring),
          data,
          Math.floor((Date.parse(job.expiresAt) - Date.now()) / 1000),
        );
        if (outcome === 'invalid')
          await db
            .update(companionDevices)
            .set({ fcmTokenEnc: null })
            .where(
              and(
                eq(companionDevices.id, job.deviceId),
                eq(companionDevices.fcmTokenEnc, row.device.fcmTokenEnc!),
              ),
            );
        await db
          .update(companionNotifications)
          .set({ state: outcome === 'sent' ? 'sent' : 'canceled' })
          .where(eq(companionNotifications.id, job.id));
      } catch (error) {
        if (error instanceof RoomJobGone) {
          await db.update(companionNotifications).set({ state: 'canceled' }).where(eq(companionNotifications.id, job.id));
          continue;
        }
        await db
          .update(companionNotifications)
          .set({
            state: job.attempts >= 7 ? 'failed' : 'pending',
            nextAttemptAt: isoOffsetSeconds(Math.min(300, 5 * 2 ** job.attempts)),
          })
          .where(eq(companionNotifications.id, job.id));
      }
    }
  }
  /** Quota warnings: enqueue once per device and account window (see quota-push.ts). */
  async quotaScan() {
    const { db } = this.ctx;
    const accounts = await db
      .select({ id: providerAccounts.id, engine: providerAccounts.engine, state: providerAccounts.state })
      .from(providerAccounts)
      .where(isNull(providerAccounts.mergedIntoAccountId));
    const alerts = await quotaAlerts(db, accounts);
    if (!alerts.length) return;
    const devices = await db
      .select({ device: companionDevices, user: adminUsers })
      .from(companionDevices)
      .innerJoin(adminUsers, eq(companionDevices.userId, adminUsers.id))
      .where(and(isNull(companionDevices.revokedAt), gt(companionDevices.expiresAt, nowIso())));
    for (const { device, user } of devices) {
      if (!user.active || !device.notifications || !device.fcmTokenEnc || !quotaPushAllowed(user.accessLevel)) continue;
      const existing = (
        await db
          .select({ sourceKey: companionNotifications.sourceKey })
          .from(companionNotifications)
          .where(and(eq(companionNotifications.deviceId, device.id), like(companionNotifications.sourceKey, `${QUOTA_PUSH_PREFIX}%`)))
      ).map((row) => row.sourceKey);
      for (const alert of alerts) {
        if (existing.some((key) => coversQuotaWindow(key, alert))) continue;
        const sourceKey = quotaSourceKey(alert);
        await db
          .insert(companionNotifications)
          .values({
            id: randomUUID(),
            deviceId: device.id,
            sourceKey,
            kind: 'quota',
            targetId: String(alert.accountId),
            createdAt: nowIso(),
            nextAttemptAt: nowIso(),
            expiresAt: quotaJobExpiresAt(alert.resetsAt),
          })
          .onDuplicateKeyUpdate({ set: { sourceKey } });
        existing.push(sourceKey);
      }
    }
  }
}

export function startCompanionPush(app: FastifyInstance, ctx: RouteContext) {
  if (ownerRuntimeFor(ctx.db)) {
    const worker = new OwnerCompanionPush(ctx).start(error => app.log.error({ err: error }, 'Companion push obligation failed'));
    app.addHook('onClose', async () => { await worker.close(); });
    return;
  }
  const worker = new CompanionPush(ctx);
  let running: Promise<void> | undefined;
  const timer = setInterval(() => {
    if (running) return;
    running = worker
      .tick()
      .catch(() => {
        app.log.warn('Companion push scan failed; will retry');
      })
      .finally(() => {
        running = undefined;
      });
  }, 5000);
  timer.unref();
  app.addHook('onClose', async () => {
    clearInterval(timer);
    await running;
  });
}
