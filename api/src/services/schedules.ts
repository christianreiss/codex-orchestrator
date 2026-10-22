import { quotaSnapshot, quotaResumeGate } from './quota-observation.js';
import { stopWatchdogLocked } from './watchdog-lifecycle.js';
import { assertNoRebootRecovery } from './reboot-handoffs.js';
import { recoveryDelaySeconds } from './schedules/recovery.js';
import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Database } from '../db/client.js';
import {
  agentWatchdogs,
  agentPrompts,
  agentSchedules,
  agentScheduleRuns,
  agentBusAddresses,
  agentBusMessages,
  agentBusConversations,
  agentSessions,
  hostDaemons,
  hosts,
  versions,
} from '../db/schema.js';
import { daemonResidentFor } from './host-daemon/policy.js';
import type { Keyring } from '../security/keyring.js';
import { encrypt, decrypt } from '../security/secret-box.js';
import { hostAuthFingerprint, safeHashEqual } from './agent-messaging/internals.js';
import { sha256 } from '../security/hash.js';
import { ConflictError, NotFoundError, ForbiddenError, ValidationError } from '../http/errors.js';
import { ENGINE_DISABLED_FLAGS, readFleetEngineState } from './engine-switch.js';
import { isTruthyFlagValue } from './settings.js';
import { activeHostEngines } from './host-engine-policy.js';
import { isEngine } from '../util/engine.js';
import { messagingHostEligible } from './agent-messaging/eligibility.js';
import { SERVER_ADDRESS_ID } from './agent-messaging/groups.js';
import { newQueuedMessage } from './agent-messaging/views.js';
import { receiverReady } from './agent-receiver-state.js';
import { createAdminEventsService } from './admin-events.js';
import { wsPublisher } from '../ws/publisher.js';
import { nextOccurrence, scheduleInput, type ScheduleInput } from './schedules/timing.js';
import { SCHEDULE_TARGET_GRACE_SECONDS, targetIsGone } from './schedules/staleness.js';
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
      max_recovery_attempts: row.maxRecoveryAttempts,
    };
  }
  private view(row: Schedule, reveal = false) {
    const { prompt, ...input } = this.input(row);
    return {
      ...input,
      ...(reveal ? { prompt } : {}),
      id: row.id,
      next_due_at: row.nextDueAt,
      pause_reason: row.pauseReason,
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
      .where(and(isNull(agentSchedules.deletedAt), sql`NOT EXISTS (SELECT 1 FROM agent_watchdogs w WHERE w.schedule_id = ${agentSchedules.id})`, after ? sql`${agentSchedules.id} > ${after}` : undefined))
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
    const messages = runs.some((r) => r.messageId)
      ? await this.db
          .select({
            id: agentBusMessages.id,
            result: agentBusMessages.taskResultStatus,
            status: agentBusMessages.status,
            reason: agentBusMessages.lastErrorCode,
          })
          .from(agentBusMessages)
          .where(
            inArray(
              agentBusMessages.id,
              runs.flatMap((r) => (r.messageId ? [r.messageId] : [])),
            ),
          )
      : [];
    return {
      schedule: this.view(row, true),
      runs: runs.map((r) => ({
        id: r.id,
        due_at: r.dueAt,
        status: r.status,
        message_id: r.messageId,
        persistent: !!r.persistent,
        recovery_count: r.recoveryCount,
        max_recovery_attempts: r.maxRecoveryAttempts,
        warning_at: r.warningAt,
        task_result_status: messages.find((m) => m.id === r.messageId)?.result ?? null,
        transport_status: messages.find((m) => m.id === r.messageId)?.status ?? null,
        delivery_reason: messages.find((m) => m.id === r.messageId)?.reason ?? null,
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
      maxRecoveryAttempts: v.max_recovery_attempts ?? null,
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
      .limit(1).for('update');
    if (v.enabled && v.persistent) await assertNoRebootRecovery(tx, v.target.slice(6).toLowerCase());
    if (!target || !isEngine(target.engine) || target.archivedAt)
      throw new ValidationError('Target must be an existing agent address');
    if (v.persistent && (!target.lastUpstreamSessionId || target.continuity !== 'native'))
      throw new ValidationError('Persistent recovery requires a known native session');
    // Resuming a dormant agent is remote execution: only a persistent host offers it (docs/host-runtime-policy.md).
    if (v.enabled && v.persistent) {
      const [daemon] = await tx.select().from(hostDaemons).where(eq(hostDaemons.hostId, target.hostId)).limit(1);
      if (!daemon || !daemonResidentFor(daemon.settings, target.username))
        throw new ForbiddenError('Persistent schedules need a persistent host; this agent runs on a normal host', 'schedule_host_not_persistent');
    }
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
      const [watchdog] = await tx.select().from(agentWatchdogs).where(eq(agentWatchdogs.scheduleId,id));
      if (watchdog) throw new ForbiddenError('Manage recovery through watchdog tools', 'watchdog_schedule_managed');
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
          pauseReason: v.enabled ? null : row.pauseReason,
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
      const [watchdog] = await tx.select().from(agentWatchdogs).where(eq(agentWatchdogs.scheduleId,id));
      if (watchdog) throw new ForbiddenError('Manage recovery through watchdog tools','watchdog_schedule_managed');
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
    // Only a due schedule or one with an active run can change below; a locked pass over any other schedule was a
    // no-op, ten seconds apart, for every schedule in the fleet.
    const ids = await this.db
      .select({ id: agentSchedules.id })
      .from(agentSchedules)
      .where(and(isNull(agentSchedules.deletedAt), or(
        and(eq(agentSchedules.enabled, 1), lte(agentSchedules.nextDueAt, now.toISOString())),
        sql`EXISTS (SELECT 1 FROM ${agentScheduleRuns} WHERE ${agentScheduleRuns.scheduleId} = ${agentSchedules.id}
          AND ${agentScheduleRuns.status} IN (${sql.join(activeStatuses.map((status) => sql`${status}`), sql`, `)}))`,
      )))
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
              maxRecoveryAttempts: schedule.maxRecoveryAttempts,
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
  /**
   * Retires wake-ups nobody can answer any more, 24 h after their agent is gone
   * (the same grace an agent name stays reserved). A finished one-shot is
   * deleted; a recurring one is paused with `pause_reason = agent_gone`, which
   * the operator can undo with Enable. Persistent schedules are left alone while
   * their agent's address exists: resuming dormant agents is their purpose.
   * Watchdog schedules keep their own lifecycle.
   */
  async sweepStale(now = new Date(), actor = 'system:sweep') {
    const ids = await this.db
      .select({ id: agentSchedules.id })
      .from(agentSchedules)
      .where(and(isNull(agentSchedules.deletedAt), sql`NOT EXISTS (SELECT 1 FROM agent_watchdogs w WHERE w.schedule_id = ${agentSchedules.id})`))
      .orderBy(asc(agentSchedules.id));
    const swept: { id: string; action: 'expired' | 'paused_agent_gone' }[] = [];
    for (const { id } of ids) {
      const action = await this.db.transaction(async (tx) => {
        // Global bus gate precedes the schedule and delivery locks, as in tick().
        if (!(await this.enabled(tx, true))) return null;
        const [schedule] = await tx.select().from(agentSchedules).where(eq(agentSchedules.id, id)).limit(1).for('update');
        if (!schedule || schedule.deletedAt) return null;
        const timestamp = now.toISOString();
        const [target] = await tx.select().from(agentBusAddresses).where(eq(agentBusAddresses.id, schedule.targetAddressId)).limit(1);
        const [session] = target?.currentSessionId
          ? await tx.select({ endedAt: agentSessions.endedAt, bridgeExpiresAt: agentSessions.bridgeExpiresAt }).from(agentSessions).where(eq(agentSessions.id, target.currentSessionId)).limit(1)
          : [];
        const gone = targetIsGone(target, session, now);
        const active = await tx
          .select({ id: agentScheduleRuns.id })
          .from(agentScheduleRuns)
          .where(and(eq(agentScheduleRuns.scheduleId, id), inArray(agentScheduleRuns.status, activeStatuses)))
          .limit(1);
        const retire = (patch: Partial<Schedule>) =>
          tx
            .update(agentSchedules)
            .set({ enabled: 0, ...patch, version: sql`${agentSchedules.version} + 1`, updatedBy: actor, updatedAt: timestamp })
            .where(eq(agentSchedules.id, id));
        if (schedule.kind === 'once' && schedule.nextDueAt === null) {
          // Already fired. Delete once the last run is old enough, or its agent is gone.
          const [last] = await tx.select({ updatedAt: agentScheduleRuns.updatedAt }).from(agentScheduleRuns)
            .where(eq(agentScheduleRuns.scheduleId, id)).orderBy(desc(agentScheduleRuns.updatedAt)).limit(1);
          const finishedAt = active.length ? null : (last?.updatedAt ?? schedule.updatedAt);
          const old = finishedAt !== null && Date.parse(finishedAt) <= now.getTime() - SCHEDULE_TARGET_GRACE_SECONDS * 1000;
          if (!old && !(gone && active.length)) return null;
          await retire({ deletedAt: timestamp });
          await this.cancelWaiting(tx, id, timestamp);
          return 'expired' as const;
        }
        if (!schedule.enabled || !gone) return null;
        if (schedule.persistent && target && !target.archivedAt) return null;
        await retire({ pauseReason: 'agent_gone' });
        await this.cancelWaiting(tx, id, timestamp);
        return 'paused_agent_gone' as const;
      });
      if (action) swept.push({ id, action });
    }
    for (const { id, action } of swept) await this.changed(id, action, actor);
    return swept;
  }
  private async advance(tx: Tx, run: Run, now: Date, enabled: boolean) {
    const timestamp = now.toISOString();
    const [watchdog] = await tx.select().from(agentWatchdogs).where(eq(agentWatchdogs.scheduleId,run.scheduleId));
    if (watchdog) {
      const [target] = await tx.select().from(agentBusAddresses).where(eq(agentBusAddresses.id,run.targetAddressId));
      if (!['watching','recovering','capacity_wait'].includes(watchdog.status) || watchdog.deadlineAt <= timestamp || !target || target.lastUpstreamSessionId !== watchdog.nativeSessionId || target.continuity !== 'native') {
        // Stopping future recovery does not discard the final receipt of accepted work.
        const [message] = run.messageId ? await tx.select().from(agentBusMessages).where(eq(agentBusMessages.id,run.messageId)) : [];
        if (message?.status !== 'accepted') await tx.update(agentScheduleRuns).set({status:message?.status === 'completed' ? 'completed' : 'canceled',updatedAt:timestamp}).where(eq(agentScheduleRuns.id,run.id));
        return;
      }
    }
    const set = (v: Partial<Run>) =>
      tx
        .update(agentScheduleRuns)
        .set({ ...v, updatedAt: timestamp })
        .where(eq(agentScheduleRuns.id, run.id));
    const quotaGate = async () => {
      const q = watchdog?.quotaAccountId ? { account_id: watchdog.quotaAccountId,
        window: watchdog.quotaWindow, reset_at: watchdog.quotaResetAt,
        attempts: watchdog.quotaAttempts, attempt_at: watchdog.quotaAttemptAt,
        native_session_id: watchdog.nativeSessionId } : run.quotaRecovery;
      if (!q) return true;
      const [target] = await tx.select().from(agentBusAddresses).where(eq(agentBusAddresses.id, run.targetAddressId));
      const snapshot = target && isEngine(target.engine) ? await quotaSnapshot(tx, q.account_id, target.engine, now.getTime()) : null;
      const gate = target?.lastUpstreamSessionId === q.native_session_id && target.continuity === 'native'
        ? quotaResumeGate(snapshot, q.window, q.reset_at, q.attempts, q.attempt_at, now.getTime())
        : { stop: 'quota_native_session_changed' };
      if ('stop' in gate) {
        if (watchdog) await stopWatchdogLocked(tx, watchdog, 'blocked', gate.stop!, timestamp);
        await set({ status: 'blocked', lastError: gate.stop });
        wsPublisher.publish('watchdogs.changed', { id: watchdog?.id ?? null, reason: gate.stop });
        return false;
      }
      if ('wait_until' in gate) {
        await set({ status: 'capacity_wait', nextAttemptAt: gate.wait_until, lastError: 'quota_wait' });
        return false;
      }
      if (watchdog) await tx.update(agentWatchdogs).set({ quotaAttempts: q.attempts + 1, quotaAttemptAt: timestamp, updatedAt: timestamp }).where(eq(agentWatchdogs.id, watchdog.id));
      else await set({ quotaRecovery: { ...run.quotaRecovery!, attempts: q.attempts + 1, attempt_at: timestamp } });
      return true;
    };
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
      if (message.status === 'reboot_hold') return;
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
      if (run.maxRecoveryAttempts != null && run.recoveryCount >= run.maxRecoveryAttempts) {
        await tx
          .update(agentSchedules)
          .set({
            enabled: 0,
            pauseReason: 'recovery_limit_reached',
            version: sql`${agentSchedules.version} + 1`,
            updatedAt: timestamp,
          })
          .where(eq(agentSchedules.id, run.scheduleId));
        await set({ status: 'blocked', lastError: 'recovery_limit_reached' });
        return;
      }
      if (run.recoveryCount >= 3 && !run.warningAt) {
        await set({ warningAt: timestamp });
        wsPublisher.publish('schedules.recovery.warning', {
          schedule_id: run.scheduleId,
          run_id: run.id,
          recovery_count: run.recoveryCount,
        });
      }
      if (!['recovering', 'capacity_wait'].includes(run.status)) {
        await set({
          status: message.lastErrorCode === 'schedule_capacity' ? 'capacity_wait' : 'recovering',
          lastError: message.lastErrorCode ?? message.status,
          nextAttemptAt: this.retryAt(
            message.lastErrorEnc,
            recoveryDelaySeconds(run.retrySeconds, run.recoveryCount),
            now,
          ),
        });
        return;
      }
      if (run.nextAttemptAt > timestamp) return;
      if (!(await quotaGate())) return;
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
          // Retain the last accepted Watchdog wake while its next retry is queued.
          acceptedAt: watchdog ? message.acceptedAt : null,
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
    // A schedule created while the host was persistent must not keep firing after the flag is gone: no relay would
    // ever claim it, and recovery would retry forever (docs/host-runtime-policy.md).
    if (run.persistent) {
      const [daemon] = await tx.select().from(hostDaemons).where(eq(hostDaemons.hostId, target.hostId)).limit(1);
      if (!daemon || !daemonResidentFor(daemon.settings, target.username)) {
        await set({ status: 'blocked', lastError: 'schedule_host_not_persistent' });
        return;
      }
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
    if (!(await quotaGate())) return;
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
  /**
   * Polled by every live session (every 5 s). One statement reads the bridge credential, binding, host, fleet flags,
   * the governing schedule, an open prompt and the active persistent run; it used to be six to seven reads. The
   * decisions and response shapes are unchanged.
   */
  async sessionPolicy(sessionId: string, token: string) {
    const flag = (name: string) => sql<string | null>`(SELECT ${versions.version} FROM ${versions} WHERE ${versions.name} = ${name} LIMIT 1)`;
    const watchdogFree = sql`NOT EXISTS (SELECT 1 FROM agent_watchdogs w WHERE w.schedule_id = ${agentSchedules.id})`;
    const [row] = await this.db
      .select({
        session: {
          endedAt: agentSessions.endedAt, bridgeExpiresAt: agentSessions.bridgeExpiresAt,
          bridgeTokenHash: agentSessions.bridgeTokenHash, agentBusAddressId: agentSessions.agentBusAddressId,
          hostAuthFingerprint: agentSessions.hostAuthFingerprint, activeTurnId: agentSessions.activeTurnId,
        },
        address: {
          id: agentBusAddresses.id, enabled: agentBusAddresses.enabled, archivedAt: agentBusAddresses.archivedAt,
          currentSessionId: agentBusAddresses.currentSessionId, engine: agentBusAddresses.engine,
          bindingGeneration: agentBusAddresses.bindingGeneration,
        },
        host: {
          id: hosts.id, status: hosts.status, secure: hosts.secure, insecureEnabledUntil: hosts.insecureEnabledUntil,
          apiKey: hosts.apiKey, apiKeyHash: hosts.apiKeyHash, engines: hosts.engines,
        },
        apiDisabled: flag('api_disabled'),
        messagingEnabled: flag('agent_messaging_enabled'),
        codexDisabled: flag(ENGINE_DISABLED_FLAGS.codex),
        claudeDisabled: flag(ENGINE_DISABLED_FLAGS.claude),
        grokDisabled: flag(ENGINE_DISABLED_FLAGS.grok),
        schedule: sql<unknown>`(SELECT JSON_ARRAY(${agentSchedules.progressTimeoutSeconds}, ${agentSchedules.nextDueAt})
          FROM ${agentSchedules}
          WHERE ${agentSchedules.targetAddressId} = ${agentBusAddresses.id} AND ${agentSchedules.enabled} = 1 AND ${watchdogFree}
            AND ${agentSchedules.persistent} = 1 AND ${agentSchedules.deletedAt} IS NULL
          ORDER BY ${agentSchedules.progressTimeoutSeconds} ASC LIMIT 1)`,
        openPrompt: sql<number>`EXISTS (SELECT 1 FROM ${agentPrompts}
          WHERE ${agentPrompts.sessionId} = ${agentSessions.id} AND ${agentPrompts.status} = 'open')`,
        // An accepted execution retains its snapshot even when future settings change.
        activeRunTimeout: sql<number | null>`(SELECT ${agentScheduleRuns.progressTimeoutSeconds}
          FROM ${agentScheduleRuns}
          INNER JOIN ${agentSchedules} ON ${agentSchedules.id} = ${agentScheduleRuns.scheduleId}
          LEFT JOIN ${agentBusMessages} ON ${agentBusMessages.id} = ${agentScheduleRuns.messageId}
          WHERE ${agentScheduleRuns.targetAddressId} = ${agentBusAddresses.id} AND ${agentScheduleRuns.persistent} = 1
            AND ${agentScheduleRuns.status} IN (${sql.join(activeStatuses.map((status) => sql`${status}`), sql`, `)})
            AND (${agentSessions.activeTurnId} IS NOT NULL OR ${agentBusMessages.status} = 'accepted')
            AND ${agentSchedules.enabled} = 1 AND ${watchdogFree} AND ${agentSchedules.deletedAt} IS NULL
          ORDER BY ${agentScheduleRuns.progressTimeoutSeconds} ASC LIMIT 1)`,
      })
      .from(agentSessions)
      .leftJoin(agentBusAddresses, eq(agentBusAddresses.id, agentSessions.agentBusAddressId))
      .leftJoin(hosts, eq(hosts.id, agentSessions.hostId))
      .where(eq(agentSessions.id, sessionId))
      .limit(1);
    const session = row?.session;
    if (
      !session ||
      session.endedAt ||
      session.bridgeExpiresAt <= new Date().toISOString() ||
      !safeHashEqual(session.bridgeTokenHash, sha256(token))
    )
      throw new ForbiddenError('Invalid session bridge', 'schedule_bridge_invalid');
    const address = session.agentBusAddressId ? row.address : null;
    if (
      !address?.id ||
      !address.enabled ||
      address.archivedAt ||
      address.currentSessionId !== sessionId ||
      row.apiDisabled === '1' ||
      row.messagingEnabled !== '1'
    )
      return { progress_timeout_seconds: null };
    const host = row.host;
    const fleet = {
      codex: !isTruthyFlagValue(row.codexDisabled),
      claude: !isTruthyFlagValue(row.claudeDisabled),
      grok: !isTruthyFlagValue(row.grokDisabled),
    };
    if (
      !host?.id ||
      session.hostAuthFingerprint !== hostAuthFingerprint(host) ||
      !messagingHostEligible(host) ||
      !isEngine(address.engine) ||
      !activeHostEngines(host.engines, fleet).includes(address.engine)
    )
      return { progress_timeout_seconds: null };
    const schedule = row.schedule == null ? null : ((typeof row.schedule === 'string' ? JSON.parse(row.schedule) : row.schedule) as [number | null, string | null]);
    const activeRun = row.activeRunTimeout == null ? null : Number(row.activeRunTimeout);
    const timeout = activeRun ?? (session.activeTurnId && schedule?.[1] ? schedule[0] : null);
    return {
      progress_timeout_seconds: Number(row.openPrompt) ? null : timeout,
      binding_generation: address.bindingGeneration,
    };
  }
}
