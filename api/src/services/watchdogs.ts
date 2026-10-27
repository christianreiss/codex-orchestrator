import { stageSupervisorArm } from './agent-supervisor/arm.js';
import { watchdogPolicy } from '../control-plane/streams/policies.js';
import {addOwnerResponseProof} from '../control-plane/state/runtime.js';
import {ownedBridge,ownedAddress} from '../control-plane/state/messaging.js';
import { adminAudit } from '../control-plane/state/admin.js';
import { stageUpdate } from '../control-plane/state/rows.js';
import { ownedCredentialDeadline } from '../control-plane/credentials.js';
import { stageStopWatchdog } from '../control-plane/state/session-lifecycle.js';
import { ownerRuntimeFor, mutateOwnerState } from '../control-plane/state/runtime.js';
import { tickOwnedWatchdogs } from './schedules/watchdog-owner.js';
import { quotaSnapshot, quotaInterruption, quotaRecoveryAllowed } from './quota-observation.js';
import type { Engine } from '../util/engine.js';
import { assertNoRebootRecovery } from './reboot-handoffs.js';
import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, inArray, isNotNull } from 'drizzle-orm';
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
import { WATCHDOG_LIVE, watchdogRetryTime, stopWatchdogLocked } from './watchdog-lifecycle.js';

type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];
type Watchdog = typeof agentWatchdogs.$inferSelect;
export { WATCHDOG_LIVE, watchdogRetryTime } from './watchdog-lifecycle.js';
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
export class WatchdogsService {
  constructor(
    private readonly db: Database,
    private readonly keyring: Keyring,
  ) {}
  async bridge(id: string, token: string) {
    const owner = ownerRuntimeFor(this.db); owner?.assertOwner();
    const session = owner ? owner.state.snapshot().sessions.get(id) : (await this.db.select().from(agentSessions).where(eq(agentSessions.id, id)))[0];
    if (
      !session ||
      session.endedAt ||
      (owner ? ownedCredentialDeadline(owner.state.snapshot(), 'session', session.id) : Date.parse(session.bridgeExpiresAt)) <= Date.now() ||
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
    if(owner)addOwnerResponseProof('watchdog:'+id,state=>{const current=ownedBridge(state,id,token,{generation:session.bindingGeneration}).session,address=ownedAddress(state,current.agentBusAddressId??'');if(address.currentSessionId!==current.id||address.lastUpstreamSessionId!==current.upstreamSessionId||address.bindingGeneration!==current.bindingGeneration)throw new ForbiddenError('Watchdog binding changed','watchdog_binding_stale');});
    return session;
  }
  private async eligible(db: Pick<Database, 'select'>, id: string, fingerprint?: string) {
    const owner = ownerRuntimeFor(db); owner?.assertOwner(); const state = owner?.state.snapshot();
    const target = state ? state.addresses.get(id) : (await db.select().from(agentBusAddresses).where(eq(agentBusAddresses.id, id)))[0];
    const host = target ? state ? state.hosts.get(target.hostId) : (await db.select().from(hosts).where(eq(hosts.id, target.hostId)))[0] : undefined;
    const flags = state ? state.table('versions').all() : await db
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
      (fingerprint && fingerprint !== ('authFingerprint' in host ? host.authFingerprint : hostAuthFingerprint(host))) ||
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
    const owner = ownerRuntimeFor(db);
    if (owner) { owner.assertOwner(); const row = owner.state.snapshot().table('agentWatchdogs').get(z.string().uuid().parse(id)); if (row) return row; const archived = (await db.select().from(agentWatchdogs).where(eq(agentWatchdogs.id, id)))[0]; if (!archived) throw new NotFoundError('Watchdog not found', 'watchdog_not_found'); return archived; }
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
    const owned = ownerRuntimeFor(this.db)?.state.snapshot();
    const state = owned?.table('agentWatchdogs').has(row.id) ? owned : undefined;
    const [run] = state ? [...state.table('agentScheduleRuns').by('scheduleId', row.scheduleId)].sort((a,b) => b.createdAt.localeCompare(a.createdAt)).slice(0,1) : await this.db
      .select()
      .from(agentScheduleRuns)
      .where(eq(agentScheduleRuns.scheduleId, row.scheduleId))
      .orderBy(desc(agentScheduleRuns.createdAt))
      .limit(1);
    const [schedule] = state ? [state.table('agentSchedules').get(row.scheduleId)] : await this.db
      .select()
      .from(agentSchedules)
      .where(eq(agentSchedules.id, row.scheduleId));
    const [message] = run?.messageId
      ? state?.table('agentBusMessages').has(run.messageId) ? [state.table('agentBusMessages').get(run.messageId)] : await this.db
          .select({ acceptedAt: agentBusMessages.acceptedAt })
          .from(agentBusMessages)
          .where(eq(agentBusMessages.id, run.messageId))
      : [];
    return {
      id: row.id,
      target: `agent:${row.targetAddressId}`,
      native_session_id: row.nativeSessionId,
      task_key: row.taskKey,
      quota: row.quotaAccountId ? { account_id: row.quotaAccountId, window: row.quotaWindow, reset_at: row.quotaResetAt, attempts: row.quotaAttempts, last_attempt_at: row.quotaAttemptAt } : null,
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
    const owner = ownerRuntimeFor(this.db); owner?.assertOwner();
    const session = owner ? owner.state.snapshot().sessions.get(id) : (await this.db.select().from(agentSessions).where(eq(agentSessions.id, id)))[0];
    if (!session?.agentBusAddressId || !session.upstreamSessionId) return null;
    const [row] = owner ? owner.state.snapshot().table('agentWatchdogs').by('targetAddressId', session.agentBusAddressId).filter(row => row.nativeSessionId === session.upstreamSessionId).sort((a,b) => b.createdAt.localeCompare(a.createdAt)).slice(0,1) : await this.db
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
    ownerRuntimeFor(this.db)?.assertOwner();
    if (target) z.string().regex(/^agent:[0-9a-f-]{36}$/i).parse(target);
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
    const quotaRuns = await this.db.select().from(agentScheduleRuns).where(and(
      isNotNull(agentScheduleRuns.quotaRecovery),
      target ? eq(agentScheduleRuns.targetAddressId, target.slice(6).toLowerCase()) : undefined,
    )).orderBy(desc(agentScheduleRuns.createdAt)).limit(20);
    return { watchdogs: await Promise.all(rows.map((r) => this.get(r.id))), quota_runs: quotaRuns.map(r => ({
      id: r.id, schedule_id: r.scheduleId, target: `agent:${r.targetAddressId}`, status: r.status,
      quota: r.quotaRecovery, next_attempt_at: r.nextAttemptAt, last_error: r.lastError,
    })) };

  }
  async enable(raw: unknown, actor: string, ownSessionId?: string) {
    const v = watchdogEnableInput.parse(raw),
      now = new Date().toISOString();
    if (ownerRuntimeFor(this.db)) return this.enableOwned(v, actor, ownSessionId);
    let id = '';
    await this.db.transaction(async (tx) => {
      const [target] = await tx
        .select()
        .from(agentBusAddresses)
        .where(eq(agentBusAddresses.id, v.target.slice(6).toLowerCase()))
        .for('update');
      if (!target) throw new NotFoundError('Agent not found');
      await this.eligible(tx, target.id);
      await assertNoRebootRecovery(tx, target.id);
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
  private async enableOwned(v: z.infer<typeof watchdogEnableInput>, actor: string, ownSessionId?: string) {
    const owner = ownerRuntimeFor(this.db)!; let id = '';
    await mutateOwnerState(owner, { kind: 'watchdog.enable', payload: { target: v.target, actor }, prepare: async context => {
      const now = new Date().toISOString(), target = await this.eligible(this.db, v.target.slice(6).toLowerCase());
      if (context.draft.table('agentRebootHandoffs').by('addressId', target.id).some(row => ['prepared','armed'].includes(row.status))) throw new ConflictError('A planned reboot already owns this session; recovery cannot be enabled', 'reboot_handoff_conflict');
      if (!target.lastUpstreamSessionId || target.continuity !== 'native' || !target.currentSessionId) throw new ValidationError('A current native session is required');
      if (ownSessionId && target.currentSessionId !== ownSessionId) throw new ForbiddenError('AI tools may enable only their own current task', 'watchdog_own_task_only');
      const session = context.draft.table('agentSessions').get(target.currentSessionId), host = context.draft.table('hosts').get(target.hostId);
      if (!session || session.endedAt || !host || session.hostAuthFingerprint !== host.authFingerprint) throw new ValidationError('Current session is unavailable');
      if ((session.adapterCapabilities as Record<string, unknown> | null)?.watchdog_protocol_version !== 1) throw new ConflictError('Watchdog requires wrapper 0.9.36 or later', 'adapter_upgrade_required');
      if (session.upstreamSessionId !== target.lastUpstreamSessionId || session.bindingGeneration !== target.bindingGeneration) throw new ConflictError('Native binding changed', 'watchdog_binding_stale');
      const rows = context.draft.table('agentWatchdogs').by('targetAddressId', target.id);
      const old = rows.find(row => row.nativeSessionId === target.lastUpstreamSessionId && row.taskKey === v.task_key) ?? (await this.db.select().from(agentWatchdogs).where(and(eq(agentWatchdogs.targetAddressId, target.id), eq(agentWatchdogs.nativeSessionId, target.lastUpstreamSessionId), eq(agentWatchdogs.taskKey, v.task_key))))[0];
      const digest = sha256(JSON.stringify([v.continuation, v.duration_seconds, v.progress_timeout_seconds]));
      if (old) {
        id = old.id;
        if (old.continuationSha === digest && WATCHDOG_LIVE.includes(old.status) && (!v.version || old.version === v.version || old.version === v.version + 1)) return null;
        if (!WATCHDOG_LIVE.includes(old.status) || old.version !== v.version) throw new ConflictError('Watchdog changed; use a new task key or retrieve its version', 'watchdog_version_conflict');
        stageUpdate(context, 'agentWatchdogs', id, { progressTimeoutSeconds: v.progress_timeout_seconds, deadlineAt: new Date(Date.now() + v.duration_seconds * 1000).toISOString(), continuationSha: digest, version: old.version + 1, updatedAt: now });
        stageUpdate(context, 'agentSchedules', old.scheduleId, { promptEnc: encrypt(this.continuation(id, v.task_key, v.continuation), this.keyring), progressTimeoutSeconds: v.progress_timeout_seconds, updatedAt: now });
        adminAudit(context, 'watchdog.enabled', { watchdog_id: id, actor }, now); return null;
      }
      if (rows.some(row => WATCHDOG_LIVE.includes(row.status))) throw new ConflictError('Agent already has an active watchdog', 'watchdog_already_active');
      const message = context.draft.table('agentBusMessages').by('targetAddressId', target.id).filter(row => row.deliverySessionId === session.id && row.status === 'accepted').sort((a,b) => (b.acceptedAt ?? '').localeCompare(a.acceptedAt ?? ''))[0];
      id = randomUUID(); const scheduleId = randomUUID();
      const schedule = { id: scheduleId, name: `Watchdog ${v.task_key}`.slice(0,120), targetAddressId: target.id, promptEnc: encrypt(this.continuation(id, v.task_key, v.continuation), this.keyring), kind: 'once', timezone: 'Europe/Berlin', persistent: 1, enabled: 1, progressTimeoutSeconds: v.progress_timeout_seconds, maxRecoveryAttempts: null, nextDueAt: null, atTime: null, cronExpression: null, intervalMinutes: null, pauseReason: null, deletedAt: null, version: 1, createdBy: actor, updatedBy: actor, createdAt: now, updatedAt: now };
      const watchdog = { id, targetAddressId: target.id, nativeSessionId: target.lastUpstreamSessionId, sessionId: session.id, taskKey: v.task_key, messageId: message?.id ?? null, scheduleId, continuationSha: digest, deadlineAt: new Date(Date.now() + v.duration_seconds * 1000).toISOString(), progressTimeoutSeconds: v.progress_timeout_seconds, lastProgressAt: now, createdBy: actor, createdAt: now, updatedAt: now, status: 'watching', version: 1, lastError: null, quotaAccountId: null, quotaWindow: null, quotaResetAt: null, quotaAttempts: 0, quotaAttemptAt: null };
      context.draft.upsert('agentSchedules', schedule); context.draft.upsert('agentWatchdogs', watchdog);
      context.write(async tx => { await tx.insert(agentSchedules).values(schedule); await tx.insert(agentWatchdogs).values(watchdog); }); adminAudit(context, 'watchdog.enabled', { watchdog_id: id, actor }, now); return null;
    } });
    await this.changed(id, 'enabled', actor); return this.get(id);
  }
  private continuation(id: string, task: string, content: string) {
    return `Watchdog recovery for task ${task}. Continue only the existing authorized task. When the task ends, call watchdog_finish with id ${id} and its current version.\n${content}`;
  }
  private async changed(id: string, action: string, actor: string) {
    if (ownerRuntimeFor(this.db)) { wsPublisher.publish('watchdogs.changed', { watchdog_id: id }); return; }
    await createAdminEventsService(this.db).record(
      { type: `watchdog.${action}`, payload: { watchdog_id: id, actor } },
      { broadcast: false },
    );
    wsPublisher.publish('watchdogs.changed', { watchdog_id: id });
  }
  private async stop(tx: Tx, row: Watchdog, status: string, reason: string, now: string) {
    await stopWatchdogLocked(tx, row, status, reason, now);
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
    const owner = ownerRuntimeFor(this.db);
    if (owner) {
      await mutateOwnerState(owner, { kind: 'watchdog.finish', payload: { id: v.id, actor, disabled }, prepare: async context => {
        const row = context.draft.table('agentWatchdogs').get(v.id) ?? await this.load(this.db, v.id); if (!row) throw new NotFoundError('Watchdog not found');
        const session = ownSessionId ? context.draft.table('agentSessions').get(ownSessionId) : undefined;
        if (ownSessionId && (session?.agentBusAddressId !== row.targetAddressId || session.upstreamSessionId !== row.nativeSessionId)) throw new ForbiddenError('Watchdog belongs to another task');
        const status = disabled ? 'disabled' : 'completed', reason = disabled ? 'user_disabled' : v.status!;
        if (row.status === status && row.lastError === reason && row.version === v.version + 1) return null;
        if (row.version !== v.version) throw new ConflictError('Watchdog changed; retrieve again', 'watchdog_version_conflict');
        if (!WATCHDOG_LIVE.includes(row.status)) throw new ConflictError('Watchdog is already terminal', 'watchdog_terminal');
        stageStopWatchdog(context, row, status, reason, new Date().toISOString()); adminAudit(context, disabled ? 'watchdog.disabled' : 'watchdog.finished', { watchdog_id: row.id, actor }); return null;
      } });
      await this.changed(v.id, disabled ? 'disabled' : 'finished', actor); return this.get(v.id);
    }
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
    const state = ownerRuntimeFor(this.db)?.state.snapshot();
    if (state) return { server_time: new Date().toISOString(), ...watchdogPolicy(state, state.sessions.get(sessionId)!) };
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
    const quotaAllowed = !row?.quotaAccountId || await quotaRecoveryAllowed(this.db, session.engine as Engine, row.quotaAccountId, row.quotaWindow);
    return {
      server_time: new Date().toISOString(),
      watchdog,
      progress_timeout_seconds:
        quotaAllowed && row && row.deadlineAt > new Date().toISOString() && !prompt && WATCHDOG_LIVE.includes(row.status)
          ? row.progressTimeoutSeconds
          : null,
      terminate_requested:
        quotaAllowed && !!row &&
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
        quota_limit: z.boolean().optional(),
        termination_unconfirmed: z.boolean().optional(),
      })
      .strict()
      .parse(raw);
    const session = await this.bridge(sessionId, token),
      now = new Date().toISOString();
    if (v.native_session_id && v.native_session_id !== session.upstreamSessionId) return { ignored: true };
    if (ownerRuntimeFor(this.db)) return this.activityOwned(sessionId, token, v);
    if (v.failure === 'capacity' && session.providerAccountId && session.upstreamSessionId) {
      const snapshot = await quotaSnapshot(this.db, session.providerAccountId, session.engine as Engine);
      const interruption = quotaInterruption(snapshot, v.quota_limit === true, v.retry_not_before);
      if (interruption) {
        let current = await this.forSession(sessionId);
        // A scheduled delivery already owns an exact-session execution lane. Attach
        // the quota wait to that run rather than launching a competing watchdog.
        const messages = !current ? await this.db.select().from(agentBusMessages).where(and(
          eq(agentBusMessages.deliverySessionId, sessionId), eq(agentBusMessages.targetAddressId, session.agentBusAddressId!),
        )).orderBy(desc(agentBusMessages.createdAt)).limit(1) : [];
        const [scheduled] = messages[0] ? await this.db.select().from(agentScheduleRuns).where(and(
          eq(agentScheduleRuns.messageId, messages[0].id), eq(agentScheduleRuns.persistent, 1),
          inArray(agentScheduleRuns.status, ['queued', 'leased', 'accepted', 'recovering', 'capacity_wait']),
        )).limit(1) : [];
        if (scheduled) {
          await this.db.update(agentScheduleRuns).set({ quotaRecovery: {
            account_id: session.providerAccountId, native_session_id: session.upstreamSessionId,
            window: interruption.kind, reset_at: interruption.reset_at,
            attempts: scheduled.quotaRecovery?.attempts ?? 0, attempt_at: scheduled.quotaRecovery?.attempt_at ?? null,
          } }).where(eq(agentScheduleRuns.id, scheduled.id));
        }
        if (!current && !scheduled && interruption.enabled && session.invocationKind !== 'peer_delivery') {
          // A quota watchdog is armed only by a proven interrupted turn, never by usage alone.
          current = await this.enable({ target: `agent:${session.agentBusAddressId}`,
            task_key: `quota:${session.upstreamSessionId}`,
            continuation: 'The previous turn was interrupted by a provider quota limit. Continue only its unfinished authorized task, preserving the existing native subagents. Check quota_get before heavy work. If the task is finished or canceled, report that and call watchdog_finish; do not invent new work.',
            duration_seconds: 604800, progress_timeout_seconds: 600,
          }, `quota:${sessionId}`, sessionId);
        }
        if (current && WATCHDOG_LIVE.includes(current.status)) {
          await this.db.update(agentWatchdogs).set({ quotaAccountId: session.providerAccountId,
            quotaWindow: interruption.kind, quotaResetAt: interruption.reset_at,
            ...(current.created_by.startsWith('quota:') && interruption.reset_at ? { deadlineAt: new Date(Math.max(Date.now() + 604800000, Date.parse(interruption.reset_at) + 86400000)).toISOString() } : {}),
          }).where(eq(agentWatchdogs.id, current.id));
          // One durable wake, fenced by the existing native-session recovery executor.
          if (interruption.reset_at) v.retry_not_before = interruption.retry_at;
        }
      }
    }
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
  private async activityOwned(sessionId: string, token: string, v: { last_progress_at: string; failure?: 'capacity'|'crash'|'hang'|'user_stop'|'blocked'; retry_not_before?: string; quota_limit?: boolean; termination_unconfirmed?:boolean }) {
    const owner = ownerRuntimeFor(this.db)!, session = await this.bridge(sessionId, token);
    const quota = v.failure === 'capacity' && session.providerAccountId && session.upstreamSessionId ? quotaInterruption(await quotaSnapshot(this.db, session.providerAccountId, session.engine as Engine), v.quota_limit === true, v.retry_not_before) : null;
    if (quota && session.providerAccountId && session.upstreamSessionId) {
      const state = owner.state.snapshot();
      const current = await this.forSession(sessionId);
      const message = !current ? state.table('agentBusMessages').by('deliverySessionId', sessionId).filter(row => row.targetAddressId === session.agentBusAddressId).sort((a,b) => b.createdAt.localeCompare(a.createdAt))[0] : undefined;
      const scheduled = message ? state.table('agentScheduleRuns').by('messageId', message.id).find(row => row.persistent && ['queued','leased','accepted','recovering','capacity_wait'].includes(row.status)) : undefined;
      if (!current && !scheduled && quota.enabled && session.invocationKind !== 'peer_delivery') await this.enable({ target: `agent:${session.agentBusAddressId}`, task_key: `quota:${session.upstreamSessionId}`, continuation: 'The previous turn was interrupted by a provider quota limit. Continue only its unfinished authorized task, preserving the existing native subagents. Check quota_get before heavy work. If the task is finished or canceled, report that and call watchdog_finish; do not invent new work.', duration_seconds: 604800, progress_timeout_seconds: 600 }, `quota:${sessionId}`, sessionId);
    }
    const now = new Date().toISOString(), progress = new Date(Math.min(Date.parse(v.last_progress_at), Date.parse(now))).toISOString();
    const current = owner.state.snapshot().table('agentWatchdogs').by('targetAddressId', session.agentBusAddressId!).find(row => row.nativeSessionId === session.upstreamSessionId && WATCHDOG_LIVE.includes(row.status));
    if (!quota && !v.failure && (!current || progress <= current.lastProgressAt)) return this.snapshot(sessionId, token);
    await mutateOwnerState(owner, { kind: 'watchdog.activity', payload: { sessionId, progress, failure: v.failure ?? null }, prepare: async context => {
      const live = await this.bridge(sessionId, token);
      if(v.failure && ['capacity','crash','hang'].includes(v.failure))stageSupervisorArm(context,context.draft.table('agentSessions').get(sessionId)!,this.keyring,now);
      const row = context.draft.table('agentWatchdogs').by('targetAddressId', live.agentBusAddressId!).find(row => row.nativeSessionId === live.upstreamSessionId && WATCHDOG_LIVE.includes(row.status));
      if (quota && live.providerAccountId && live.upstreamSessionId) {
        const message = !row ? context.draft.table('agentBusMessages').by('deliverySessionId', sessionId).filter(item => item.targetAddressId === live.agentBusAddressId).sort((a,b) => b.createdAt.localeCompare(a.createdAt))[0] : undefined;
        const run = message ? context.draft.table('agentScheduleRuns').by('messageId', message.id).find(item => item.persistent && ['queued','leased','accepted','recovering','capacity_wait'].includes(item.status)) : undefined;
        if (run) stageUpdate(context, 'agentScheduleRuns', run.id, { quotaRecovery: { account_id: live.providerAccountId, native_session_id: live.upstreamSessionId, window: quota.kind, reset_at: quota.reset_at, attempts: run.quotaRecovery?.attempts ?? 0, attempt_at: run.quotaRecovery?.attempt_at ?? null } });
        if (row) stageUpdate(context, 'agentWatchdogs', row.id, { quotaAccountId: live.providerAccountId, quotaWindow: quota.kind, quotaResetAt: quota.reset_at, ...(row.createdBy.startsWith('quota:') && quota.reset_at ? { deadlineAt: new Date(Math.max(Date.now() + 604800000, Date.parse(quota.reset_at) + 86400000)).toISOString() } : {}) });
      }
      if (!row) return null;
      if (row.deadlineAt <= now) { stageStopWatchdog(context, row, 'expired', 'deadline', now); return null; }
      if (v.failure === 'blocked' || v.failure === 'user_stop') { stageStopWatchdog(context, row, v.failure === 'blocked' ? 'blocked' : 'disabled', v.failure === 'blocked' ? (v.termination_unconfirmed ? 'termination_unconfirmed' : 'provider_error') : 'user_stop', now); return null; }
      if (progress > row.lastProgressAt) stageUpdate(context, 'agentWatchdogs', row.id, { lastProgressAt: progress, updatedAt: now });
      if (v.failure && row.status === 'watching') {
        if (row.createdBy === 'supervisor') {
          const work = context.draft.table('agentWorkStates').get(row.targetAddressId);
          if (work && !work.incidentAt) {
            const deadlineAt = new Date(Date.parse(now) + 7200000).toISOString();
            stageUpdate(context,'agentWorkStates',work.addressId,{incidentAt:now,deadlineAt});
            stageUpdate(context,'agentWatchdogs',row.id,{deadlineAt});
          }
        }
        const at = watchdogRetryTime(new Date(now), quota?.reset_at ? quota.retry_at : v.retry_not_before);
        stageUpdate(context, 'agentWatchdogs', row.id, { status: v.failure === 'capacity' ? 'capacity_wait' : 'recovering', lastError: v.failure, updatedAt: now });
        stageUpdate(context, 'agentSchedules', row.scheduleId, { atTime: at, nextDueAt: at, updatedAt: now });
      }
      return null;
    } });
    return this.snapshot(sessionId, token);
  }
  async tick(now = new Date()) {
    if (ownerRuntimeFor(this.db)) return tickOwnedWatchdogs(this.db, now);
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
        if (row.quotaAccountId && !(await quotaRecoveryAllowed(tx, target.engine as Engine, row.quotaAccountId, row.quotaWindow))) {
          await this.stop(tx, row, 'blocked', 'quota_policy_disabled', timestamp);
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
        if (row.status !== 'watching' || row.quotaAccountId) return;
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
