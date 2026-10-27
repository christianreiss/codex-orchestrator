import type { OwnerStateSnapshot } from '../state/store.js';
import type { StateRow } from '../state/catalog.js';
import { DEFAULT_QUOTA_POLICY, quotaPolicySchema } from '../../services/quota-policy.js';

import { supervisorCanMonitor } from '../../services/agent-supervisor/policy.js';

const live = ['watching', 'recovering', 'capacity_wait'];
const active = ['waiting', 'queued', 'leased', 'accepted', 'recovering', 'capacity_wait'];
const timeoutOrder = (
  a: { progressTimeoutSeconds: number | null },
  b: { progressTimeoutSeconds: number | null },
) => (a.progressTimeoutSeconds ?? -1) - (b.progressTimeoutSeconds ?? -1);
export function schedulePolicy(s: OwnerStateSnapshot, session: StateRow<'agentSessions'>) {
  const address = session.agentBusAddressId && s.addresses.get(session.agentBusAddressId);
  if (
    !address ||
    !address.enabled ||
    address.archivedAt ||
    address.currentSessionId !== session.id ||
    s.setting('agent_messaging_enabled') !== '1'
  )
    return { progress_timeout_seconds: null };
  const watchdogSchedules = new Set(
    s
      .table('agentWatchdogs')
      .all()
      .map((w) => w.scheduleId),
  );
  const schedules = s
    .table('agentSchedules')
    .by('targetAddressId', address.id)
    .filter((v) => v.enabled === 1 && v.persistent === 1 && !v.deletedAt && !watchdogSchedules.has(v.id));
  const enabled = new Set(schedules.map((v) => v.id));
  const runs = s
    .table('agentScheduleRuns')
    .by('targetAddressId', address.id)
    .filter(
      (v) =>
        v.persistent === 1 &&
        active.includes(v.status) &&
        enabled.has(v.scheduleId) &&
        (session.activeTurnId !== null ||
          (!!v.messageId && s.messages.get(v.messageId)?.status === 'accepted')),
    )
    .sort(timeoutOrder);
  const schedule = [...schedules].sort(timeoutOrder)[0];
  const timeout =
    runs[0]?.progressTimeoutSeconds ??
    (session.activeTurnId && schedule?.nextDueAt ? schedule.progressTimeoutSeconds : null);
  const prompt = s
    .table('agentPrompts')
    .by('sessionId', session.id)
    .some((p) => p.status === 'open');
  return { progress_timeout_seconds: prompt ? null : timeout, binding_generation: address.bindingGeneration };
}

function quotaAllowed(
  s: OwnerStateSnapshot,
  engine: string,
  accountId: number | null,
  window: string | null,
) {
  if (!accountId) return true;
  const read = (key: string) => {
    const raw = s.setting(key);
    if (!raw) return null;
    try {
      return quotaPolicySchema.parse(JSON.parse(raw));
    } catch {
      return { ...DEFAULT_QUOTA_POLICY, short_auto_resume: false, long_auto_resume: false };
    }
  };
  const policy =
    read(`quota_policy_account_${accountId}`) ?? read(`quota_policy_${engine}`) ?? DEFAULT_QUOTA_POLICY;
  return !policy.unlimited && (window === 'short' ? policy.short_auto_resume : policy.long_auto_resume);
}
export function watchdogPolicy(s: OwnerStateSnapshot, session: StateRow<'agentSessions'>, now = Date.now()) {
  const row = session.agentBusAddressId
    ? s
        .table('agentWatchdogs')
        .by('targetAddressId', session.agentBusAddressId)
        .find((w) => w.nativeSessionId === (session.upstreamSessionId ?? '') && live.includes(w.status))
    : undefined;
  const prompt = s
    .table('agentPrompts')
    .by('sessionId', session.id)
    .some((p) => p.status === 'open');
  const allowed =
    !!row &&
    quotaAllowed(s, session.engine, row.quotaAccountId, row.quotaWindow) &&
    Date.parse(row.deadlineAt) > now &&
    !prompt &&
    (row?.createdBy !== 'supervisor' || supervisorCanMonitor(s, session));
  const run = row
    ? [...s.table('agentScheduleRuns').by('scheduleId', row.scheduleId)].sort((a, b) =>
        b.createdAt.localeCompare(a.createdAt),
      )[0]
    : undefined;
  const schedule = row ? s.table('agentSchedules').get(row.scheduleId) : undefined;
  const message = run?.messageId ? s.messages.get(run.messageId) : undefined;
  return {
    watchdog: row
      ? {
          id: row.id,
          target: `agent:${row.targetAddressId}`,
          native_session_id: row.nativeSessionId,
          task_key: row.taskKey,
          quota: row.quotaAccountId
            ? {
                account_id: row.quotaAccountId,
                window: row.quotaWindow,
                reset_at: row.quotaResetAt,
                attempts: row.quotaAttempts,
                last_attempt_at: row.quotaAttemptAt,
              }
            : null,
          status: run?.status === 'capacity_wait' ? 'capacity_wait' : row.status,
          version: row.version,
          deadline_at: row.deadlineAt,
          progress_timeout_seconds: row.progressTimeoutSeconds,
          last_progress_at: row.lastProgressAt,
          last_error: run?.lastError ?? row.lastError ?? null,
          last_wake_at: message?.acceptedAt ?? null,
          next_wake_at:
            run && ['recovering', 'capacity_wait', 'waiting', 'queued', 'leased'].includes(run.status)
              ? run.nextAttemptAt
              : (schedule?.nextDueAt ?? null),
          recovery_count: run ? run.recoveryCount + 1 : 0,
          recovery_status: run?.status ?? null,
          created_by: row.createdBy,
        }
      : null,
    progress_timeout_seconds: allowed ? row!.progressTimeoutSeconds : null,
    terminate_requested:
      allowed &&
      row!.sessionId === session.id &&
      !session.closeRequestedAt &&
      ['capacity', 'hang', 'crash'].includes(row!.lastError ?? ''),
    supervisor: row?.createdBy === 'supervisor',
    binding_generation: session.bindingGeneration ?? 0,
  };
}
