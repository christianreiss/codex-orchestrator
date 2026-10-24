import type { Database } from '../../db/client.js';
import { requireOwnerRuntime, mutateOwnerState } from '../../control-plane/state/runtime.js';
import { stageStopWatchdog } from '../../control-plane/state/session-lifecycle.js';
import type { OwnerStateSnapshot } from '../../control-plane/state/store.js';
import type { StateRow } from '../../control-plane/state/catalog.js';
import { quotaRecoveryAllowed } from '../quota-observation.js';
import { messagingHostEligible } from '../agent-messaging/eligibility.js';
import { activeHostEngines } from '../host-engine-policy.js';
import { readFleetEngineState } from '../engine-switch.js';
import { isEngine } from '../../util/engine.js';
import { wsPublisher } from '../../ws/publisher.js';

/** Presence is evidence of an attachment, never evidence that a detached native
 * process exited. Only explicit outcomes or a real business deadline stop here. */
export async function tickOwnedWatchdogs(db: Database, now = new Date()) {
  const owner = requireOwnerRuntime(db),
    timestamp = now.toISOString();
  async function decision(
    state: OwnerStateSnapshot,
    row: Readonly<StateRow<'agentWatchdogs'>>,
  ): Promise<{ status: string; reason: string } | null> {
    if (!['watching', 'recovering', 'capacity_wait'].includes(row.status)) return null;
    if (row.deadlineAt <= timestamp) return { status: 'expired', reason: 'deadline' };
    const target = state.addresses.get(row.targetAddressId),
      host = target ? state.hosts.get(target.hostId) : undefined;
    if (
      !target ||
      !host ||
      !target.enabled ||
      target.archivedAt ||
      !isEngine(target.engine) ||
      !messagingHostEligible(host) ||
      !activeHostEngines(host.engines, await readFleetEngineState(db)).includes(target.engine) ||
      state.table('versions').get('api_disabled')?.version === '1' ||
      state.table('versions').get('agent_messaging_enabled')?.version !== '1'
    )
      return { status: 'blocked', reason: 'target_unavailable' };
    if (
      row.quotaAccountId &&
      !(await quotaRecoveryAllowed(db, target.engine, row.quotaAccountId, row.quotaWindow))
    )
      return { status: 'blocked', reason: 'quota_policy_disabled' };
    if (target.lastUpstreamSessionId !== row.nativeSessionId || target.continuity !== 'native')
      return { status: 'blocked', reason: 'native_session_changed' };
    const original = row.messageId ? state.table('agentBusMessages').get(row.messageId) : undefined;
    if (original?.taskResultStatus || original?.status === 'canceled' || original?.cancelRequestedAt)
      return { status: 'completed', reason: original.taskResultStatus ?? 'user_stop' };
    const run = [...state.table('agentScheduleRuns').by('scheduleId', row.scheduleId)].sort((a, b) =>
      b.createdAt.localeCompare(a.createdAt),
    )[0];
    if (run && ['completed', 'blocked', 'dead', 'canceled'].includes(run.status)) {
      const message = run.messageId ? state.table('agentBusMessages').get(run.messageId) : undefined;
      return {
        status: run.status === 'completed' ? 'completed' : 'blocked',
        reason: message?.taskResultStatus ?? run.lastError ?? 'unknown',
      };
    }
    const session = state.sessions.get(target.currentSessionId ?? row.sessionId);
    return session?.closeRequestedAt ? { status: 'disabled', reason: 'user_stop' } : null;
  }
  let changed = false;
  for (const row of owner.state.snapshot().table('agentWatchdogs').all()) {
    if (!(await decision(owner.state.snapshot(), row))) continue;
    await mutateOwnerState(owner, {
      kind: 'watchdog.reconcile',
      payload: { id: row.id },
      async prepare(context) {
        const current = context.snapshot.table('agentWatchdogs').get(row.id);
        if (!current) return null;
        const result = await decision(context.snapshot, current);
        if (!result) return null;
        stageStopWatchdog(context, current, result.status, result.reason, timestamp);
        changed = true;
        return null;
      },
    });
  }
  if (changed) wsPublisher.publish('watchdogs.changed', {});
}
