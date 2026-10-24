import { legacyDrainFor } from '../legacy-drain.js';
import { randomUUID } from 'node:crypto';
import { agentNativeControls } from '../../db/schema.js';
import { ConflictError, NotFoundError } from '../../http/errors.js';
import type { OwnerRuntime } from '../state/runtime.js';
import { mutateOwnerState } from '../state/runtime.js';
import { stageUpdate } from '../state/rows.js';
import { stageStopWatchdog } from '../state/session-lifecycle.js';
import { ownerPresence } from '../presence.js';
import { WATCHDOG_LIVE } from '../../services/watchdog-lifecycle.js';
import { ownedEngineState } from '../state/messaging.js';
import { isEngine } from '../../util/engine.js';
import type { OwnerStateSnapshot } from '../state/store.js';
import type { StateRow } from '../state/catalog.js';
import type { Json } from '../commands.js';

export function ownedControlView(owner: OwnerRuntime, row: StateRow<'agentNativeControls'> | undefined) {
  owner.assertOwner();
  if (!row) return null;
  const attached =
    ownerPresence(owner)
      .session(row.sessionId, row.bindingGeneration, 'session')
      .some((a) => a.scope.native_instance_id === row.instanceId) ||
    Boolean(legacyDrainFor(owner)?.session(row.sessionId, row.bindingGeneration, row.instanceId));
  return {
    instance_id: row.instanceId,
    binding_generation: row.bindingGeneration,
    status:
      row.requestId && !attached && ['requested', 'accepted'].includes(row.status) ? 'unknown' : row.status,
    request_id: row.requestId,
    available: attached && row.status === 'ready',
    updated_at: row.updatedAt,
  };
}
function binding(s: OwnerStateSnapshot, id: string) {
  const session = s.sessions.get(id);
  if (!session) throw new NotFoundError('Session not found');
  if (session.agentBusAddressId) {
    const a = s.addresses.get(session.agentBusAddressId);
    if (!a || a.currentSessionId !== id || a.bindingGeneration !== session.bindingGeneration)
      throw new ConflictError('Session binding changed', 'native_stop_binding_changed');
  }
  return session;
}
const answer = (row: StateRow<'agentNativeControls'>) => ({
  request_id: ['requested', 'accepted'].includes(row.status) ? row.requestId : null,
  instance_id: row.instanceId,
  binding_generation: row.bindingGeneration,
});
function checked(
  s: OwnerStateSnapshot,
  id: string,
  instance: string,
  report?: { request_id: string; status: 'accepted' | 'exited' | 'refused' },
) {
  const session = binding(s, id),
    row = s.table('agentNativeControls').get(id);
  if (row && (row.instanceId !== instance || row.bindingGeneration !== session.bindingGeneration))
    throw new ConflictError('Native process binding changed', 'native_stop_binding_changed');
  if (!row && (session.endedAt || report))
    throw new ConflictError('Session already ended', 'native_stop_ended');
  if (report && (!row?.requestId || report.request_id !== row.requestId))
    throw new ConflictError('Stop request changed', 'native_stop_request_changed');
  if (report && row && !['requested', 'accepted', report.status].includes(row.status))
    throw new ConflictError('Stop already settled', 'native_stop_settled');
  return { session, row };
}
export async function pollOwnedControl(
  owner: OwnerRuntime,
  id: string,
  instance: string,
  report?: { request_id: string; status: 'accepted' | 'exited' | 'refused' },
) {
  owner.assertOwner();
  const current = checked(owner.state.snapshot(), id, instance, report);
  if (current.row && (!report || report.status === current.row.status)) return answer(current.row);
  return (await mutateOwnerState(owner, {
    kind: 'native.control.report',
    payload: { id, instance, report: report ?? null },
    prepare(context) {
      const { session, row } = checked(context.snapshot, id, instance, report),
        now = new Date().toISOString();
      if (!row) {
        const next = {
          sessionId: id,
          instanceId: instance,
          bindingGeneration: session.bindingGeneration,
          status: 'ready',
          requestId: null,
          clientMessageId: null,
          actorId: null,
          updatedAt: now,
        };
        context.draft.upsert('agentNativeControls', next);
        context.write((tx) => tx.insert(agentNativeControls).values(next));
        return answer(next);
      }
      if (report && report.status !== row.status)
        return answer(
          stageUpdate(context, 'agentNativeControls', id, { status: report.status, updatedAt: now }),
        );
      return answer(row);
    },
  })) as { request_id: string | null; instance_id: string; binding_generation: number };
}
export async function requestOwnedControl(
  owner: OwnerRuntime,
  id: string,
  key: string,
  expected: { instance_id: string; binding_generation: number },
  actor: number,
) {
  return (await mutateOwnerState(owner, {
    kind: 'native.control.stop',
    payload: { id, key, expected, actor },
    prepare(context) {
      const session = binding(context.snapshot, id),
        row = context.snapshot.table('agentNativeControls').get(id);
      if (!row) throw new NotFoundError('Native stop is unavailable');
      if (!isEngine(session.engine) || !ownedEngineState(context.snapshot)[session.engine])
        throw new ConflictError('Engine disabled', 'engine_disabled');
      if (
        row.instanceId !== expected.instance_id ||
        row.bindingGeneration !== expected.binding_generation ||
        session.bindingGeneration !== expected.binding_generation
      )
        throw new ConflictError('Session binding changed', 'native_stop_binding_changed');
      if (row.requestId) {
        if (row.clientMessageId !== key || row.actorId !== actor)
          throw new ConflictError('A stop already exists', 'native_stop_in_progress');
        return { ...ownedControlView(owner, row)!, replayed: true } as Json;
      }
      if (session.endedAt || !ownedControlView(owner, row)?.available)
        throw new ConflictError('Refresh session status before stopping', 'native_stop_unavailable');
      if (context.snapshot.table('hostDaemonPortalBindings').by('portalSessionId', id).length)
        throw new ConflictError('Use the daemon session stop for this process', 'native_stop_daemon_managed');
      const now = new Date().toISOString();
      for (const watchdog of context.snapshot
        .table('agentWatchdogs')
        .by('sessionId', id)
        .filter((w) => WATCHDOG_LIVE.includes(w.status)))
        stageStopWatchdog(context, watchdog, 'disabled', 'user_stop', now);
      for (const message of context.snapshot.messages
        .by('deliverySessionId', id)
        .filter((m) => ['accepted', 'leased'].includes(m.status)))
        for (const run of context.draft.table('agentScheduleRuns').by('messageId', message.id))
          stageUpdate(context, 'agentScheduleRuns', run.id, {
            persistent: 0,
            status: 'canceled',
            lastError: 'user_stop',
            updatedAt: now,
          });
      const next = stageUpdate(context, 'agentNativeControls', id, {
        requestId: randomUUID(),
        clientMessageId: key,
        actorId: actor,
        status: 'requested',
        updatedAt: now,
      });
      return { ...ownedControlView(owner, next)!, replayed: false } as Json;
    },
  })) as NonNullable<ReturnType<typeof ownedControlView>> & { replayed: boolean };
}

/** Host-authenticated replay only records an already requested, exact process result. */
export async function recordOwnedNativeReceipt(
  owner: OwnerRuntime,
  hostId: number,
  input: {
    session_id: string;
    binding_generation: number;
    native_instance_id: string;
    request_id: string;
    result: 'accepted' | 'exited' | 'refused';
  },
  authorizeHost: (snapshot: OwnerStateSnapshot) => void,
) {
  const validate = (snapshot: OwnerStateSnapshot) => {
    authorizeHost(snapshot);
    const session = snapshot.sessions.get(input.session_id);
    const host = snapshot.hosts.get(hostId);
    const control = snapshot.table('agentNativeControls').get(input.session_id);
    if (
      !host ||
      !session ||
      session.hostId !== hostId ||
      session.hostAuthFingerprint !== host.authFingerprint ||
      session.bindingGeneration !== input.binding_generation ||
      !control ||
      control.bindingGeneration !== input.binding_generation ||
      control.instanceId !== input.native_instance_id ||
      control.requestId !== input.request_id
    )
      throw new ConflictError('Native receipt identity changed', 'native_stop_receipt_fenced');
    if (
      (control.status === 'refused' && input.result !== 'refused') ||
      (control.status === 'exited' && input.result === 'refused') ||
      (input.result === 'refused' && control.status === 'accepted')
    )
      throw new ConflictError('Native receipt contradicts known outcome', 'native_stop_receipt_conflict');
    return control;
  };
  const current = validate(owner.state.snapshot());
  // A delayed accepted receipt is already satisfied by the later exited result.
  if (current.status === input.result || (current.status === 'exited' && input.result === 'accepted'))
    return { recorded: true };
  return mutateOwnerState(owner, {
    kind: 'native.control.receipt',
    payload: input,
    authorize: (snapshot) => {
      validate(snapshot);
    },
    prepare(context) {
      const row = validate(context.snapshot);
      if (row.status !== input.result && !(row.status === 'exited' && input.result === 'accepted'))
        stageUpdate(context, 'agentNativeControls', input.session_id, {
          status: input.result,
          updatedAt: new Date().toISOString(),
        });
      return { recorded: true };
    },
  });
}
