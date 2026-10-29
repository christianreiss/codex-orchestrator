import { createHash, randomUUID } from 'node:crypto';
import { asc, eq, gt } from 'drizzle-orm';
import type { RouteContext } from '../../routes/index.js';
import type { OwnerStateSnapshot } from '../../control-plane/state/store.js';
import type { StateRow } from '../../control-plane/state/catalog.js';
import {
  mutateOwnerState,
  requireOwnerRuntime,
  type OwnerMutationContext,
} from '../../control-plane/state/runtime.js';
import { stageDelete, stageUpdate } from '../../control-plane/state/rows.js';
import {
  pendingWithInterest,
  subscribeAdmissionInterest,
} from '../../control-plane/state/admission-interest.js';
import type { EffectHandler } from '../../control-plane/outbox.js';
import { createOwnerWorker, type OwnerWorkObligation } from '../../ops/owner-worker.js';
import { agentEvents, agentRoomChanges, companionDevices, companionNotifications } from '../../db/schema.js';
import { ROOM_CHANGE_HEAD_SETTING } from '../../control-plane/state/room-heads.js';
import { createAgentMessagingService } from '../agent-messaging.js';
import { AgentRoomChat } from '../agent-room-chat/index.js';
import { agentPushData, roomJobData, roomPushAllowed, roomPushCandidates, type RoomPushMode } from './room-push.js';
import { roleHasCapability } from '../../security/capabilities.js';
import { decrypt } from '../../security/secret-box.js';
import { isTruthyFlagValue } from '../settings.js';
import { stalePendingReason } from '../insecure-window.js';
import { companionVisible } from './presence.js';
import { FcmTransport, FcmSendError } from './fcm.js';
import { decodeSummaryPayload, eventSummary, notificationKind } from './summary.js';

const TABLES = [
  'companionDevices',
  'companionReads',
  'companionPairings',
  'companionNotifications',
  'companionFollows',
  'companionDaemonFollows',
  'companionRoomPrefs',
  'agentRoomReads',
  'adminUsers',
  'insecureAuthRequests',
  'agentSessions',
  'agentChatNotices',
  'hostDaemonPortalBindings',
  'hostDaemonSessions',
  'hosts',
  'versions',
] as const;
type Device = Readonly<StateRow<'companionDevices'>>;
type Job = Readonly<StateRow<'companionNotifications'>>;

/** Only actual source advancement and persisted business deadlines produce work. */
export class OwnerCompanionPush {
  readonly owner;
  readonly transport;
  private readonly rooms: AgentRoomChat;
  constructor(
    private readonly ctx: RouteContext,
    transport = new FcmTransport(ctx.env),
  ) {
    this.owner = requireOwnerRuntime(ctx.db);
    this.transport = transport;
    this.rooms = new AgentRoomChat(ctx.db, ctx.env, ctx.keyring, createAgentMessagingService(ctx.db, ctx.env, ctx.keyring));
  }
  private device(snapshot: OwnerStateSnapshot, id: string): Device | undefined {
    const d = snapshot.table('companionDevices').get(id);
    const u = d && snapshot.table('adminUsers').get(d.userId);
    return d &&
      u?.active &&
      !d.revokedAt &&
      Date.parse(d.expiresAt) > Date.now() &&
      d.notifications &&
      d.pushTokenDigest
      ? d
      : undefined;
  }
  private visible(snapshot: OwnerStateSnapshot, target: string, userId: number, allBindings = false): boolean {
    if (!isTruthyFlagValue(snapshot.setting('agent_portal_enabled'))) return false;
    const bindings = snapshot.table('hostDaemonPortalBindings').by('daemonSessionId', target);
    if (bindings.length && snapshot.table('hostDaemonSessions').get(target)?.owner !== `admin:${userId}`)
      return false;
    // Shared reads belong to the logical conversation across native resumptions.
    const physical = bindings.length ? (allBindings ? bindings : bindings.slice(0, 1)).map(b => b.portalSessionId) : [target];
    return physical.some(id => {
      const session = snapshot.table('agentSessions').get(id);
      const host = session && snapshot.table('hosts').get(session.hostId);
      return !!session && !!host && !host.internalRole &&
        !isTruthyFlagValue(snapshot.setting(`${session.engine}_engine_disabled`)) &&
        (!session.endedAt || Date.parse(session.expiresAt ?? '') > Date.now() ||
          snapshot.table('agentChatNotices').all().some(n => n.sessionId === session.id && !n.resolvedAt));
    });
  }
  private eligible(snapshot: OwnerStateSnapshot, job: Job): Device | undefined {
    const d = this.device(snapshot, job.deviceId);
    if (!d || Date.parse(job.expiresAt) <= Date.now()) return;
    const user = snapshot.table('adminUsers').get(d.userId)!;
    if (job.kind === 'room' || job.kind === 'room_read') {
      if (!roomPushAllowed(user.accessLevel) || snapshot.setting('agent_messaging_enabled') !== '1') return;
      if (job.kind === 'room_read')
        return d.readSyncProtocol === 1 && snapshot.table('agentRoomReads').get([job.targetId, d.userId]) ? d : undefined;
      if (snapshot.table('companionRoomPrefs').get([d.id, job.targetId])?.mode === 'mute') return;
      return companionVisible(this.owner, d.id, job.targetId) ? undefined : d;
    }
    if (job.kind === 'approval') {
      const r = snapshot.table('insecureAuthRequests').get(Number(job.targetId));
      return roleHasCapability(user.accessLevel, 'hosts.activate_insecure') &&
        r?.status === 'pending' &&
        !stalePendingReason(pendingWithInterest(this.owner, r), Date.now())
        ? d
        : undefined;
    }
    if (
      !roleHasCapability(user.accessLevel, 'agent_portal.reveal_transcript') ||
      !this.visible(snapshot, job.targetId, d.userId, job.kind === 'read') ||
      (job.kind !== 'read' && companionVisible(this.owner, d.id, job.targetId))
    )
      return;
    if (
      job.kind === 'reply' &&
      !snapshot
        .table('companionFollows')
        .all()
        .some((f) => f.deviceId === d.id && f.sessionId === job.targetId) &&
      !snapshot
        .table('companionDaemonFollows')
        .all()
        .some((f) => f.deviceId === d.id && f.daemonSessionId === job.targetId)
    )
      return;
    const read = snapshot.table('companionReads').get([d.userId, job.targetId])?.readCursor ?? 0;
    if (job.kind === 'read' && (d.readSyncProtocol !== 1 || read <= 0)) return;
    if (job.kind === 'reply' && Number(/^event:(\d+)$/.exec(job.sourceKey)?.[1] ?? Infinity) <= read) return;
    const source = /^notice:([0-9a-f-]{36}):(important|critical|blocker)$/.exec(job.sourceKey);
    if (source) {
      const notice = snapshot.table('agentChatNotices').get(source[1]!);
      if (!notice || notice.resolvedAt || notice.severity !== source[2]) return;
    }
    return d;
  }
  obligations(snapshot: OwnerStateSnapshot): OwnerWorkObligation[] {
    const work: OwnerWorkObligation[] = [];
    for (const p of snapshot.table('companionPairings').all())
      work.push({ key: `pairing:${p.tokenHash}`, dueAt: Date.parse(p.expiresAt), revision: p.expiresAt });
    for (const j of snapshot.table('companionNotifications').all()) {
      work.push({
        key: `retention:${j.id}`,
        dueAt: Date.parse(j.expiresAt) + 86400_000,
        revision: j.expiresAt,
      });
      if (j.state === 'pending' && this.transport.configured)
        work.push({
          key: `send:${j.id}`,
          dueAt: Math.min(Date.parse(j.nextAttemptAt), Date.parse(j.expiresAt)),
          revision: JSON.stringify(j),
        });
    }
    if (!this.transport.configured) return work;
    const head = Number(snapshot.setting('owner_portal_event_id') ?? 0);
    const roomHead = Number(snapshot.setting(ROOM_CHANGE_HEAD_SETTING) ?? 0);
    for (const d of snapshot.table('companionDevices').all())
      if (this.device(snapshot, d.id)) {
        if (d.eventCursor < head)
          work.push({ key: `events:${d.id}`, dueAt: 0, revision: `${d.eventCursor}:${head}` });
        const roomCursor = Number(d.roomChangeCursor ?? 0);
        if (roomCursor < roomHead)
          work.push({ key: `rooms:${d.id}`, dueAt: 0, revision: `${roomCursor}:${roomHead}` });
        const user = snapshot.table('adminUsers').get(d.userId)!;
        if (roleHasCapability(user.accessLevel, 'hosts.activate_insecure'))
          for (const raw of snapshot.table('insecureAuthRequests').all()) {
            const r = pendingWithInterest(this.owner, raw);
            if (
              r.status === 'pending' &&
              r.updatedAt !== r.requestedAt &&
              !stalePendingReason(r, Date.now()) &&
              !snapshot
                .table('companionNotifications')
                .all()
                .some((j) => j.deviceId === d.id && j.sourceKey === `approval:${r.id}`)
            )
              work.push({ key: `approval:${d.id}:${r.id}`, dueAt: 0, revision: r.updatedAt });
          }
      }
    return work;
  }
  private enqueue(
    c: OwnerMutationContext,
    d: Device,
    sourceKey: string,
    kind: string,
    targetId: string,
    expiresAt: string,
  ) {
    if (
      c.draft
        .table('companionNotifications')
        .all()
        .some((j) => j.deviceId === d.id && j.sourceKey === sourceKey)
    )
      return;
    const now = new Date().toISOString();
    const job = {
      id: randomUUID(),
      deviceId: d.id,
      sourceKey,
      kind,
      targetId,
      expiresAt,
      createdAt: now,
      nextAttemptAt: now,
      state: 'pending',
      attempts: 0,
    };
    c.draft.upsert('companionNotifications', job);
    c.write((tx) => tx.insert(companionNotifications).values(job));
  }
  async run(work: OwnerWorkObligation): Promise<void> {
    await mutateOwnerState(this.owner, {
      kind: 'companion.push.prepare',
      payload: { key: work.key },
      prepare: async (c) => {
        const [kind, ...rest] = work.key.split(':');
        const id = rest.join(':');
        if (kind === 'pairing') {
          const p = c.snapshot.table('companionPairings').get(id);
          if (p && Date.parse(p.expiresAt) <= Date.now()) stageDelete(c, 'companionPairings', id);
          return null;
        }
        if (kind === 'retention') {
          const j = c.snapshot.table('companionNotifications').get(id);
          if (j && Date.parse(j.expiresAt) + 86400_000 <= Date.now())
            stageDelete(c, 'companionNotifications', id);
          return null;
        }
        if (kind === 'send') {
          const j = c.snapshot.table('companionNotifications').get(id);
          if (!j || j.state !== 'pending') return null;
          if (!this.eligible(c.snapshot, j)) {
            stageUpdate(c, 'companionNotifications', id, { state: 'canceled' });
            return null;
          }
          stageUpdate(c, 'companionNotifications', id, { state: 'outbox' });
          c.effect({
            id: randomUUID(),
            kind: 'companion.push',
            target: id,
            payload: { notificationId: id },
            availableAt: new Date().toISOString(),
          });
          return null;
        }
        const deviceId = rest[0]!;
        const d = this.device(c.snapshot, deviceId);
        if (!d) return null;
        if (kind === 'approval') {
          const raw = c.snapshot.table('insecureAuthRequests').get(Number(rest[1]));
          if (raw) {
            const r = pendingWithInterest(this.owner, raw);
            if (r.status === 'pending' && r.updatedAt !== r.requestedAt && !stalePendingReason(r, Date.now()))
              this.enqueue(
                c,
                d,
                `approval:${r.id}`,
                'approval',
                String(r.id),
                new Date(Date.parse(r.requestedAt) + 300_000).toISOString(),
              );
          }
          return null;
        }
        if (kind === 'rooms') {
          const cursor = Number(d.roomChangeCursor ?? 0);
          const changes = await this.ctx.db
            .select()
            .from(agentRoomChanges)
            .where(gt(agentRoomChanges.seq, cursor))
            .orderBy(asc(agentRoomChanges.seq))
            .limit(250);
          if (!changes.length) {
            const head = Number(c.snapshot.setting(ROOM_CHANGE_HEAD_SETTING) ?? cursor);
            if (head > cursor) stageUpdate(c, 'companionDevices', d.id, { roomChangeCursor: head });
            return null;
          }
          const user = c.snapshot.table('adminUsers').get(d.userId)!;
          if (roomPushAllowed(user.accessLevel) && c.snapshot.setting('agent_messaging_enabled') === '1')
            for (const candidate of await roomPushCandidates(this.ctx.db, this.ctx.keyring, changes, {
              operator: { key: `admin:${user.id}`, name: user.name },
              mode: (roomId) =>
                (c.snapshot.table('companionRoomPrefs').get([d.id, roomId])?.mode as RoomPushMode | undefined) ??
                'default',
              suppressed: (roomId) => companionVisible(this.owner, d.id, roomId),
            }))
              this.enqueue(c, d, candidate.sourceKey, 'room', candidate.roomId, candidate.expiresAt);
          stageUpdate(c, 'companionDevices', d.id, { roomChangeCursor: changes.at(-1)!.seq });
          return null;
        }
        const events = await this.ctx.db
          .select()
          .from(agentEvents)
          .where(gt(agentEvents.id, d.eventCursor))
          .orderBy(asc(agentEvents.id))
          .limit(250);
        if (!events.length) {
          stageUpdate(c, 'companionDevices', d.id, {
            eventCursor: Number(c.snapshot.setting('owner_portal_event_id') ?? d.eventCursor),
          });
          return null;
        }
        const user = c.snapshot.table('adminUsers').get(d.userId)!;
        for (const event of events) {
          if (
            !roleHasCapability(user.accessLevel, 'agent_portal.reveal_transcript') ||
            !this.visible(c.snapshot, event.sessionId, user.id)
          )
            continue;
          const binding = c.snapshot
            .table('hostDaemonPortalBindings')
            .all()
            .find((b) => b.portalSessionId === event.sessionId);
          const remote = binding && c.snapshot.table('hostDaemonSessions').get(binding.daemonSessionId);
          const target = remote?.owner === `admin:${user.id}` ? remote.id : event.sessionId;
          const follows =
            c.snapshot
              .table('companionFollows')
              .all()
              .some((f) => f.deviceId === d.id && f.sessionId === target) ||
            c.snapshot
              .table('companionDaemonFollows')
              .all()
              .some((f) => f.deviceId === d.id && f.daemonSessionId === target);
          const payload = decodeSummaryPayload(event.payloadEnc, this.ctx),
            notification = notificationKind(event.eventType, follows, payload);
          if (
            !notification ||
            Date.parse(event.createdAt) < Date.now() - 3600_000 ||
            companionVisible(this.owner, d.id, target)
          )
            continue;
          this.enqueue(
            c,
            d,
            payload.notice_id && payload.severity
              ? `notice:${String(payload.notice_id)}:${String(payload.severity)}`
              : `event:${event.id}`,
            notification,
            target,
            new Date(Date.parse(event.createdAt) + 3600_000).toISOString(),
          );
        }
        stageUpdate(c, 'companionDevices', d.id, { eventCursor: events.at(-1)!.id });
        return null;
      },
    });
  }
  effect: EffectHandler = async ({ target }) => {
    let snapshot = this.owner.state.snapshot();
    let job = snapshot.table('companionNotifications').get(target);
    if (!job || job.state !== 'outbox') return { status: 'delivered' };
    const device = this.eligible(snapshot, job);
    const finish = async (state: string, invalidDigest?: string) => {
      await mutateOwnerState(this.owner, {
        kind: 'companion.push.finish',
        payload: { id: target, state },
        prepare: (c) => {
          if (c.snapshot.table('companionNotifications').get(target)?.state === 'outbox')
            stageUpdate(c, 'companionNotifications', target, { state });
          if (
            invalidDigest &&
            c.snapshot.table('companionDevices').get(job!.deviceId)?.pushTokenDigest === invalidDigest
          )
            stageUpdate(c, 'companionDevices', job!.deviceId, { fcmTokenEnc: null });
          return null;
        },
      });
    };
    if (!device) {
      await finish('canceled');
      return { status: 'delivered' };
    }
    if (job.attempts >= 8) {
      await finish('failed');
      return { status: 'delivered' };
    }
    await mutateOwnerState(this.owner, {
      kind: 'companion.push.attempt',
      payload: { id: target },
      prepare: (c) => {
        const current = c.snapshot.table('companionNotifications').get(target);
        if (current?.state === 'outbox')
          stageUpdate(c, 'companionNotifications', target, { attempts: current.attempts + 1 });
        return null;
      },
    });
    const [cold] = await this.ctx.db
      .select({ token: companionDevices.fcmTokenEnc })
      .from(companionDevices)
      .where(eq(companionDevices.id, device.id));
    if (!cold?.token) {
      await finish('canceled');
      return { status: 'delivered' };
    }
    const digest = createHash('sha256').update(cold.token).digest('hex');
    const data: Record<string, string> = {
      notification_id: job.id,
      device_id: job.deviceId,
      kind: job.kind,
      target_id: job.targetId,
    };
    if (job.kind === 'room') {
      const room = await roomJobData(this.ctx.db, this.ctx.keyring, this.rooms, job);
      if (!room) {
        await finish('canceled');
        return { status: 'delivered' };
      }
      Object.assign(data, room);
    } else if (job.kind === 'room_read') {
      Object.assign(data, {
        room_id: job.targetId,
        conversation_key: `room:${job.targetId}`,
        read_at: snapshot.table('agentRoomReads').get([job.targetId, device.userId])?.readAt ?? '',
      });
    } else if (job.kind === 'read') {
      data.event_cursor = String(snapshot.table('companionReads').get([device.userId, job.targetId])?.readCursor ?? 0);
    } else if (job.kind !== 'approval') {
      const source = /^notice:([0-9a-f-]{36}):/.exec(job.sourceKey),
        notice = source ? snapshot.table('agentChatNotices').get(source[1]!) : undefined;
      const eventId = notice?.eventId ?? Number(/^event:(\d+)$/.exec(job.sourceKey)?.[1]);
      const [event] = eventId
        ? await this.ctx.db.select().from(agentEvents).where(eq(agentEvents.id, eventId))
        : [];
      if (
        !event ||
        (event.sessionId !== job.targetId &&
          !snapshot
            .table('hostDaemonPortalBindings')
            .all()
            .some((b) => b.portalSessionId === event.sessionId && b.daemonSessionId === job!.targetId))
      ) {
        await finish('canceled');
        return { status: 'delivered' };
      }
      const payload = decodeSummaryPayload(event.payloadEnc, this.ctx);
      data.summary = eventSummary(event.eventType, payload);
      data.event_cursor = String(event.id);
      const session = snapshot.table('agentSessions').get(event.sessionId);
      Object.assign(
        data,
        agentPushData({
          targetId: job.targetId,
          agentName: session?.launchName ?? null,
          engine: session?.engine ?? null,
          eventId: event.id,
          createdAt: event.createdAt,
          eventType: event.eventType,
          payload,
        }),
      );
      if (notice) {
        data.notice_id = notice.id;
        data.severity = notice.severity;
      }
    }
    // No await remains between authority revalidation and entering the transport.
    snapshot = this.owner.state.snapshot();
    job = snapshot.table('companionNotifications').get(target);
    const fresh = job && this.eligible(snapshot, job);
    if (!job || !fresh || fresh.pushTokenDigest !== digest) {
      await finish('canceled');
      return { status: 'delivered' };
    }
    try {
      const result = await this.transport.send(
        decrypt(cold.token, this.ctx.keyring),
        data,
        Math.floor((Date.parse(job.expiresAt) - Date.now()) / 1000),
        () => {
          this.owner.assertOwner();
          const current = this.owner.state.snapshot();
          const currentJob = current.table('companionNotifications').get(target);
          if (!currentJob || this.eligible(current, currentJob)?.pushTokenDigest !== digest)
            throw new Error('Companion push authority changed');
        },
      );
      await finish(result === 'sent' ? 'sent' : 'canceled', result === 'invalid' ? digest : undefined);
      return { status: 'delivered' };
    } catch (error) {
      if (error instanceof FcmSendError && error.definitelyNotSent)
        return { status: 'retry', afterMs: 30_000 };
      await finish('uncertain');
      return { status: 'uncertain' };
    }
  };
  start(error: (error: unknown) => void) {
    return createOwnerWorker(this.owner, {
      name: 'companion-push',
      tables: TABLES,
      select: (s) => this.obligations(s),
      run: (w) => this.run(w),
      subscribe: (wake) => subscribeAdmissionInterest(this.owner, wake),
      error,
    });
  }
}
export function createCompanionEffectHandlers(ctx: RouteContext): Map<string, EffectHandler> {
  const push = new OwnerCompanionPush(ctx);
  return new Map([['companion.push', push.effect]]);
}
