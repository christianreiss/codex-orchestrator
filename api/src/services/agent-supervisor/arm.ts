import { randomUUID } from 'node:crypto';
import type { OwnerMutationContext } from '../../control-plane/state/runtime.js';
import type { StateRow } from '../../control-plane/state/catalog.js';
import { agentSchedules, agentWatchdogs, agentWorkStates } from '../../db/schema.js';
import { encrypt } from '../../security/secret-box.js';
import { sha256 } from '../../security/hash.js';
import type { Keyring } from '../../security/keyring.js';
import { daemonResidentFor } from '../host-daemon/policy.js';
import { supervisorEnabled, SUPERVISOR, WORK_LIVE } from './policy.js';
import { stageUpdate } from '../../control-plane/state/rows.js';

/** Atomic arm: the watchdog and its supervisor link never commit separately. */
export function stageSupervisorArm(
  ctx: OwnerMutationContext,
  session: StateRow<'agentSessions'>,
  keyring: Keyring,
  now: string,
) {
  const state = ctx.draft.view(),
    target = session.agentBusAddressId ? state.addresses.get(session.agentBusAddressId) : undefined;
  if (
    !supervisorEnabled(state) ||
    !target ||
    target.currentSessionId !== session.id ||
    session.endedAt ||
    session.closeRequestedAt ||
    !session.upstreamSessionId ||
    target.lastUpstreamSessionId !== session.upstreamSessionId
  )
    return;
  const caps = session.adapterCapabilities as Record<string, unknown> | null,
    daemon = state.table('hostDaemons').get(session.hostId);
  if (
    caps?.supervisor_protocol_version !== 1 ||
    typeof caps.supervisor_model !== 'string' ||
    !caps.supervisor_model.trim() ||
    !daemon ||
    !daemonResidentFor(daemon.settings, session.username)
  )
    return;
  const current = state
    .table('agentWatchdogs')
    .by('targetAddressId', target.id)
    .find((w) => ['watching', 'recovering', 'capacity_wait'].includes(w.status));
  if (current) return current;
  if (
    state
      .table('agentScheduleRuns')
      .by('targetAddressId', target.id)
      .some(
        (r) =>
          r.persistent &&
          ['waiting', 'queued', 'leased', 'accepted', 'recovering', 'capacity_wait'].includes(r.status),
      )
  )
    return;
  let work = state.table('agentWorkStates').get(target.id);
  if (
    work &&
    work.nativeSessionId === session.upstreamSessionId &&
    (work.paused || work.escalation || !WORK_LIVE.includes(work.state) || work.watchdogId)
  )
    return;
  const id = randomUUID(),
    scheduleId = randomUUID();
  if (!work || work.nativeSessionId !== session.upstreamSessionId) {
    work = {
      addressId: target.id,
      sessionId: session.id,
      bindingGeneration: session.bindingGeneration,
      nativeSessionId: session.upstreamSessionId,
      turnId: session.activeTurnId,
      model: typeof caps?.supervisor_model === 'string' ? caps.supervisor_model : null,
      taskKey: session.activeTurnId ? `turn:${session.activeTurnId}` : `native:${session.upstreamSessionId}`,
      state: 'working',
      reason: null,
      waitingForAddressId: null,
      waitingForMessageId: null,
      coordinatorAddressId: null,
      lastProgressAt: now,
      reminderAt: null,
      incidentAt: null,
      deadlineAt: null,
      paused: 0,
      escalation: null,
      watchdogId: null,
      version: (work?.version ?? 0) + 1,
      updatedAt: now,
    };
    if (state.table('agentWorkStates').has(target.id)) stageUpdate(ctx, 'agentWorkStates', target.id, work);
    else {
      ctx.draft.upsert('agentWorkStates', work);
      const row = work;
      ctx.write(async (tx) => tx.insert(agentWorkStates).values(row));
    }
  }
  const taskKey = `supervisor:${id}`,
    continuation =
      'Continue only the unfinished authorized task in this exact native transcript, model and cwd. Preserve native subagents, original work IDs and idempotency checks. Refresh agent_self and agent_work_state. If finished or canceled, report the outcome and stop recovery.';
  const promptEnc = encrypt(
    `WATCHDOG/1 ${id}. Read watchdog_get for the current version; call watchdog_finish when this task ends and report any original work receipts.\n\n${continuation}`,
    keyring,
  );
  const schedule = {
    id: scheduleId,
    name: `Supervisor ${target.launchName ?? target.id}`.slice(0, 120),
    targetAddressId: target.id,
    promptEnc,
    kind: 'once',
    timezone: 'Europe/Berlin',
    persistent: 1,
    enabled: 1,
    progressTimeoutSeconds: SUPERVISOR.hangSeconds,
    maxRecoveryAttempts: SUPERVISOR.attempts - 1,
    nextDueAt: null,
    atTime: null,
    cronExpression: null,
    intervalMinutes: null,
    pauseReason: null,
    deletedAt: null,
    version: 1,
    createdBy: 'supervisor',
    updatedBy: 'supervisor',
    createdAt: now,
    updatedAt: now,
  };
  const dog = {
    id,
    targetAddressId: target.id,
    nativeSessionId: session.upstreamSessionId,
    sessionId: session.id,
    taskKey,
    messageId: null,
    scheduleId,
    continuationSha: sha256(continuation),
    // Healthy observation has no recovery budget. The first failure installs a fixed two-hour deadline.
    deadlineAt: '9999-12-31T00:00:00.000Z',
    progressTimeoutSeconds: SUPERVISOR.hangSeconds,
    lastProgressAt: now,
    createdBy: 'supervisor',
    createdAt: now,
    updatedAt: now,
    status: 'watching',
    version: 1,
    lastError: null,
    quotaAccountId: null,
    quotaWindow: null,
    quotaResetAt: null,
    quotaAttempts: 0,
    quotaAttemptAt: null,
  };
  ctx.draft.upsert('agentSchedules', schedule);
  ctx.draft.upsert('agentWatchdogs', dog);
  stageUpdate(ctx, 'agentWorkStates', target.id, { watchdogId: id, version: work.version + 1 });
  ctx.write(async (tx) => {
    await tx.insert(agentSchedules).values(schedule);
    await tx.insert(agentWatchdogs).values(dog);
  });
  return dog;
}
