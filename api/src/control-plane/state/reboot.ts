import { hostDaemonPortalBindings } from '../../db/schema.js';
import { ForbiddenError } from '../../http/errors.js';
import type { RegisterMessagingSessionInput } from '../../services/agent-messaging/types.js';
import { fail } from '../../services/reboot-handoffs/policy.js';
import { isoOffsetSeconds } from '../../util/timestamp.js';
import type { StateRow } from './catalog.js';
import { stageEndNames } from './names.js';
import { stageUpdate } from './rows.js';
import type { OwnerMutationContext } from './runtime.js';

export function assertNoOwnedRecovery(context: OwnerMutationContext, addressId: string): void {
  if (
    context.draft
      .table('agentSchedules')
      .by('targetAddressId', addressId)
      .some((row) => row.enabled === 1 && row.persistent === 1 && !row.deletedAt) ||
    context.draft
      .table('agentWatchdogs')
      .by('targetAddressId', addressId)
      .some((row) => ['watching', 'recovering', 'capacity_wait'].includes(row.status))
  )
    throw fail('Disable competing watchdog/persistent Wake recovery before preparing a reboot');
}

export function stageBeginReboot(
  context: OwnerMutationContext,
  hostId: number,
  input: RegisterMessagingSessionInput,
  now: string,
): StateRow<'agentRebootHandoffs'> | null {
  if (!input.rebootRequestId) return null;
  const { draft } = context;
  const row = draft.table('agentRebootHandoffs').get(input.rebootRequestId);
  if (
    !row ||
    row.hostId !== hostId ||
    row.engine !== input.engine ||
    row.username !== input.username ||
    row.cwd !== input.cwd ||
    row.nativeSessionId !== input.upstreamSessionId ||
    !input.rebootBootId ||
    input.rebootBootId === row.bootId
  )
    throw new ForbiddenError('Reboot handoff identity mismatch');
  if (row.newSessionId === input.sessionId && row.resumeBootId === input.rebootBootId) return row;
  if (row.status !== 'armed' || row.expiresAt <= now || row.newSessionId)
    throw fail('Reboot handoff is consumed, expired or canceled');
  const old = draft.table('agentSessions').get(row.oldSessionId),
    address = draft.table('agentBusAddresses').get(row.addressId);
  if (
    !old ||
    old.closeRequestedAt ||
    address?.currentSessionId !== old.id ||
    address.enabled !== 1 ||
    address.archivedAt ||
    address.lastUpstreamSessionId !== row.nativeSessionId
  )
    throw fail('Reboot was stopped or native binding changed');
  assertNoOwnedRecovery(context, row.addressId);
  const remote = draft.table('hostDaemonPortalBindings').get(row.oldSessionId);
  if (remote) {
    const session = draft.table('hostDaemonSessions').get(remote.daemonSessionId);
    if (!session || ['stopping', 'closed'].includes(session.status)) throw fail('Remote session was stopped');
  }
  if (
    row.busMessageIds.some((id) => {
      const message = draft.table('agentBusMessages').get(id);
      return !message || message.status !== 'reboot_hold' || message.cancelRequestedAt;
    })
  )
    throw fail('Transferred work was canceled or changed');
  stageUpdate(context, 'agentSessions', old.id, {
    status: 'rebooted',
    endedAt: now,
    bridgeExpiresAt: now,
    expiresAt: isoOffsetSeconds(86400, new Date(now)),
    updatedAt: now,
  });
  stageEndNames(context, old.id, now);
  stageUpdate(context, 'agentBusAddresses', row.addressId, { currentSessionId: null });
  stageUpdate(context, 'agentRebootHandoffs', row.id, {
    status: 'resuming',
    resumeBootId: input.rebootBootId,
    newSessionId: input.sessionId,
    updatedAt: now,
  });
  return row;
}

export function stageCompleteReboot(
  context: OwnerMutationContext,
  handoff: StateRow<'agentRebootHandoffs'> | null,
  sessionId: string,
  address: StateRow<'agentBusAddresses'>,
  now: string,
): void {
  if (!handoff || handoff.newSessionId === sessionId) return;
  const { draft } = context;
  for (const id of handoff.busMessageIds) {
    const message = draft.table('agentBusMessages').get(id);
    if (message?.status === 'reboot_hold')
      stageUpdate(context, 'agentBusMessages', id, {
        status: 'accepted',
        leaseOwner: `session:${sessionId}`,
        leaseUntil: null,
        ownershipMode: 'connection',
        ownerInstanceId: null,
        relayGeneration: null,
        targetBindingGeneration: address.bindingGeneration,
        deliverySessionId: sessionId,
        updatedAt: now,
      });
  }
  for (const id of handoff.portalMessageIds) {
    const message = draft.table('agentMessages').by('messageId', id)[0];
    if (message?.status === 'reboot_hold')
      stageUpdate(context, 'agentMessages', message.id, { status: 'accepted', sessionId, updatedAt: now });
  }
  if (handoff.portalMessageIds.length)
    stageUpdate(context, 'agentSessions', sessionId, {
      activeTurnId: draft.table('agentSessions').get(handoff.oldSessionId)?.activeTurnId ?? null,
      updatedAt: now,
    });
  const remote = draft.table('hostDaemonPortalBindings').get(handoff.oldSessionId);
  if (remote) {
    const binding = { portalSessionId: sessionId, daemonSessionId: remote.daemonSessionId };
    draft.upsert('hostDaemonPortalBindings', binding);
    context.write(async (tx) => {
      await tx.insert(hostDaemonPortalBindings).values(binding);
    });
    stageUpdate(context, 'hostDaemonSessions', remote.daemonSessionId, {
      sessionId,
      status: 'running',
      lastActivityAt: now,
    });
  }
  stageUpdate(context, 'agentRebootHandoffs', handoff.id, {
    status: 'resumed',
    activeHostId: null,
    updatedAt: now,
  });
}
