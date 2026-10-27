import { randomUUID } from 'node:crypto';
import { agentBusAddresses, type AgentSession } from '../../db/schema.js';
import { ConflictError } from '../../http/errors.js';
import { WATCHDOG_LIVE, watchdogRetryTime, type WatchdogFailure } from '../../services/watchdog-lifecycle.js';
import type { StateRow } from './catalog.js';
import { stageEndNames, stageLaunchName } from './names.js';
import { stageUpdate } from './rows.js';
import type { OwnerMutationContext } from './runtime.js';
import type { OwnerRuntime } from './runtime.js';
import { ownerPresence } from '../presence.js';

export function assertOwnedHousekeeping(context: OwnerMutationContext, hostId: number, engine: string): void {
  if (
    context.draft
      .table('sessionHousekeepingReservations')
      .by('hostId', hostId)
      .some((row) => row.engine === engine)
  )
    throw new ConflictError('Session housekeeping is in progress', 'session_housekeeping_busy');
}

export function stageNativeIdentity(
  context: OwnerMutationContext,
  session: AgentSession,
  nativeId: string,
  now: string,
  runtime?: OwnerRuntime,
) {
  assertOwnedHousekeeping(context, session.hostId, session.engine);
  const { draft } = context;
  const current =
    session.agentBusAddressId && draft.table('agentBusAddresses').get(session.agentBusAddressId);
  if (!current || current.currentSessionId !== session.id || current.archivedAt || current.enabled !== 1)
    throw new ConflictError('Address binding changed', 'receiver_binding_changed');
  if (current.lastUpstreamSessionId === nativeId) return current;
  const known = draft
    .table('agentBusAddresses')
    .by('hostId', session.hostId)
    .filter(
      (row) =>
        row.engine === session.engine &&
        row.username === session.username &&
        row.lastUpstreamSessionId === nativeId &&
        row.enabled === 1 &&
        !row.archivedAt,
    )
    .sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt))[0];
  if (known?.currentSessionId && known.currentSessionId !== session.id)
    throw new ConflictError(
      'Native transcript is already bound to another lifecycle',
      'agent_messaging_address_busy',
    );
  if (!known && !current.lastUpstreamSessionId) return current;
  const control = draft.table('agentNativeControls').get(session.id);
  if (
    control &&
    (control.status !== 'ready' ||
      control.requestId ||
      !runtime ||
      !ownerPresence(runtime)
        .session(session.id, session.bindingGeneration, 'session')
        .some((attachment) => attachment.scope.native_instance_id === control.instanceId))
  )
    throw new ConflictError(
      'Native identity change requires its live process and no pending stop',
      'native_identity_change_unavailable',
    );
  stageUpdate(context, 'agentBusAddresses', current.id, {
    currentSessionId: null,
    receiveHeartbeatAt: null,
    readiness: current.lastUpstreamSessionId ? 'resumable' : 'offline',
    updatedAt: now,
  });
  const id = randomUUID();
  const next = known
    ? stageUpdate(context, 'agentBusAddresses', known.id, {
        currentSessionId: session.id,
        bindingGeneration: known.bindingGeneration + 1,
        continuity: 'native',
        receiveHeartbeatAt: null,
        lastSeenAt: now,
        updatedAt: now,
        adapterProtocol: current.adapterProtocol,
        adapterCapabilities: current.adapterCapabilities,
      })
    : {
        ...current,
        id,
        address: `agent:${id}`,
        displayAlias: null,
        lastUpstreamSessionId: nativeId,
        bindingGeneration: 1,
        continuity: 'native',
        receiveHeartbeatAt: null,
        createdAt: now,
        updatedAt: now,
        lastSeenAt: now,
      };
  if (!known) {
    draft.upsert('agentBusAddresses', next);
    context.write(async (tx) => {
      await tx.insert(agentBusAddresses).values(next);
    });
  }
  stageUpdate(context, 'agentSessions', session.id, {
    agentBusAddressId: next.id,
    bindingGeneration: next.bindingGeneration,
  });
  if (control)
    stageUpdate(context, 'agentNativeControls', session.id, {
      bindingGeneration: next.bindingGeneration,
      updatedAt: now,
    });
  if (!draft.table('agentNameLeases').by('sessionId', session.id).length)
    return { ...next, launchName: null };
  const launchName = stageLaunchName(context, session.id, next.id, now);
  stageUpdate(context, 'agentSessions', session.id, { launchName });
  return stageUpdate(context, 'agentBusAddresses', next.id, { launchName });
}

export function stageStopWatchdog(
  context: OwnerMutationContext,
  row: StateRow<'agentWatchdogs'>,
  status: string,
  reason: string,
  now: string,
): void {
  stageUpdate(context, 'agentWatchdogs', row.id, {
    status,
    lastError: reason,
    version: row.version + 1,
    updatedAt: now,
  });
  const schedule = context.draft.table('agentSchedules').get(row.scheduleId);
  if (schedule)
    stageUpdate(context, 'agentSchedules', schedule.id, {
      enabled: 0,
      nextDueAt: null,
      pauseReason: reason,
      version: schedule.version + 1,
      updatedAt: now,
    });
  for (const run of context.draft.table('agentScheduleRuns').by('scheduleId', row.scheduleId)) {
    const message = run.messageId ? context.draft.table('agentBusMessages').get(run.messageId) : undefined;
    // An offer can have reached native execution before its acceptance ACK.
    // Stopping future recovery never revokes that outstanding execution proof.
    if (
      (message && ['leased', 'accepted', 'reboot_hold', 'ambiguous'].includes(message.status)) ||
      ['leased', 'accepted', 'completed'].includes(run.status)
    )
      continue;
    if (message?.status === 'queued')
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

export function stageSessionWatchdogs(
  context: OwnerMutationContext,
  session: AgentSession,
  status: 'completed' | 'failed',
  failure: WatchdogFailure | undefined,
  now: string,
): void {
  if (session.invocationKind === 'peer_delivery' || !session.agentBusAddressId || !session.upstreamSessionId)
    return;
  const target = context.draft.table('agentBusAddresses').get(session.agentBusAddressId);
  if (
    !target ||
    target.currentSessionId !== session.id ||
    target.lastUpstreamSessionId !== session.upstreamSessionId ||
    target.bindingGeneration !== session.bindingGeneration
  )
    return;
  const cause = failure ?? (status === 'completed' ? 'user_stop' : 'crash');
  for (const row of context.draft.table('agentWatchdogs').by('targetAddressId', target.id)) {
    if (row.nativeSessionId !== session.upstreamSessionId || !WATCHDOG_LIVE.includes(row.status)) continue;
    if (row.deadlineAt <= now) stageStopWatchdog(context, row, 'expired', 'deadline', now);
    else if (cause === 'user_stop' || cause === 'blocked')
      stageStopWatchdog(
        context,
        row,
        cause === 'user_stop' ? 'disabled' : 'blocked',
        cause === 'user_stop' ? 'user_stop' : 'provider_error',
        now,
      );
    else if (row.status === 'watching') {
      if (row.createdBy === 'supervisor') {
        const work = context.draft.table('agentWorkStates').get(target.id);
        if (work && !work.incidentAt) {
          const deadlineAt = new Date(Date.parse(now) + 7200000).toISOString();
          stageUpdate(context, 'agentWorkStates', work.addressId, {incidentAt:now,deadlineAt});
          stageUpdate(context, 'agentWatchdogs', row.id, {deadlineAt});
        }
      }
      const at = watchdogRetryTime(new Date(now));
      stageUpdate(context, 'agentWatchdogs', row.id, {
        status: cause === 'capacity' ? 'capacity_wait' : 'recovering',
        lastError: cause,
        updatedAt: now,
      });
      if (context.draft.table('agentSchedules').has(row.scheduleId))
        stageUpdate(context, 'agentSchedules', row.scheduleId, { atTime: at, nextDueAt: at, updatedAt: now });
    }
  }
}

export function stageSessionFinish(
  context: OwnerMutationContext,
  session: AgentSession,
  status: 'completed' | 'failed',
  now: string,
  failure?: WatchdogFailure,
): void {
  const { draft } = context;
  if (
    !session.closeRequestedAt &&
    draft
      .table('agentRebootHandoffs')
      .by('oldSessionId', session.id)
      .some((row) => row.status === 'armed')
  )
    return;
  stageSessionWatchdogs(context, session, status, failure, now);
  stageUpdate(context, 'agentSessions', session.id, {
    status,
    endedAt: session.endedAt ?? now,
    receiveHeartbeatAt: null,
    adapterProtocol: null,
    adapterCapabilities: null,
    updatedAt: now,
  });
  const bound = session.agentBusAddressId
    ? draft.table('agentBusAddresses').get(session.agentBusAddressId)
    : undefined;
  if (bound?.currentSessionId === session.id) {
    for (const message of draft.table('agentBusMessages').by('targetAddressId', bound.id)) {
      if (['queued', 'leased'].includes(message.status) && message.kind !== 'presence_notice')
        stageUpdate(context, 'agentBusMessages', message.id, { awaitingPresence: 1 });
    }
    stageUpdate(context, 'agentBusAddresses', bound.id, {
      currentSessionId: null,
      readiness: session.upstreamSessionId ? 'resumable' : 'offline',
      receiveHeartbeatAt: null,
      lastUpstreamSessionId: session.upstreamSessionId,
      lastSeenAt: now,
      updatedAt: now,
    });
  }
  if (session.agentBusAddressId)
    for (const message of draft.table('agentBusMessages').by('targetAddressId', session.agentBusAddressId)) {
      if (
        message.kind !== 'presence_notice' ||
        !['queued', 'leased', 'accepted', 'batched'].includes(message.status)
      )
        continue;
      const target = message.targetSessionId
        ? draft.table('agentSessions').get(message.targetSessionId)
        : undefined;
      const address = draft.table('agentBusAddresses').get(message.targetAddressId);
      if (target && !target.endedAt && address?.currentSessionId === target.id) continue;
      stageUpdate(context, 'agentBusMessages', message.id, {
        status: 'canceled',
        canceledAt: now,
        leaseOwner: null,
        leaseUntil: null,
        lastErrorCode: 'presence_notice_session_ended',
        updatedAt: now,
      });
    }
  stageEndNames(context, session.id, session.endedAt ?? now);
}
