import { randomUUID } from 'node:crypto';
import { and, asc, eq, gt, isNull, lt, lte } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { RouteContext } from '../../routes/index.js';
import {
  adminUsers,
  agentEvents,
  companionDevices,
  companionFollows,
  companionNotifications,
  companionPairings,
  insecureAuthRequests,
} from '../../db/schema.js';
import { roleHasCapability } from '../../security/capabilities.js';
import { decrypt } from '../../security/secret-box.js';
import { isoOffsetSeconds, nowIso } from '../../util/timestamp.js';
import { createAgentPortalService } from '../agent-portal.js';
import { stalePendingReason } from '../insecure-window.js';
import { readFleetEngineState } from '../engine-switch.js';
import { isEngine } from '../../util/engine.js';
import { FcmTransport } from './fcm.js';
import { decodeSummaryPayload, eventSummary } from './summary.js';

export function notificationKind(type: string, followed: boolean): 'attention' | 'reply' | null {
  if (type === 'waiting_input' || type === 'attention') return 'attention';
  return type === 'assistant_message' && followed ? 'reply' : null;
}

/** Replay durable source rows into a unique per-device outbox. No WS dependency. */
export class CompanionPush {
  readonly transport: FcmTransport;
  constructor(private readonly ctx: RouteContext) {
    this.transport = new FcmTransport(ctx.env);
  }
  async tick() {
    await this.ctx.db.delete(companionPairings).where(lt(companionPairings.expiresAt, nowIso()));
    if (!this.transport.configured) return;
    const { db, env, keyring } = this.ctx;
    const portal = createAgentPortalService(db, env, keyring);
    const enabled = await portal.isEnabled();
    const fleet = await readFleetEngineState(db);
    const visible = enabled
      ? new Set(
          (await portal.listAgentsSnapshot()).sessions
            .filter((s) => isEngine(s.engine) && fleet[s.engine])
            .map((s) => String(s.id)),
        )
      : new Set<string>();
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
          const kind = notificationKind(event.eventType, follows.has(event.sessionId));
          if (!kind || Date.parse(event.createdAt) < Date.now() - 3600_000) continue;
          if (fresh.visibleSessionId === event.sessionId && (fresh.visibleUntil ?? '') > nowIso()) continue;
          await enqueue(
            `event:${event.id}`,
            kind,
            event.sessionId,
            isoOffsetSeconds(3600, new Date(event.createdAt)),
          );
        }
        if (events.length)
          await tx
            .update(companionDevices)
            .set({ eventCursor: events.at(-1)!.id })
            .where(eq(companionDevices.id, fresh.id));
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
        } else {
          eligible =
            (await portal.isEnabled()) &&
            visible.has(job.targetId) &&
            roleHasCapability(row.user.accessLevel, 'agent_portal.reveal_transcript');
          if (row.device.visibleSessionId === job.targetId && (row.device.visibleUntil ?? '') > nowIso())
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
            eligible = eligible && !!follow;
          }
        }
      }
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
        if (job.kind !== 'approval') {
          // Resolve the outbox's source event, never the session's latest preview:
          // another reply may have arrived while this delivery was retrying.
          const eventId = /^event:(\d+)$/.exec(job.sourceKey)?.[1];
          const [event] = eventId
            ? await db
                .select()
                .from(agentEvents)
                .where(and(eq(agentEvents.id, Number(eventId)), eq(agentEvents.sessionId, job.targetId)))
            : [];
          data.summary = eventSummary(
            event?.eventType ?? 'assistant_message',
            event ? decodeSummaryPayload(event.payloadEnc, this.ctx) : {},
          );
          if (event) data.event_cursor = String(event.id);
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
      } catch {
        await db
          .update(companionNotifications)
          .set({
            state: job.attempts >= 7 ? 'failed' : 'pending',
            nextAttemptAt: isoOffsetSeconds(Math.min(300, 5 * 2 ** job.attempts)),
          })
          .where(eq(companionNotifications.id, job.id));
      }
    }
    await db
      .delete(companionNotifications)
      .where(lt(companionNotifications.expiresAt, isoOffsetSeconds(-86400)));
  }
}

export function startCompanionPush(app: FastifyInstance, ctx: RouteContext) {
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
