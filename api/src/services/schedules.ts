import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Database } from '../db/client.js';
import {
  agentPrompts,
  agentSchedules,
  agentScheduleRuns,
  agentBusAddresses,
  agentBusMessages,
  agentBusConversations,
  agentSessions,
  hosts,
  versions,
} from '../db/schema.js';
import type { Keyring } from '../security/keyring.js';
import { encrypt, decrypt } from '../security/secret-box.js';
import { hostAuthFingerprint, safeHashEqual } from './agent-messaging/internals.js';
import { sha256 } from '../security/hash.js';
import { ConflictError, NotFoundError, ForbiddenError, ValidationError } from '../http/errors.js';
import { readFleetEngineState } from './engine-switch.js';
import { activeHostEngines } from './host-engine-policy.js';
import { isEngine } from '../util/engine.js';
import { messagingHostEligible } from './agent-messaging/eligibility.js';
import { SERVER_ADDRESS_ID } from './agent-messaging/groups.js';
import { newQueuedMessage } from './agent-messaging/views.js';
import { receiverReady } from './agent-receiver-state.js';
import { createAdminEventsService } from './admin-events.js';
import { wsPublisher } from '../ws/publisher.js';
import { nextOccurrence, scheduleInput, type ScheduleInput } from './schedules/timing.js';
export { scheduleInput } from './schedules/timing.js';

type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];
type Schedule = typeof agentSchedules.$inferSelect;
type Run = typeof agentScheduleRuns.$inferSelect;
const activeStatuses = ['waiting', 'queued', 'leased', 'accepted', 'recovering', 'capacity_wait'];

export class SchedulesService {
  constructor(
    private readonly db: Database,
    private readonly keyring: Keyring,
  ) {}
  private decode(value: string) {
    return decrypt(value, this.keyring);
  }
  private input(row: Schedule): ScheduleInput {
    return {
      name: row.name,
      target: `agent:${row.targetAddressId}`,
      prompt: this.decode(row.promptEnc),
      kind: row.kind as ScheduleInput['kind'],
      at: row.atTime,
      cron: row.cronExpression,
      interval_minutes: row.intervalMinutes,
      timezone: row.timezone,
      enabled: !!row.enabled,
      persistent: !!row.persistent,
      progress_timeout_seconds: row.progressTimeoutSeconds,
    };
  }
  private view(row: Schedule, reveal = false) {
    const { prompt, ...input } = this.input(row);
    return {
      ...input,
      ...(reveal ? { prompt } : {}),
      id: row.id,
      next_due_at: row.nextDueAt,
      version: row.version,
      created_by: row.createdBy,
      updated_by: row.updatedBy,
      created_at: row.createdAt,
      updated_at: row.updatedAt,
    };
  }
  async list(args: Record<string, unknown> = {}) {
    const { limit, after } = z
      .object({
        limit: z.coerce.number().int().min(1).max(200).default(100),
        after: z.string().uuid().optional(),
      })
      .strict()
      .parse(args);
    const rows = await this.db
      .select()
      .from(agentSchedules)
      .where(and(isNull(agentSchedules.deletedAt), after ? sql`${agentSchedules.id} > ${after}` : undefined))
      .orderBy(asc(agentSchedules.id))
      .limit(limit + 1);
    return {
      schedules: rows.slice(0, limit).map((r) => this.view(r)),
      next_cursor: rows.length > limit ? rows[limit - 1]!.id : null,
    };
  }
  private async load(db: Pick<Database, 'select'>, id: string, lock = false) {
    const query = db
      .select()
      .from(agentSchedules)
      .where(and(eq(agentSchedules.id, id), isNull(agentSchedules.deletedAt)))
      .limit(1);
    const rows = lock ? await query.for('update') : await query;
    if (!rows[0]) throw new NotFoundError('Schedule not found', 'schedule_not_found');
    return rows[0];
  }
  async get(raw: unknown) {
    const id = z.string().uuid().parse(raw),
      row = await this.load(this.db, id);
    const runs = await this.db
      .select()
      .from(agentScheduleRuns)
      .where(eq(agentScheduleRuns.scheduleId, id))
      .orderBy(desc(agentScheduleRuns.createdAt))
      .limit(100);
    return {
      schedule: this.view(row, true),
      runs: runs.map((r) => ({
        id: r.id,
        due_at: r.dueAt,
        status: r.status,
        message_id: r.messageId,
        persistent: !!r.persistent,
        recovery_count: r.recoveryCount,
        next_attempt_at: r.nextAttemptAt,
        last_error: r.lastError,
        updated_at: r.updatedAt,
      })),
    };
  }
  private values(v: ScheduleInput) {
    return {
      name: v.name,
      targetAddressId: v.target.slice(6).toLowerCase(),
      promptEnc: encrypt(v.prompt, this.keyring),
      kind: v.kind,
      atTime: v.at ? new Date(v.at).toISOString() : null,
      cronExpression: v.cron ?? null,
      intervalMinutes: v.interval_minutes ?? null,
      timezone: v.timezone,
      enabled: Number(v.enabled),
      persistent: Number(v.persistent),
      progressTimeoutSeconds: v.progress_timeout_seconds ?? null,
    };
  }
  private first(v: ScheduleInput, now: Date) {
    if (v.kind !== 'once') return nextOccurrence(v, now);
    if (new Date(v.at!).getTime() <= now.getTime())
      throw new ValidationError('Wake time must be in the future');
    return new Date(v.at!).toISOString();
  }
  private async validateTarget(tx: Tx, v: ScheduleInput) {
    const [target] = await tx
      .select()
      .from(agentBusAddresses)
      .where(eq(agentBusAddresses.id, v.target.slice(6).toLowerCase()))
      .limit(1);
    if (!target || !isEngine(target.engine) || target.archivedAt)
      throw new ValidationError('Target must be an existing agent address');
    if (v.persistent && (!target.lastUpstreamSessionId || target.continuity !== 'native'))
      throw new ValidationError('Persistent recovery requires a known native session');
  }
  async create(raw: unknown, actor: string) {
    const v = scheduleInput.parse(raw),
      now = new Date(),
      id = randomUUID(),
      next = this.first(v, now);
    await this.db.transaction(async (tx) => {
      await this.enabled(tx, true);
      await this.validateTarget(tx, v);
      await tx.insert(agentSchedules).values({
        id,
        ...this.values(v),
        nextDueAt: next,
        createdBy: actor,
        updatedBy: actor,
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
      });
    });
    await this.changed(id, 'created', actor);
    return this.get(id);
  }
  async update(raw: Record<string, unknown>, actor: string) {
    const id = z.string().uuid().parse(raw.id),
      version = z.number().int().positive().parse(raw.version),
      now = new Date();
    const patch = { ...raw };
    delete patch.id;
    delete patch.version;
    await this.db.transaction(async (tx) => {
      await this.enabled(tx, true);
      const row = await this.load(tx, id, true);
      if (row.version !== version)
        throw new ConflictError('Schedule changed; retrieve again', 'schedule_version_conflict');
      const v = scheduleInput.parse({ ...this.input(row), ...patch });
      await this.validateTarget(tx, v);
      const timingChanged = ['kind', 'at', 'cron', 'interval_minutes', 'timezone'].some((k) => k in patch);
      const next = timingChanged || (v.enabled && !row.enabled) ? this.first(v, now) : row.nextDueAt;
      await tx
        .update(agentSchedules)
        .set({
          ...this.values(v),
          nextDueAt: next,
          version: version + 1,
          updatedBy: actor,
          updatedAt: now.toISOString(),
        })
        .where(eq(agentSchedules.id, id));
      if (!v.enabled) await this.cancelWaiting(tx, id, now.toISOString());
    });
    await this.changed(id, 'updated', actor);
    return this.get(id);
  }
  async remove(raw: Record<string, unknown>, actor: string) {
    const { id, version } = z
        .object({ id: z.string().uuid(), version: z.number().int().positive() })
        .strict()
        .parse(raw),
      now = new Date().toISOString();
    await this.db.transaction(async (tx) => {
      await this.enabled(tx, true);
      const row = await this.load(tx, id, true);
      if (row.version !== version)
        throw new ConflictError('Schedule changed; retrieve again', 'schedule_version_conflict');
      await tx
        .update(agentSchedules)
        .set({ enabled: 0, deletedAt: now, version: version + 1, updatedBy: actor, updatedAt: now })
        .where(eq(agentSchedules.id, id));
      await this.cancelWaiting(tx, id, now);
    });
    await this.changed(id, 'deleted', actor);
    return { id, deleted: true };
  }
  private async cancelWaiting(tx: Tx, id: string, now: string) {
    const runs = await tx
      .select()
      .from(agentScheduleRuns)
      .where(and(eq(agentScheduleRuns.scheduleId, id), inArray(agentScheduleRuns.status, activeStatuses)))
      .for('update');
    for (const run of runs) {
      if (run.messageId) {
        const [message] = await tx
          .select()
          .from(agentBusMessages)
          .where(eq(agentBusMessages.id, run.messageId))
          .limit(1)
          .for('update');
        if (message?.status === 'accepted') continue;
        if (message && ['queued', 'leased'].includes(message.status))
          await tx
            .update(agentBusMessages)
            .set({ status: 'canceled', canceledAt: now, leaseOwner: null, leaseUntil: null, updatedAt: now })
            .where(eq(agentBusMessages.id, message.id));
      }
      await tx
        .update(agentScheduleRuns)
        .set({ status: 'canceled', updatedAt: now })
        .where(eq(agentScheduleRuns.id, run.id));
    }
  }
  private async changed(id: string, action: string, actor: string) {
    await createAdminEventsService(this.db).record(
      { type: `schedule.${action}`, payload: { schedule_id: id, actor } },
      { broadcast: false },
    );
    wsPublisher.publish('schedules.changed', { schedule_id: id });
  }
  private async enabled(db: Pick<Database, 'select'>, lock = false) {
    const q = db
      .select()
      .from(versions)
      .where(inArray(versions.name, ['api_disabled', 'agent_messaging_enabled']))
      .orderBy(asc(versions.name));
    const flags = lock ? await q.for('update') : await q;
    return (
      !flags.some((f) => f.name === 'api_disabled' && f.version === '1') &&
      flags.some((f) => f.name === 'agent_messaging_enabled' && f.version === '1')
    );
  }
  async tick(now = new Date()) {
    const ids = await this.db
      .select({ id: agentSchedules.id })
      .from(agentSchedules)
      .where(isNull(agentSchedules.deletedAt))
      .orderBy(asc(agentSchedules.id));
    let changed = false;
    for (const { id } of ids)
      changed =
        (await this.db.transaction(async (tx) => {
          // Global bus gate precedes the schedule and delivery locks.
          if (!(await this.enabled(tx, true))) return false;
          const [schedule] = await tx
            .select()
            .from(agentSchedules)
            .where(eq(agentSchedules.id, id))
            .limit(1)
            .for('update');
          if (!schedule || schedule.deletedAt) return false;
          const timestamp = now.toISOString();
          const runs = await tx
            .select()
            .from(agentScheduleRuns)
            .where(
              and(eq(agentScheduleRuns.scheduleId, id), inArray(agentScheduleRuns.status, activeStatuses)),
            )
            .orderBy(asc(agentScheduleRuns.createdAt))
            .for('update');
          if (schedule.enabled && !runs.length && schedule.nextDueAt && schedule.nextDueAt <= timestamp) {
            const runId = randomUUID();
            await tx.insert(agentScheduleRuns).values({
              id: runId,
              scheduleId: id,
              targetAddressId: schedule.targetAddressId,
              promptEnc: schedule.promptEnc,
              persistent: schedule.persistent,
              progressTimeoutSeconds: schedule.progressTimeoutSeconds,
              retrySeconds: (schedule.intervalMinutes ?? 5) * 60,
              dueAt: schedule.nextDueAt,
              nextAttemptAt: timestamp,
              createdAt: timestamp,
              updatedAt: timestamp,
            });
            const [run] = await tx.select().from(agentScheduleRuns).where(eq(agentScheduleRuns.id, runId));
            runs.push(run!);
            await tx
              .update(agentSchedules)
              .set({ nextDueAt: nextOccurrence(this.input(schedule), now), updatedAt: timestamp })
              .where(eq(agentSchedules.id, id));
          }
          for (const run of runs) await this.advance(tx, run, now, !!schedule.enabled);
          return runs.length > 0;
        })) || changed;
    if (changed) wsPublisher.publish('schedules.changed', {});
  }
  private async advance(tx: Tx, run: Run, now: Date, enabled: boolean) {
    const timestamp = now.toISOString();
    const set = (v: Partial<Run>) =>
      tx
        .update(agentScheduleRuns)
        .set({ ...v, updatedAt: timestamp })
        .where(eq(agentScheduleRuns.id, run.id));
    if (run.messageId) {
      const [message] = await tx
        .select()
        .from(agentBusMessages)
        .where(eq(agentBusMessages.id, run.messageId))
        .limit(1)
        .for('update');
      if (!message) {
        await set({ status: 'blocked', lastError: 'delivery_missing' });
        return;
      }
      if (['queued', 'leased', 'accepted', 'completed', 'canceled'].includes(message.status)) {
        await set({ status: message.status });
        return;
      }
      if (!enabled || !run.persistent || message.lastErrorCode === 'schedule_transcript_missing') {
        await set({
          status: enabled
            ? message.lastErrorCode === 'schedule_transcript_missing'
              ? 'blocked'
              : message.status
            : 'canceled',
          lastError: message.lastErrorCode,
        });
        return;
      }
      if (!['recovering', 'capacity_wait'].includes(run.status)) {
        await set({
          status: message.lastErrorCode === 'schedule_capacity' ? 'capacity_wait' : 'recovering',
          lastError: message.lastErrorCode ?? message.status,
          nextAttemptAt: this.retryAt(message.lastErrorEnc, run.retrySeconds, now),
        });
        return;
      }
      if (run.nextAttemptAt > timestamp) return;
      // Explicit opt-in recovery after an ambiguous crash may repeat effects.
      await tx
        .update(agentBusMessages)
        .set({
          status: 'queued',
          attempts: 0,
          nextAttemptAt: timestamp,
          leaseOwner: null,
          leaseUntil: null,
          claimId: null,
          relayGeneration: null,
          acceptedAt: null,
          updatedAt: timestamp,
        })
        .where(eq(agentBusMessages.id, message.id));
      await set({ status: 'queued', recoveryCount: run.recoveryCount + 1 });
      return;
    }
    if (!enabled) {
      await set({ status: 'canceled' });
      return;
    }
    const [target] = await tx
      .select()
      .from(agentBusAddresses)
      .where(eq(agentBusAddresses.id, run.targetAddressId))
      .limit(1)
      .for('update');
    const [host] = target ? await tx.select().from(hosts).where(eq(hosts.id, target.hostId)).limit(1) : [];
    const fleet = await readFleetEngineState(tx, { fresh: true });
    if (
      !target ||
      !host ||
      !target.enabled ||
      target.archivedAt ||
      !isEngine(target.engine) ||
      !messagingHostEligible(host) ||
      !activeHostEngines(host.engines, fleet).includes(target.engine)
    )
      return;
    if (run.persistent && (!target.lastUpstreamSessionId || target.continuity !== 'native')) {
      await set({ status: 'blocked', lastError: 'native_session_missing' });
      return;
    }
    if (!run.persistent) {
      if (!target.currentSessionId) return;
      const [session] = await tx
        .select()
        .from(agentSessions)
        .where(eq(agentSessions.id, target.currentSessionId))
        .limit(1);
      if (!session || !receiverReady(session.receiver, 'peer', now.getTime())) return;
    }
    let [sender] = await tx
      .select()
      .from(agentBusAddresses)
      .where(eq(agentBusAddresses.id, SERVER_ADDRESS_ID))
      .limit(1);
    if (!sender) {
      await tx.insert(agentBusAddresses).values({
        id: SERVER_ADDRESS_ID,
        address: `agent:${SERVER_ADDRESS_ID}`,
        hostId: 0,
        engine: 'server',
        username: 'Server',
        cwd: '/',
        cwdHash: sha256('/'),
        continuity: 'server',
        readiness: 'offline',
        lastSeenAt: timestamp,
        createdAt: timestamp,
        updatedAt: timestamp,
      });
      [sender] = await tx.select().from(agentBusAddresses).where(eq(agentBusAddresses.id, SERVER_ADDRESS_ID));
    }
    if (sender!.engine !== 'server' || sender!.hostId !== 0 || !sender!.enabled || sender!.archivedAt)
      throw new ConflictError('Reserved server identity conflicts', 'schedule_server_identity_conflict');
    const conversationId = randomUUID(),
      messageId = randomUUID(),
      content = this.decode(run.promptEnc);
    await tx.insert(agentBusConversations).values({
      id: conversationId,
      addressAId: sender!.id,
      addressBId: target.id,
      createdByAddressId: sender!.id,
      nextSequence: 2,
      lastActivityAt: timestamp,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    await tx.insert(agentBusMessages).values(
      newQueuedMessage({
        id: messageId,
        conversationId,
        sequence: 1,
        sender: sender!,
        senderSessionId: null,
        target,
        kind: 'schedule',
        content,
        contentEnc: run.promptEnc,
        clientMessageId: run.id,
        expiresAt: '9999-12-31T00:00:00.000Z',
        now: timestamp,
      }),
    );
    await set({ messageId, status: 'queued' });
  }
  private retryAt(error: string | null, seconds: number, now: Date) {
    let next = now.getTime() + seconds * 1000;
    if (error) {
      const marker = this.decode(error).match(/^retry_not_before=(.+)$/);
      const reset = marker ? Date.parse(marker[1]!) : NaN;
      if (Number.isFinite(reset)) next = Math.max(next, reset);
    }
    return new Date(next).toISOString();
  }
  async sessionPolicy(sessionId: string, token: string) {
    const [session] = await this.db
      .select()
      .from(agentSessions)
      .where(eq(agentSessions.id, sessionId))
      .limit(1);
    if (
      !session ||
      session.endedAt ||
      session.bridgeExpiresAt <= new Date().toISOString() ||
      !safeHashEqual(session.bridgeTokenHash, sha256(token))
    )
      throw new ForbiddenError('Invalid session bridge', 'schedule_bridge_invalid');
    const [address] = session.agentBusAddressId
      ? await this.db
          .select()
          .from(agentBusAddresses)
          .where(eq(agentBusAddresses.id, session.agentBusAddressId))
          .limit(1)
      : [];
    if (
      !address ||
      !address.enabled ||
      address.archivedAt ||
      address.currentSessionId !== sessionId ||
      !(await this.enabled(this.db))
    )
      return { progress_timeout_seconds: null };
    const [host] = await this.db.select().from(hosts).where(eq(hosts.id, session.hostId));
    if (
      !host ||
      session.hostAuthFingerprint !== hostAuthFingerprint(host) ||
      !messagingHostEligible(host) ||
      !isEngine(address.engine) ||
      !activeHostEngines(host.engines, await readFleetEngineState(this.db)).includes(address.engine)
    )
      return { progress_timeout_seconds: null };
    const [row] = await this.db
      .select()
      .from(agentSchedules)
      .where(
        and(
          eq(agentSchedules.targetAddressId, address.id),
          eq(agentSchedules.enabled, 1),
          eq(agentSchedules.persistent, 1),
          isNull(agentSchedules.deletedAt),
        ),
      )
      .orderBy(asc(agentSchedules.progressTimeoutSeconds))
      .limit(1);
    const [prompt] = await this.db
      .select({ id: agentPrompts.id })
      .from(agentPrompts)
      .where(and(eq(agentPrompts.sessionId, sessionId), eq(agentPrompts.status, 'open')))
      .limit(1);
    const [activeRun] = await this.db
      .select({ timeout: agentScheduleRuns.progressTimeoutSeconds })
      .from(agentScheduleRuns)
      .innerJoin(agentSchedules, eq(agentSchedules.id, agentScheduleRuns.scheduleId))
      .leftJoin(agentBusMessages, eq(agentBusMessages.id, agentScheduleRuns.messageId))
      .where(
        and(
          eq(agentScheduleRuns.targetAddressId, address.id),
          eq(agentScheduleRuns.persistent, 1),
          inArray(agentScheduleRuns.status, activeStatuses),
          session.activeTurnId ? undefined : eq(agentBusMessages.status, 'accepted'),
          eq(agentSchedules.enabled, 1),
          isNull(agentSchedules.deletedAt),
        ),
      )
      .orderBy(asc(agentScheduleRuns.progressTimeoutSeconds))
      .limit(1);
    // An accepted execution retains its snapshot even when future settings change.
    const timeout =
      activeRun?.timeout ?? (session.activeTurnId && row?.nextDueAt ? row.progressTimeoutSeconds : null);
    return {
      progress_timeout_seconds: prompt ? null : timeout,
      binding_generation: address.bindingGeneration,
    };
  }
}
