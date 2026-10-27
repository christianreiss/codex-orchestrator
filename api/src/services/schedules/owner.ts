import { adminAudit } from '../../control-plane/state/admin.js';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../../http/errors.js';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import type { Database } from '../../db/client.js';
import {
  agentSchedules,
  agentScheduleRuns,
  agentBusConversations,
  agentBusMessages,
} from '../../db/schema.js';
import {
  requireOwnerRuntime,
  mutateOwnerState,
  type OwnerMutationContext,
} from '../../control-plane/state/runtime.js';
import type { StateRow } from '../../control-plane/state/catalog.js';
import { stageUpdate } from '../../control-plane/state/rows.js';
import { stageStopWatchdog } from '../../control-plane/state/session-lifecycle.js';
import { stageServerAddress, stageQueuedMessage } from '../../control-plane/state/messages.js';
import { ownerPresence } from '../../control-plane/presence.js';
import { receiverState } from '../agent-receiver-state.js';
import { decrypt, encrypt } from '../../security/secret-box.js';
import type { Keyring } from '../../security/keyring.js';
import { nextOccurrence, scheduleInput, type ScheduleInput } from './timing.js';
import { SCHEDULE_TARGET_GRACE_SECONDS } from './staleness.js';
import { recoveryBudget } from '../agent-supervisor/policy.js';
import { recoveryDelaySeconds } from './recovery.js';
import { quotaSnapshot, quotaResumeGate } from '../quota-observation.js';
import { readFleetEngineState } from '../engine-switch.js';
import { activeHostEngines } from '../host-engine-policy.js';
import { messagingHostEligible } from '../agent-messaging/eligibility.js';
import { newQueuedMessage } from '../agent-messaging/views.js';
import { daemonResidentFor } from '../host-daemon/policy.js';
import { isEngine } from '../../util/engine.js';
import { wsPublisher } from '../../ws/publisher.js';

export const ACTIVE_RUNS = ['waiting', 'queued', 'leased', 'accepted', 'recovering', 'capacity_wait'];
type Run = StateRow<'agentScheduleRuns'>;
type Schedule = StateRow<'agentSchedules'>;
export function scheduleInputFrom(row: Schedule): ScheduleInput {
  return {
    name: row.name,
    target: `agent:${row.targetAddressId}`,
    prompt: '',
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
export function stageCancelScheduled(context: OwnerMutationContext, scheduleId: string, now: string): void {
  for (const run of context.draft.table('agentScheduleRuns').by('scheduleId', scheduleId)) {
    if (!ACTIVE_RUNS.includes(run.status)) continue;
    const message = run.messageId ? context.draft.table('agentBusMessages').get(run.messageId) : undefined;
    if (message?.status === 'accepted' || run.status === 'accepted') continue;
    if (message && ['queued', 'leased'].includes(message.status))
      stageUpdate(context, 'agentBusMessages', message.id, {
        status: 'canceled',
        canceledAt: now,
        leaseOwner: null,
        leaseUntil: null,
        updatedAt: now,
      });
    stageUpdate(context, 'agentScheduleRuns', run.id, { status: 'canceled', updatedAt: now });
  }
}
async function advance(
  context: OwnerMutationContext,
  db: Database,
  keyring: Keyring,
  run: Run,
  now: Date,
  enabled: boolean,
  freshPrompt?: string,
) {
  const timestamp = now.toISOString(),
    draft = context.draft;
  const watchdog = draft
    .table('agentWatchdogs')
    .all()
    .find((row) => row.scheduleId === run.scheduleId);
  const target = draft.table('agentBusAddresses').get(run.targetAddressId);
  const message = run.messageId ? draft.table('agentBusMessages').get(run.messageId) : undefined;
  const set = (patch: Partial<Run>) => {
    const current = draft.table('agentScheduleRuns').get(run.id)!;
    if (
      Object.entries(patch).every(
        ([key, value]) => JSON.stringify(current[key as keyof Run]) === JSON.stringify(value),
      )
    )
      return;
    stageUpdate(context, 'agentScheduleRuns', run.id, { ...patch, updatedAt: timestamp });
  };
  if (
    watchdog &&
    (!['watching', 'recovering', 'capacity_wait'].includes(watchdog.status) ||
      watchdog.deadlineAt <= timestamp ||
      !target ||
      target.lastUpstreamSessionId !== watchdog.nativeSessionId ||
      target.continuity !== 'native')
  ) {
    if (message?.status !== 'accepted' && run.status !== 'accepted')
      set({ status: message?.status === 'completed' ? 'completed' : 'canceled' });
    return;
  }
  const supervisorWork = watchdog ? draft.table('agentWorkStates').all().find(w => w.watchdogId === watchdog.id) : undefined;
  if (supervisorWork && !supervisorWork.model) {
    if(watchdog)stageStopWatchdog(context,watchdog,'blocked','supervisor_model_unknown',timestamp);
    if(message?.status!=='accepted')set({status:'blocked',lastError:'supervisor_model_unknown'});
    return;
  }
  if (supervisorWork && (supervisorWork.paused || (supervisorWork.deadlineAt && supervisorWork.deadlineAt <= timestamp))) {
    if (watchdog) stageStopWatchdog(context, watchdog, 'blocked', supervisorWork.paused ? 'supervisor_paused' : 'recovery_deadline', timestamp);
    if (message?.status !== 'accepted') set({status:'blocked',lastError:'supervisor_budget'});
    return;
  }
  const quotaGate = async () => {
    const q = watchdog?.quotaAccountId
      ? {
          account_id: watchdog.quotaAccountId,
          window: watchdog.quotaWindow,
          reset_at: watchdog.quotaResetAt,
          attempts: watchdog.quotaAttempts,
          attempt_at: watchdog.quotaAttemptAt,
          native_session_id: watchdog.nativeSessionId,
        }
      : run.quotaRecovery;
    if (!q) return true;
    const snapshot =
      target && isEngine(target.engine)
        ? await quotaSnapshot(db, q.account_id, target.engine, now.getTime())
        : null;
    const gate =
      target?.lastUpstreamSessionId === q.native_session_id && target.continuity === 'native'
        ? quotaResumeGate(snapshot, q.window, q.reset_at, q.attempts, q.attempt_at, now.getTime())
        : { stop: 'quota_native_session_changed' };
    if ('stop' in gate) {
      if (watchdog) stageStopWatchdog(context, watchdog, 'blocked', gate.stop!, timestamp);
      set({ status: 'blocked', lastError: gate.stop });
      return false;
    }
    if ('wait_until' in gate) {
      set({ status: 'capacity_wait', nextAttemptAt: gate.wait_until, lastError: 'quota_wait' });
      return false;
    }
    if (watchdog)
      stageUpdate(context, 'agentWatchdogs', watchdog.id, {
        quotaAttempts: q.attempts + 1,
        quotaAttemptAt: timestamp,
        updatedAt: timestamp,
      });
    else set({ quotaRecovery: { ...run.quotaRecovery!, attempts: q.attempts + 1, attempt_at: timestamp } });
    return true;
  };
  if (run.messageId) {
    if (!message) {
      set({ status: 'blocked', lastError: 'delivery_missing' });
      return;
    }
    if (message.status === 'reboot_hold') return;
    if (['queued', 'leased', 'accepted', 'completed', 'canceled'].includes(message.status)) {
      set({ status: message.status });
      return;
    }
    // A lost transport never grants permission to repeat an accepted execution.
    if (message.acceptedAt && !message.taskResultStatus) {
      set({ status: 'accepted', lastError: message.lastErrorCode });
      return;
    }
    if (!enabled || !run.persistent || message.lastErrorCode === 'schedule_transcript_missing') {
      set({
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
      const schedule = draft.table('agentSchedules').get(run.scheduleId)!;
      stageUpdate(context, 'agentSchedules', schedule.id, {
        enabled: 0,
        pauseReason: 'recovery_limit_reached',
        version: schedule.version + 1,
        updatedAt: timestamp,
      });
      set({ status: 'blocked', lastError: 'recovery_limit_reached' });
      return;
    }
    if (run.recoveryCount >= 3 && !run.warningAt) set({ warningAt: timestamp });
    if (!['recovering', 'capacity_wait'].includes(run.status)) {
      // Error text is cold; the retry marker is consulted only for an actual failed delivery.
      let retry = now.getTime() + recoveryDelaySeconds(run.retrySeconds, run.recoveryCount) * 1000;
      const error = (
        await db
          .select({ encrypted: agentBusMessages.lastErrorEnc })
          .from(agentBusMessages)
          .where(eq(agentBusMessages.id, message.id))
      )[0]?.encrypted;
      if (error) {
        const marker = decrypt(error, keyring).match(/^retry_not_before=(.+)$/);
        const hinted = marker ? Date.parse(marker[1]!) : NaN;
        if (Number.isFinite(hinted)) retry = Math.max(retry, hinted);
      }
      set({
        status: message.lastErrorCode === 'schedule_capacity' ? 'capacity_wait' : 'recovering',
        lastError: message.lastErrorCode ?? message.status,
        nextAttemptAt: new Date(retry).toISOString(),
      });
      return;
    }
    if (supervisorWork && recoveryBudget(supervisorWork, run.recoveryCount + 1, now.getTime())) {
      if (watchdog) stageStopWatchdog(context, watchdog, 'blocked', 'recovery_limit', timestamp);
      set({status:'blocked',lastError:'recovery_limit'}); return;
    }
    if (run.nextAttemptAt > timestamp || !(await quotaGate())) return;
    stageUpdate(context, 'agentBusMessages', message.id, {
      status: 'queued',
      attempts: 0,
      nextAttemptAt: timestamp,
      leaseOwner: null,
      leaseUntil: null,
      claimId: null,
      relayGeneration: null,
      acceptedAt: watchdog ? message.acceptedAt : null,
      updatedAt: timestamp,
    });
    set({ status: 'queued', recoveryCount: run.recoveryCount + 1 });
    return;
  }
  if (!enabled) {
    set({ status: 'canceled' });
    return;
  }
  const host = target ? draft.table('hosts').get(target.hostId) : undefined;
  if (
    !target ||
    !host ||
    !target.enabled ||
    target.archivedAt ||
    !isEngine(target.engine) ||
    !messagingHostEligible(host) ||
    !activeHostEngines(host.engines, await readFleetEngineState(db)).includes(target.engine)
  )
    return;
  if (run.persistent && (!target.lastUpstreamSessionId || target.continuity !== 'native')) {
    set({ status: 'blocked', lastError: 'native_session_missing' });
    return;
  }
  if (run.persistent) {
    const daemon = draft.table('hostDaemons').get(target.hostId);
    if (!daemon || !daemonResidentFor(daemon.settings, target.username)) {
      set({ status: 'blocked', lastError: 'schedule_host_not_persistent' });
      return;
    }
  } else {
    const session = target.currentSessionId
      ? draft.table('agentSessions').get(target.currentSessionId)
      : undefined;
    const receiver = receiverState(session?.receiver);
    if (
      !session ||
      !receiver ||
      receiver.failure ||
      !receiver.probes.peer ||
      !ownerPresence(requireOwnerRuntime(db)).hasReceiver(
        session.id,
        session.bindingGeneration,
        receiver.generation,
      )
    )
      return;
  }
  if (!(await quotaGate())) return;
  const sender = stageServerAddress(context, timestamp),
    conversationId = randomUUID(),
    messageId = randomUUID();
  const conversation = {
    status: 'active',
    canceledAt: null,
    canceledBy: null,
    cancelReason: null,
    id: conversationId,
    addressAId: sender.id,
    addressBId: target.id,
    createdByAddressId: sender.id,
    nextSequence: 2,
    lastActivityAt: timestamp,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  draft.upsert('agentBusConversations', conversation);
  context.write(async (tx) => {
    await tx.insert(agentBusConversations).values(conversation);
  });
  const prompt =
    freshPrompt ??
    (
      await db
        .select({ encrypted: agentScheduleRuns.promptEnc })
        .from(agentScheduleRuns)
        .where(eq(agentScheduleRuns.id, run.id))
    )[0]?.encrypted;
  if (!prompt) throw new Error('Schedule run prompt is missing');
  stageQueuedMessage(
    context,
    newQueuedMessage({
      id: messageId,
      conversationId,
      sequence: 1,
      sender,
      senderSessionId: null,
      target,
      kind: 'schedule',
      content: decrypt(prompt, keyring),
      contentEnc: prompt,
      clientMessageId: run.id,
      expiresAt: '9999-12-31T00:00:00.000Z',
      now: timestamp,
    }),
  );
  set({ messageId, status: 'queued' });
}
export async function tickOwnedSchedules(db: Database, keyring: Keyring, now = new Date()) {
  const owner = requireOwnerRuntime(db),
    snapshot = owner.state.snapshot(),
    timestamp = now.toISOString();
  const candidates = snapshot
    .table('agentSchedules')
    .all()
    .filter(
      (row) =>
        !row.deletedAt &&
        ((row.enabled && row.nextDueAt && row.nextDueAt <= timestamp) ||
          snapshot
            .table('agentScheduleRuns')
            .by('scheduleId', row.id)
            .some((run) => ACTIVE_RUNS.includes(run.status))),
    );
  if (
    !candidates.length ||
    snapshot.table('versions').get('api_disabled')?.version === '1' ||
    snapshot.table('versions').get('agent_messaging_enabled')?.version !== '1'
  )
    return;
  for (const candidate of candidates)
    await mutateOwnerState(owner, {
      kind: 'schedule.advance',
      payload: { id: candidate.id },
      async prepare(context) {
        const schedule = context.draft.table('agentSchedules').get(candidate.id);
        if (!schedule || schedule.deletedAt) return null;
        const freshPrompts = new Map<string, string>();
        const runs = context.draft
          .table('agentScheduleRuns')
          .by('scheduleId', schedule.id)
          .filter((run) => ACTIVE_RUNS.includes(run.status));
        if (schedule.enabled && !runs.length && schedule.nextDueAt && schedule.nextDueAt <= timestamp) {
          const promptEnc = (
            await db
              .select({ encrypted: agentSchedules.promptEnc })
              .from(agentSchedules)
              .where(eq(agentSchedules.id, schedule.id))
          )[0]?.encrypted;
          if (!promptEnc) throw new Error('Schedule prompt is missing');
          const run = {
            id: randomUUID(),
            scheduleId: schedule.id,
            targetAddressId: schedule.targetAddressId,
            promptEnc,
            persistent: schedule.persistent,
            progressTimeoutSeconds: schedule.progressTimeoutSeconds,
            retrySeconds: (schedule.intervalMinutes ?? 5) * 60,
            maxRecoveryAttempts: schedule.maxRecoveryAttempts,
            dueAt: schedule.nextDueAt,
            nextAttemptAt: timestamp,
            createdAt: timestamp,
            updatedAt: timestamp,
            quotaRecovery: null,
            warningAt: null,
            status: 'waiting',
            messageId: null,
            recoveryCount: 0,
            lastError: null,
          };
          context.draft.upsert('agentScheduleRuns', run);
          context.write(async (tx) => {
            await tx.insert(agentScheduleRuns).values(run);
          });
          runs.push(run);
          freshPrompts.set(run.id, promptEnc);
          stageUpdate(context, 'agentSchedules', schedule.id, {
            nextDueAt: nextOccurrence(scheduleInputFrom(schedule), now),
            updatedAt: timestamp,
          });
        }
        for (const run of runs)
          await advance(context, db, keyring, run, now, !!schedule.enabled, freshPrompts.get(run.id));
        return null;
      },
    });
  for (const run of owner.state.snapshot().table('agentScheduleRuns').all())
    if (run.warningAt && !snapshot.table('agentScheduleRuns').get(run.id)?.warningAt)
      wsPublisher.publish('schedules.recovery.warning', {
        schedule_id: run.scheduleId,
        run_id: run.id,
        recovery_count: run.recoveryCount,
      });
  if (owner.state.snapshot().table('agentWatchdogs') !== snapshot.table('agentWatchdogs'))
    wsPublisher.publish('watchdogs.changed', {});
  wsPublisher.publish('schedules.changed', {});
}
export async function sweepOwnedSchedules(db: Database, now = new Date(), actor = 'system:sweep') {
  const owner = requireOwnerRuntime(db),
    swept: { id: string; action: 'expired' | 'paused_agent_gone' }[] = [];
  const snapshot = owner.state.snapshot();
  if (
    snapshot.table('versions').get('api_disabled')?.version === '1' ||
    snapshot.table('versions').get('agent_messaging_enabled')?.version !== '1'
  )
    return swept;
  const grace = now.getTime() - SCHEDULE_TARGET_GRACE_SECONDS * 1000;
  const decision = (state: OwnerMutationContext['draft'], schedule: Schedule) => {
    if (
      schedule.deletedAt ||
      state
        .table('agentWatchdogs')
        .all()
        .some((row) => row.scheduleId === schedule.id)
    )
      return null;
    const target = state.table('agentBusAddresses').get(schedule.targetAddressId);
    const session = target?.currentSessionId
      ? state.table('agentSessions').get(target.currentSessionId)
      : undefined;
    const since = !target
      ? new Date(0).toISOString()
      : (target.archivedAt ??
        (session?.endedAt
          ? [session.endedAt, target.lastSeenAt].sort().at(-1)!
          : session
            ? null
            : target.lastSeenAt));
    const gone = since !== null && Date.parse(since) <= grace;
    const runs = state.table('agentScheduleRuns').by('scheduleId', schedule.id),
      active = runs.some((run) => ACTIVE_RUNS.includes(run.status));
    if (
      schedule.kind === 'once' &&
      schedule.nextDueAt === null &&
      ((!active &&
        Date.parse(
          runs
            .map((run) => run.updatedAt)
            .sort()
            .at(-1) ?? schedule.updatedAt,
        ) <= grace) ||
        (gone && active))
    )
      return 'expired' as const;
    return schedule.enabled && gone && !(schedule.persistent && target && !target.archivedAt)
      ? ('paused_agent_gone' as const)
      : null;
  };
  // Pure decision prevents transactions for schedules with no due retirement.
  const probe = owner.state.begin(snapshot.revision);
  for (const schedule of snapshot.table('agentSchedules').all())
    if (decision(probe, schedule))
      await mutateOwnerState(owner, {
        kind: 'schedule.retire',
        payload: { id: schedule.id },
        prepare(context) {
          const row = context.draft.table('agentSchedules').get(schedule.id);
          if (!row) return null;
          const action = decision(context.draft, row);
          if (!action) return null;
          const timestamp = now.toISOString();
          stageUpdate(context, 'agentSchedules', row.id, {
            enabled: 0,
            ...(action === 'expired' ? { deletedAt: timestamp } : { pauseReason: 'agent_gone' }),
            version: row.version + 1,
            updatedBy: actor,
            updatedAt: timestamp,
          });
          stageCancelScheduled(context, row.id, timestamp);
          adminAudit(context, `schedule.${action}`, { schedule_id: row.id, actor }, timestamp);
          swept.push({ id: row.id, action });
          return null;
        },
      });
  if (swept.length) wsPublisher.publish('schedules.changed', {});
  return swept;
}

export async function validateOwnedSchedule(
  context: OwnerMutationContext,
  db: Database,
  input: ScheduleInput,
) {
  const target = context.draft.table('agentBusAddresses').get(input.target.slice(6).toLowerCase());
  if (!target || !isEngine(target.engine) || target.archivedAt)
    throw new ValidationError('Target must be an existing agent address');
  if (
    input.enabled &&
    input.persistent &&
    context.draft
      .table('agentRebootHandoffs')
      .by('addressId', target.id)
      .some((row) => ['prepared', 'armed'].includes(row.status))
  )
    throw new ConflictError('Reboot recovery is active', 'reboot_recovery_active');
  if (input.persistent && (!target.lastUpstreamSessionId || target.continuity !== 'native'))
    throw new ValidationError('Persistent recovery requires a known native session');
  if (input.enabled && input.persistent) {
    const daemon = context.draft.table('hostDaemons').get(target.hostId);
    if (!daemon || !daemonResidentFor(daemon.settings, target.username))
      throw new ForbiddenError(
        'Persistent schedules need a persistent host; this agent runs on a normal host',
        'schedule_host_not_persistent',
      );
  }
}
export async function mutateOwnedSchedule(
  db: Database,
  keyring: Keyring,
  action: 'create' | 'update' | 'remove',
  id: string,
  actor: string,
  input: unknown,
  version?: number,
) {
  const owner = requireOwnerRuntime(db);
  await mutateOwnerState(owner, {
    kind: `schedule.${action}`,
    payload: { id, actor },
    async prepare(context) {
      const now = new Date(),
        timestamp = now.toISOString();
      const current = context.draft.table('agentSchedules').get(id);
      if (action !== 'create') {
        if (!current || current.deletedAt)
          throw new NotFoundError('Schedule not found', 'schedule_not_found');
        if (
          context.draft
            .table('agentWatchdogs')
            .all()
            .some((row) => row.scheduleId === id)
        )
          throw new ForbiddenError('Manage recovery through watchdog tools', 'watchdog_schedule_managed');
        if (current.version !== version)
          throw new ConflictError('Schedule changed; retrieve again', 'schedule_version_conflict');
      }
      if (action === 'remove') {
        stageUpdate(context, 'agentSchedules', id, {
          enabled: 0,
          deletedAt: timestamp,
          version: version! + 1,
          updatedBy: actor,
          updatedAt: timestamp,
        });
        stageCancelScheduled(context, id, timestamp);
        adminAudit(context, 'schedule.deleted', { schedule_id: id, actor }, timestamp);
        return null;
      }
      const patch = input as Record<string, unknown>;
      const previousPrompt = current
        ? (
            await db
              .select({ prompt: agentSchedules.promptEnc })
              .from(agentSchedules)
              .where(eq(agentSchedules.id, id))
          )[0]?.prompt
        : undefined;
      const values = scheduleInput.parse(
        current
          ? { ...scheduleInputFrom(current), prompt: decrypt(previousPrompt!, keyring), ...patch }
          : input,
      );
      await validateOwnedSchedule(context, db, values);
      const timingChanged =
        action === 'create' ||
        ['kind', 'at', 'cron', 'interval_minutes', 'timezone'].some((key) => key in patch) ||
        (values.enabled && !current?.enabled);
      if (timingChanged && values.kind === 'once' && Date.parse(values.at!) <= now.getTime())
        throw new ValidationError('Wake time must be in the future');
      const nextDueAt = timingChanged
        ? values.kind === 'once'
          ? new Date(values.at!).toISOString()
          : nextOccurrence(values, now)
        : current!.nextDueAt;
      const row = {
        id,
        name: values.name,
        targetAddressId: values.target.slice(6).toLowerCase(),
        promptEnc: encrypt(values.prompt, keyring),
        kind: values.kind,
        atTime: values.at ? new Date(values.at).toISOString() : null,
        cronExpression: values.cron ?? null,
        intervalMinutes: values.interval_minutes ?? null,
        timezone: values.timezone,
        enabled: Number(values.enabled),
        persistent: Number(values.persistent),
        progressTimeoutSeconds: values.progress_timeout_seconds ?? null,
        maxRecoveryAttempts: values.max_recovery_attempts ?? null,
        nextDueAt,
        pauseReason: values.enabled ? null : (current?.pauseReason ?? null),
        version: current ? current.version + 1 : 1,
        deletedAt: null,
        createdBy: current?.createdBy ?? actor,
        updatedBy: actor,
        createdAt: current?.createdAt ?? timestamp,
        updatedAt: timestamp,
      };
      if (current) stageUpdate(context, 'agentSchedules', id, row);
      else {
        context.draft.upsert('agentSchedules', row);
        context.write(async (tx) => {
          await tx.insert(agentSchedules).values(row);
        });
      }
      if (!values.enabled) stageCancelScheduled(context, id, timestamp);
      adminAudit(
        context,
        action === 'create' ? 'schedule.created' : 'schedule.updated',
        { schedule_id: id, actor },
        timestamp,
      );
      return null;
    },
  });
}
