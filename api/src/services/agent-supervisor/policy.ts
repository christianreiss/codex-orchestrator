import type { StateRow } from '../../control-plane/state/catalog.js';
import type { OwnerStateSnapshot } from '../../control-plane/state/store.js';

export const SUPERVISOR = {
  reminderSeconds: 600,
  hangSeconds: 900,
  durationSeconds: 7200,
  attempts: 5,
} as const;
export const WORK_LIVE = ['working', 'waiting_agent', 'waiting_user'];
export type Work = StateRow<'agentWorkStates'>;
export const observedNativeTask = (work: Work) =>
  work.taskKey === `native:${work.nativeSessionId}` ||
  (!!work.turnId && work.taskKey === `turn:${work.turnId}`);

/** Idle native transport is not a result receipt for accepted or uncertain work. */
export function supervisorHasOutstandingWork(s: OwnerStateSnapshot, addressId: string): boolean {
  const unresolved = (m: StateRow<'agentBusMessages'>) => !!m.workKind &&
    (!m.taskResultStatus || m.taskResultStatus === 'unknown') &&
    (!!m.acceptedAt || ['leased', 'accepted', 'ambiguous', 'reboot_hold'].includes(m.status));
  if (s.messages.by('targetAddressId', addressId).some(unresolved) ||
      s.messages.by('senderAddressId', addressId).some(unresolved)) return true;
  if (s.table('agentScheduleRuns').by('targetAddressId', addressId).some(run => ['leased', 'accepted'].includes(run.status))) return true;
  const nativeId = s.table('agentWorkStates').get(addressId)?.nativeSessionId;
  for (const session of s.sessions.by('agentBusAddressId', addressId)) {
    if (nativeId && session.upstreamSessionId !== nativeId) continue;
    if (s.table('agentMessages').by('sessionId', session.id).some(m => ['leased', 'accepted', 'reboot_hold'].includes(m.status)) ||
        s.table('agentPrompts').by('sessionId', session.id).some(p => p.status === 'open')) return true;
  }
  if (s.table('workflowRunTasks').by('claimOwnerAddressId', addressId).some(task => ['claimed', 'running'].includes(task.status))) return true;
  return s.table('workflowRuns').by('coordinatorAddressId', addressId).some(run =>
    s.table('workflowRunTasks').by('runId', run.id).some(task => ['claimed', 'running'].includes(task.status)));
}
export function supervisorEnabled(s: OwnerStateSnapshot) {
  return (
    s.setting('agent_supervisor_enabled') === '1' &&
    s.setting('api_disabled') !== '1' &&
    s.setting('agent_messaging_enabled') === '1'
  );
}
export function waitCycle(s: OwnerStateSnapshot, start: string): boolean {
  const seen = new Set<string>();
  let id: string | null = start;
  while (id) {
    if (seen.has(id)) return id === start;
    seen.add(id);
    const work = s.table('agentWorkStates').get(id);
    id = work?.state === 'waiting_agent' && !work.paused ? work.waitingForAddressId : null;
  }
  return false;
}
/** Missing observer evidence never authorizes termination of an interactive idle session. */
export function supervisorCanMonitor(s: OwnerStateSnapshot, session: StateRow<'agentSessions'>) {
  if (!supervisorEnabled(s) || session.endedAt || session.closeRequestedAt) return false;
  const work = session.agentBusAddressId
    ? s.table('agentWorkStates').get(session.agentBusAddressId)
    : undefined;
  if (
    !work ||
    work.paused ||
    work.escalation ||
    work.nativeSessionId !== session.upstreamSessionId ||
    work.sessionId !== session.id ||
    work.bindingGeneration !== session.bindingGeneration ||
    work.state !== 'working'
  )
    return false;
  const activity = session.activity as {
    state?: string;
    native_session_id?: string;
    binding_generation?: number;
  } | null;
  // Any observed user/approval wait protects the process, even when its evidence is old.
  if (activity?.state === 'waiting' || activity?.state === 'idle') return false;
  return (
    !!session.activeTurnId ||
    (activity?.state === 'working' &&
      activity.native_session_id === session.upstreamSessionId &&
      activity.binding_generation === session.bindingGeneration)
  );
}
export function recoveryBudget(work: Work, count: number, now: number): string | null {
  if (work.paused) return 'paused';
  if (work.deadlineAt && Date.parse(work.deadlineAt) <= now) return 'recovery_deadline';
  if (count >= SUPERVISOR.attempts) return 'recovery_limit';
  return null;
}
