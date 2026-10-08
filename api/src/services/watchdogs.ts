import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Database } from '../db/client.js';
import type { Keyring } from '../security/keyring.js';
import {
  agentWatchdogs,
  agentSchedules,
  agentScheduleRuns,
  agentSessions,
  agentBusAddresses,
  agentBusMessages,
  agentPrompts,
  hosts,
  versions,
} from '../db/schema.js';
import { encrypt } from '../security/secret-box.js';
import { sha256 } from '../security/hash.js';
import { safeHashEqual, hostAuthFingerprint } from './agent-messaging/internals.js';
import { messagingHostEligible } from './agent-messaging/eligibility.js';
import { activeHostEngines } from './host-engine-policy.js';
import { readFleetEngineState } from './engine-switch.js';
import { isEngine } from '../util/engine.js';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../http/errors.js';
import { wsPublisher } from '../ws/publisher.js';
import { createAdminEventsService } from './admin-events.js';

type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];
type Watchdog = typeof agentWatchdogs.$inferSelect;
export const WATCHDOG_LIVE = ['watching', 'recovering', 'capacity_wait'];
export const watchdogEnableInput = z
  .object({
    target: z.string().regex(/^agent:[0-9a-f-]{36}$/i),
    task_key: z
      .string()
      .trim()
      .min(1)
      .max(255)
      .refine((v) => Buffer.byteLength(v) <= 255),
    continuation: z
      .string()
      .trim()
      .min(1)
      .refine((v) => Buffer.byteLength(v) <= 30000),
    duration_seconds: z.number().int().min(60).max(604800).default(7200),
    progress_timeout_seconds: z.number().int().min(60).max(604800).default(600),
    version: z.number().int().positive().optional(),
  })
  .strict();
export function watchdogRetryTime(now: Date, providerHint?: string) {
  const hint = providerHint ? Date.parse(providerHint) : NaN;
  return new Date(
    Math.max(now.getTime() + 300000 * (1 + Math.random() * 0.2), Number.isFinite(hint) ? hint : 0),
  ).toISOString();
}
export class WatchdogsService {
  constructor(
    private readonly db: Database,
    private readonly keyring: Keyring,
  ) {}
  async bridge(id: string, token: string) {
    const [session] = await this.db.select().from(agentSessions).where(eq(agentSessions.id, id));
    if (
      !session ||
      session.endedAt ||
      session.bridgeExpiresAt <= new Date().toISOString() ||
      !safeHashEqual(session.bridgeTokenHash, sha256(token))
    )
      throw new ForbiddenError('Invalid watchdog bridge', 'watchdog_bridge_invalid');
    const target = await this.eligible(this.db, session.agentBusAddressId ?? '', session.hostAuthFingerprint);
    if (
      target.currentSessionId !== session.id ||
      target.lastUpstreamSessionId !== session.upstreamSessionId ||
      target.bindingGeneration !== session.bindingGeneration
    )
      throw new ForbiddenError('Watchdog binding changed', 'watchdog_binding_stale');
    return session;
  }
  private async eligible(db: Pick<Database, 'select'>, id: string, fingerprint?: string) {
    const [target] = await db.select().from(agentBusAddresses).where(eq(agentBusAddresses.id, id));
    const [host] = target ? await db.select().from(hosts).where(eq(hosts.id, target.hostId)) : [];
    const flags = await db
      .select()
      .from(versions)
      .where(inArray(versions.name, ['api_disabled', 'agent_messaging_enabled']));
    if (
      !target ||
      !host ||
      !target.enabled ||
      target.archivedAt ||
      !isEngine(target.engine) ||
      !messagingHostEligible(host) ||
      (fingerprint && fingerprint !== hostAuthFingerprint(host)) ||
      !activeHostEngines(host.engines, await readFleetEngineState(db, { fresh: true })).includes(
        target.engine,
      ) ||
      flags.some((f) => f.name === 'api_disabled' && f.version === '1') ||
      !flags.some((f) => f.name === 'agent_messaging_enabled' && f.version === '1')
    )
      throw new ForbiddenError('Watchdog target is unavailable', 'watchdog_target_unavailable');
    return target;
  }
  private async load(db: Pick<Database, 'select'>, id: string, lock = false) {
    const q = db
      .select()
      .from(agentWatchdogs)
      .where(eq(agentWatchdogs.id, z.string().uuid().parse(id)));
    const [row] = lock ? await q.for('update') : await q;
    if (!row) throw new NotFoundError('Watchdog not found', 'watchdog_not_found');
    return row;
  }
  async get(id: string) {
    const row = await this.load(this.db, id);
    const [run] = await this.db
      .select()
      .from(agentScheduleRuns)
      .where(eq(agentScheduleRuns.scheduleId, row.scheduleId))
      .orderBy(desc(agentScheduleRuns.createdAt))
      .limit(1);
    const [schedule] = await this.db
      .select()
      .from(agentSchedules)
      .where(eq(agentSchedules.id, row.scheduleId));
    const [message] = run?.messageId
      ? await this.db
          .select({ acceptedAt: agentBusMessages.acceptedAt })
          .from(agentBusMessages)
          .where(eq(agentBusMessages.id, run.messageId))
      : [];
    return {
      id: row.id,
      target: `agent:${row.targetAddressId}`,
      native_session_id: row.nativeSessionId,
      task_key: row.taskKey,
      status:
        WATCHDOG_LIVE.includes(row.status) && run?.status === 'capacity_wait' ? 'capacity_wait' : row.status,
      version: row.version,
      deadline_at: row.deadlineAt,
      progress_timeout_seconds: row.progressTimeoutSeconds,
      last_progress_at: row.lastProgressAt,
      last_error: WATCHDOG_LIVE.includes(row.status)
        ? (run?.lastError ?? row.lastError ?? null)
        : row.lastError,
      last_wake_at: message?.acceptedAt ?? null,
      next_wake_at: WATCHDOG_LIVE.includes(row.status)
        ? run && ['recovering', 'capacity_wait', 'waiting', 'queued', 'leased'].includes(run.status)
          ? run.nextAttemptAt
          : (schedule?.nextDueAt ?? null)
        : null,
      recovery_count: run ? run.recoveryCount + 1 : 0,
      recovery_status: run?.status ?? null,
      server_time: new Date().toISOString(),
      created_by: row.createdBy,
    };
  }
  async forSession(id: string) {
    const [session] = await this.db.select().from(agentSessions).where(eq(agentSessions.id, id));
    if (!session?.agentBusAddressId || !session.upstreamSessionId) return null;
    const [row] = await this.db
      .select()
      .from(agentWatchdogs)
      .where(
        and(
          eq(agentWatchdogs.targetAddressId, session.agentBusAddressId),
          eq(agentWatchdogs.nativeSessionId, session.upstreamSessionId),
        ),
      )
      .orderBy(desc(agentWatchdogs.createdAt))
      .limit(1);
    return row ? this.get(row.id) : null;
  }
  async list(target?: string) {
    const rows = await this.db
      .select({ id: agentWatchdogs.id })
      .from(agentWatchdogs)
      .where(
        target
          ? eq(
              agentWatchdogs.targetAddressId,
              z
                .string()
                .regex(/^agent:[0-9a-f-]{36}$/i)
                .parse(target)
                .slice(6),
            )
          : undefined,
      )
      .orderBy(desc(agentWatchdogs.createdAt))
      .limit(200);
    return { watchdogs: await Promise.all(rows.map((r) => this.get(r.id))) };
  }
  async enable(raw: unknown, actor: string, ownSessionId?: string) {
    const v = watchdogEnableInput.parse(raw),
      now = new Date().toISOString();
    let id = '';
    await this.db.transaction(async (tx) => {
      const [target] = await tx
        .select()
        .from(agentBusAddresses)
        .where(eq(agentBusAddresses.id, v.target.slice(6).toLowerCase()))
        .for('update');
      if (!target) throw new NotFoundError('Agent not found');
      await this.eligible(tx, target.id);
      if (!target.lastUpstreamSessionId || target.continuity !== 'native' || !target.currentSessionId)
        throw new ValidationError('A current native session is required');
      if (ownSessionId && target.currentSessionId !== ownSessionId)
        throw new ForbiddenError('AI tools may enable only their own current task', 'watchdog_own_task_only');
      const [session] = await tx
        .select()
        .from(agentSessions)
        .where(eq(agentSessions.id, target.currentSessionId));
      if (
        !session ||
        session.endedAt ||
        session.hostAuthFingerprint !==
          hostAuthFingerprint((await tx.select().from(hosts).where(eq(hosts.id, target.hostId)))[0]!)
      )
        throw new ValidationError('Current session is unavailable');
      if ((session.adapterCapabilities as Record<string, unknown> | null)?.watchdog_protocol_version !== 1)
        throw new ConflictError('Watchdog requires wrapper 0.9.36 or later', 'adapter_upgrade_required');
      if (
        session.upstreamSessionId !== target.lastUpstreamSessionId ||
        session.bindingGeneration !== target.bindingGeneration
      )
        throw new ConflictError('Native binding changed', 'watchdog_binding_stale');
      const key = and(
        eq(agentWatchdogs.targetAddressId, target.id),
        eq(agentWatchdogs.nativeSessionId, target.lastUpstreamSessionId),
        eq(agentWatchdogs.taskKey, v.task_key),
      );
      const [old] = await tx.select().from(agentWatchdogs).where(key).for('update');
      const digest = sha256(JSON.stringify([v.continuation, v.duration_seconds, v.progress_timeout_seconds]));
      if (old) {
        if (
          old.continuationSha === digest &&
          WATCHDOG_LIVE.includes(old.status) &&
          (!v.version || old.version === v.version || old.version === v.version + 1)
        ) {
          id = old.id;
          return;
        }
        // A terminal record is never silently revived by replaying an enable call.
        if (!WATCHDOG_LIVE.includes(old.status) || old.version !== v.version)
          throw new ConflictError(
            'Watchdog changed; use a new task key or retrieve its version',
            'watchdog_version_conflict',
          );
        await tx
          .update(agentWatchdogs)
          .set({
            progressTimeoutSeconds: v.progress_timeout_seconds,
            deadlineAt: new Date(Date.now() + v.duration_seconds * 1000).toISOString(),
            continuationSha: digest,
            version: old.version + 1,
            updatedAt: now,
          })
          .where(eq(agentWatchdogs.id, old.id));
        await tx
          .update(agentSchedules)
          .set({
            promptEnc: encrypt(this.continuation(old.id, v.task_key, v.continuation), this.keyring),
            progressTimeoutSeconds: v.progress_timeout_seconds,
            updatedAt: now,
          })
          .where(eq(agentSchedules.id, old.scheduleId));
        id = old.id;
        return;
      }
      const [live] = await tx
        .select()
        .from(agentWatchdogs)
        .where(
          and(eq(agentWatchdogs.targetAddressId, target.id), inArray(agentWatchdogs.status, WATCHDOG_LIVE)),
        )
        .limit(1);
      if (live) throw new ConflictError('Agent already has an active watchdog', 'watchdog_already_active');
      const [message] = await tx
        .select()
        .from(agentBusMessages)
        .where(
          and(
            eq(agentBusMessages.targetAddressId, target.id),
            eq(agentBusMessages.deliverySessionId, session.id),
            eq(agentBusMessages.status, 'accepted'),
          ),
        )
        .orderBy(desc(agentBusMessages.acceptedAt))
        .limit(1);
      id = randomUUID();
      const scheduleId = randomUUID();
      await tx.insert(agentSchedules).values({
        id: scheduleId,
        name: `Watchdog ${v.task_key}`.slice(0, 120),
        targetAddressId: target.id,
        promptEnc: encrypt(this.continuation(id, v.task_key, v.continuation), this.keyring),
        kind: 'once',
        timezone: 'Europe/Berlin',
        persistent: 1,
        progressTimeoutSeconds: v.progress_timeout_seconds,
        nextDueAt: null,
        createdBy: actor,
        updatedBy: actor,
        createdAt: now,
        updatedAt: now,
      });
      await tx.insert(agentWatchdogs).values({
        id,
        targetAddressId: target.id,
        nativeSessionId: target.lastUpstreamSessionId,
        sessionId: session.id,
        taskKey: v.task_key,
        messageId: message?.id ?? null,
        scheduleId,
        continuationSha: digest,
        deadlineAt: new Date(Date.now() + v.duration_seconds * 1000).toISOString(),
        progressTimeoutSeconds: v.progress_timeout_seconds,
        lastProgressAt: now,
        createdBy: actor,
        createdAt: now,
        updatedAt: now,
      });
    });
    await this.changed(id, 'enabled', actor);
    return this.get(id);
  }
  private continuation(id: string, task: string, content: string) {
    return `Watchdog recovery for task ${task}. Continue only the existing authorized task. When the task ends, call watchdog_finish with id ${id} and its current version.\n${content}`;
  }
  private async changed(id: string, action: string, actor: string) {
    await createAdminEventsService(this.db).record(
      { type: `watchdog.${action}`, payload: { watchdog_id: id, actor } },
      { broadcast: false },
    );
    wsPublisher.publish('watchdogs.changed', { watchdog_id: id });
  }
  private async stop(tx: Tx, row: Watchdog, status: string, reason: string, now: string) {
    await tx
      .update(agentWatchdogs)
      .set({ status, lastError: reason, version: row.version + 1, updatedAt: now })
      .where(eq(agentWatchdogs.id, row.id));
    await tx
      .update(agentSchedules)
      .set({
        enabled: 0,
        nextDueAt: null,
        pauseReason: reason,
        version: sql`${agentSchedules.version} + 1`,
        updatedAt: now,
      })
      .where(eq(agentSchedules.id, row.scheduleId));
    const runs = await tx
      .select()
      .from(agentScheduleRuns)
      .where(eq(agentScheduleRuns.scheduleId, row.scheduleId));
    for (const run of runs) {
      const [message] = run.messageId
        ? await tx.select().from(agentBusMessages).where(eq(agentBusMessages.id, run.messageId)).for('update')
        : [];
      // Durable acceptance can precede the next schedule tick. Preserve that work.
      if (message?.status === 'accepted' || run.status === 'accepted' || run.status === 'completed') continue;
      if (message && ['queued', 'leased'].includes(message.status))
        await tx
          .update(agentBusMessages)
          .set({ status: 'canceled', canceledAt: now, leaseOwner: null, leaseUntil: null, updatedAt: now })
          .where(eq(agentBusMessages.id, message.id));
      await tx
        .update(agentScheduleRuns)
        .set({ status: 'canceled', updatedAt: now })
        .where(eq(agentScheduleRuns.id, run.id));
    }
  }

  async finish(raw: unknown, actor: string, disabled = false, ownSessionId?: string) {
    const v = z
      .object({
        id: z.string().uuid(),
        version: z.number().int().positive(),
        status: z.enum(['succeeded', 'failed', 'blocked', 'unknown']).optional(),
      })
      .strict()
      .parse(raw);
    if (!disabled && !v.status) throw new ValidationError('Explicit task result required');
    await this.db.transaction(async (tx) => {
      const row = await this.load(tx, v.id, true);
      if (ownSessionId) {
        const [session] = await tx.select().from(agentSessions).where(eq(agentSessions.id, ownSessionId));
        if (
          session?.agentBusAddressId !== row.targetAddressId ||
          session.upstreamSessionId !== row.nativeSessionId
        )
          throw new ForbiddenError('Watchdog belongs to another task');
      }
      const status = disabled ? 'disabled' : 'completed',
        reason = disabled ? 'user_disabled' : v.status!;
      if (row.status === status && row.lastError === reason && row.version === v.version + 1) return;
      if (row.version !== v.version)
        throw new ConflictError('Watchdog changed; retrieve again', 'watchdog_version_conflict');
      if (!WATCHDOG_LIVE.includes(row.status))
        throw new ConflictError('Watchdog is already terminal', 'watchdog_terminal');
      await this.stop(tx, row, status, reason, new Date().toISOString());
    });
    await this.changed(v.id, disabled ? 'disabled' : 'finished', actor);
    return this.get(v.id);
  }
  async snapshot(sessionId: string, token: string) {
    const session = await this.bridge(sessionId, token);
    const [row] = session.agentBusAddressId
      ? await this.db
          .select()
          .from(agentWatchdogs)
          .where(
            and(
              eq(agentWatchdogs.targetAddressId, session.agentBusAddressId),
              eq(agentWatchdogs.nativeSessionId, session.upstreamSessionId ?? ''),
              inArray(agentWatchdogs.status, WATCHDOG_LIVE),
            ),
          )
          .limit(1)
      : [];
    const [prompt] = await this.db
      .select({ id: agentPrompts.id })
      .from(agentPrompts)
      .where(and(eq(agentPrompts.sessionId, sessionId), eq(agentPrompts.status, 'open')))
      .limit(1);
    const watchdog = row ? await this.get(row.id) : null;
    return {
      server_time: new Date().toISOString(),
      watchdog,
      progress_timeout_seconds:
        row && row.deadlineAt > new Date().toISOString() && !prompt && WATCHDOG_LIVE.includes(row.status)
          ? row.progressTimeoutSeconds
          : null,
      terminate_requested:
        !!row &&
        row.sessionId === sessionId &&
        row.deadlineAt > new Date().toISOString() &&
        !prompt &&
        !session.closeRequestedAt &&
        ['capacity', 'hang', 'crash'].includes(row.lastError ?? '') &&
        WATCHDOG_LIVE.includes(row.status),
      binding_generation: session.bindingGeneration ?? 0,
    };
  }
  async activity(sessionId: string, token: string, raw: unknown) {
    const v = z
      .object({
        last_progress_at: z.string().datetime(),
        failure: z.enum(['capacity', 'crash', 'hang', 'user_stop', 'blocked']).optional(),
        native_session_id: z.string().optional(),
        retry_not_before: z.string().datetime().optional(),
      })
      .strict()
      .parse(raw);
    const session = await this.bridge(sessionId, token),
      now = new Date().toISOString();
    if (v.native_session_id && v.native_session_id !== session.upstreamSessionId) return { ignored: true };
    // Local clocks may drift. Never let a client move progress into the future.
    const progress = new Date(Math.min(Date.parse(v.last_progress_at), Date.parse(now))).toISOString();
    await this.db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(agentWatchdogs)
        .where(
          and(
            eq(agentWatchdogs.targetAddressId, session.agentBusAddressId!),
            eq(agentWatchdogs.nativeSessionId, session.upstreamSessionId ?? ''),
            inArray(agentWatchdogs.status, WATCHDOG_LIVE),
          ),
        )
        .for('update');
      if (!row) return;
      if (row.deadlineAt <= now) {
        await this.stop(tx, row, 'expired', 'deadline', now);
        return;
      }
      if (v.failure === 'blocked') {
        await this.stop(tx, row, 'blocked', 'provider_error', now);
        return;
      }
      if (v.failure === 'user_stop') {
        await this.stop(tx, row, 'disabled', 'user_stop', now);
        return;
      }
      await tx
        .update(agentWatchdogs)
        .set({
          lastProgressAt: progress > row.lastProgressAt ? progress : row.lastProgressAt,
          updatedAt: now,
        })
        .where(eq(agentWatchdogs.id, row.id));
      if (v.failure && row.status === 'watching') {
        const at = watchdogRetryTime(new Date(), v.retry_not_before);
        await tx
          .update(agentWatchdogs)
          .set({
            status: v.failure === 'capacity' ? 'capacity_wait' : 'recovering',
            lastError: v.failure,
            updatedAt: now,
          })
          .where(eq(agentWatchdogs.id, row.id));
        await tx
          .update(agentSchedules)
          .set({ atTime: at, nextDueAt: at, updatedAt: now })
          .where(eq(agentSchedules.id, row.scheduleId));
      }
    });
    return this.snapshot(sessionId, token);
  }
  async tick(now = new Date()) {
    const rows = await this.db
      .select({ id: agentWatchdogs.id })
      .from(agentWatchdogs)
      .where(inArray(agentWatchdogs.status, WATCHDOG_LIVE))
      .orderBy(asc(agentWatchdogs.id));
    for (const { id } of rows)
      await this.db.transaction(async (tx) => {
        const row = await this.load(tx, id, true),
          timestamp = now.toISOString();
        if (!WATCHDOG_LIVE.includes(row.status)) return;
        if (row.deadlineAt <= timestamp) {
          await this.stop(tx, row, 'expired', 'deadline', timestamp);
          return;
        }
        let target;
        try {
          target = await this.eligible(tx, row.targetAddressId);
        } catch (e) {
          if (!(e instanceof ForbiddenError)) throw e;
          await this.stop(tx, row, 'blocked', 'target_unavailable', timestamp);
          return;
        }
        if (target.lastUpstreamSessionId !== row.nativeSessionId || target.continuity !== 'native') {
          await this.stop(tx, row, 'blocked', 'native_session_changed', timestamp);
          return;
        }
        const [original] = row.messageId
          ? await tx.select().from(agentBusMessages).where(eq(agentBusMessages.id, row.messageId))
          : [];
        if (original?.taskResultStatus || original?.status === 'canceled' || original?.cancelRequestedAt) {
          await this.stop(tx, row, 'completed', original.taskResultStatus ?? 'user_stop', timestamp);
          return;
        }
        const [run] = await tx
          .select()
          .from(agentScheduleRuns)
          .where(eq(agentScheduleRuns.scheduleId, row.scheduleId))
          .orderBy(desc(agentScheduleRuns.createdAt))
          .limit(1);
        if (run && ['completed', 'blocked', 'dead', 'canceled'].includes(run.status)) {
          const [message] = run.messageId
            ? await tx.select().from(agentBusMessages).where(eq(agentBusMessages.id, run.messageId))
            : [];
          await this.stop(
            tx,
            row,
            run.status === 'completed' ? 'completed' : 'blocked',
            message?.taskResultStatus ?? run.lastError ?? 'unknown',
            timestamp,
          );
          return;
        }
        const [session] = await tx
          .select()
          .from(agentSessions)
          .where(eq(agentSessions.id, target.currentSessionId ?? row.sessionId));
        if (session?.closeRequestedAt) {
          await this.stop(tx, row, 'disabled', 'user_stop', timestamp);
          return;
        }
        if (row.status !== 'watching') return;
        if (session && !session.endedAt && Date.parse(session.heartbeatAt) > now.getTime() - 90000) return;
        const at = watchdogRetryTime(now);
        await tx
          .update(agentWatchdogs)
          .set({ status: 'recovering', lastError: 'connection_lost', updatedAt: timestamp })
          .where(eq(agentWatchdogs.id, id));
        await tx
          .update(agentSchedules)
          .set({ atTime: at, nextDueAt: at, updatedAt: timestamp })
          .where(eq(agentSchedules.id, row.scheduleId));
      });
  }
}
