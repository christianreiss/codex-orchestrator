import type { OwnerStateSnapshot } from '../../control-plane/state/store.js';
import {
  mutateOwnerState,
  type OwnerMutationContext,
  type OwnerRuntime,
} from '../../control-plane/state/runtime.js';
import { stageUpdate } from '../../control-plane/state/rows.js';
import { stageEndNames } from '../../control-plane/state/names.js';
import { wsPublisher } from '../../ws/publisher.js';
import { SERVER_ADDRESS_ID } from './groups.js';

export function conferenceHasOwnedDeliveries(snapshot: OwnerStateSnapshot, id: string): boolean {
  return snapshot
    .table('agentRoomEvents')
    .by('roomId', id)
    .some((event) =>
      snapshot
        .table('agentRoomDeliveries')
        .by('eventId', event.id)
        .some((delivery) => {
          const message = delivery.messageId && snapshot.messages.get(delivery.messageId);
          return (
            message &&
            message.senderAddressId === SERVER_ADDRESS_ID &&
            !['completed', 'dead', 'expired', 'canceled', 'ambiguous'].includes(message.status)
          );
        }),
    );
}
function due(snapshot: OwnerStateSnapshot, now: string): boolean {
  if (
    snapshot.messages
      .all()
      .some(
        (row) =>
          (['queued', 'batched'].includes(row.status) && row.expiresAt <= now) ||
          (row.kind === 'presence_notice' &&
            ['queued', 'leased', 'accepted', 'batched'].includes(row.status) &&
            (!row.targetSessionId ||
              !snapshot.sessions.get(row.targetSessionId) ||
              snapshot.sessions.get(row.targetSessionId)?.endedAt ||
              snapshot.addresses.get(row.targetAddressId)?.currentSessionId !== row.targetSessionId)),
      )
  )
    return true;
  if (
    snapshot.addresses
      .all()
      .some((row) => row.currentSessionId && snapshot.sessions.get(row.currentSessionId)?.endedAt)
  )
    return true;
  if (
    snapshot
      .table('agentRebootHandoffs')
      .all()
      .some((row) => ['prepared', 'armed'].includes(row.status) && row.expiresAt <= now)
  )
    return true;
  if (
    snapshot
      .table('agentBusConferenceMembers')
      .all()
      .some((row) => row.state === 'dispatched' && row.dispatchDeadlineAt && row.dispatchDeadlineAt <= now)
  )
    return true;
  return snapshot
    .table('agentBusConferences')
    .all()
    .some(
      (row) =>
        (row.pin && row.pinExpiresAt && row.pinExpiresAt <= now) ||
        (row.status !== 'adjourned' && row.deadlineAt <= now) ||
        (row.status === 'adjourning' &&
          row.ownerAdminId === null &&
          !snapshot
            .table('agentBusConferenceMembers')
            .by('conferenceId', row.id)
            .some((member) => member.state === 'dispatched') &&
          !conferenceHasOwnedDeliveries(snapshot, row.id)),
    );
}
export function stageExpiredReboots(ctx: OwnerMutationContext, now: string): void {
  for (const row of ctx.draft.table('agentRebootHandoffs').all()) {
    if (!['prepared', 'armed'].includes(row.status) || row.expiresAt > now) continue;
    for (const id of row.busMessageIds) {
      const message = ctx.draft.table('agentBusMessages').get(id);
      if (message?.status === 'reboot_hold')
        stageUpdate(ctx, 'agentBusMessages', id, {
          status: 'ambiguous',
          lastErrorCode: 'reboot_handoff_expired',
          ambiguousAt: now,
          leaseUntil: null,
          updatedAt: now,
        });
    }
    for (const id of row.portalMessageIds)
      for (const message of ctx.draft.table('agentMessages').by('messageId', id))
        if (message.status === 'reboot_hold')
          stageUpdate(ctx, 'agentMessages', message.id, {
            status: 'dead',
            lastError: 'Reboot handoff expired without a result',
            updatedAt: now,
          });
    const binding = ctx.draft.table('hostDaemonPortalBindings').by('portalSessionId', row.oldSessionId)[0];
    if (binding) {
      for (const operation of ctx.draft
        .table('hostDaemonOperations')
        .by('sessionId', binding.daemonSessionId))
        if (operation.status === 'reboot_hold')
          stageUpdate(ctx, 'hostDaemonOperations', operation.id, { status: 'unknown', updatedAt: now });
      const session = ctx.draft.table('hostDaemonSessions').get(binding.daemonSessionId);
      if (session?.status === 'running')
        stageUpdate(ctx, 'hostDaemonSessions', session.id, { status: 'waiting', lastActivityAt: now });
    }
    stageUpdate(ctx, 'agentRebootHandoffs', row.id, {
      status: 'expired',
      activeHostId: null,
      updatedAt: now,
    });
  }
}
/** Only real queue, rendezvous and recovery deadlines. No liveness SQL sweep. */
export async function maintainOwnedMessaging(runtime: OwnerRuntime): Promise<Record<string, number>> {
  runtime.assertOwner();
  const empty = {
    expired: 0,
    retried: 0,
    dead: 0,
    ambiguous: 0,
    released_bindings: 0,
    conferences_adjourned: 0,
    dispatches_expired: 0,
  };
  if (!due(runtime.state.snapshot(), new Date().toISOString())) return empty;
  const result = (await mutateOwnerState(runtime, {
    kind: 'messaging.maintenance',
    payload: {},
    prepare(ctx) {
      const now = new Date().toISOString(),
        counts = { ...empty };
      stageExpiredReboots(ctx, now);
      for (const message of ctx.draft.table('agentBusMessages').all()) {
        if (['queued', 'batched'].includes(message.status) && message.expiresAt <= now) {
          stageUpdate(ctx, 'agentBusMessages', message.id, {
            status: 'expired',
            expiredAt: now,
            leaseOwner: null,
            leaseUntil: null,
            updatedAt: now,
          });
          counts.expired++;
          continue;
        }
        if (
          message.kind !== 'presence_notice' ||
          !['queued', 'leased', 'accepted', 'batched'].includes(message.status)
        )
          continue;
        const session =
            message.targetSessionId && ctx.draft.table('agentSessions').get(message.targetSessionId),
          address = ctx.draft.table('agentBusAddresses').get(message.targetAddressId);
        if (!session || session.endedAt || address?.currentSessionId !== session.id)
          stageUpdate(ctx, 'agentBusMessages', message.id, {
            status: 'canceled',
            canceledAt: now,
            lastErrorCode: 'presence_notice_session_ended',
            leaseOwner: null,
            leaseUntil: null,
            updatedAt: now,
          });
      }
      for (const address of ctx.draft.table('agentBusAddresses').all()) {
        const session = address.currentSessionId
          ? ctx.draft.table('agentSessions').get(address.currentSessionId)
          : undefined;
        if (!session?.endedAt) continue;
        const upstream = session.upstreamSessionId ?? address.lastUpstreamSessionId;
        for (const message of ctx.draft.table('agentBusMessages').by('targetAddressId', address.id)) {
          if (
            ['queued', 'leased'].includes(message.status) &&
            message.kind !== 'presence_notice' &&
            message.awaitingPresence !== 1
          )
            stageUpdate(ctx, 'agentBusMessages', message.id, { awaitingPresence: 1 });
          if (
            session.status === 'completed' &&
            !session.closeRequestedAt &&
            message.status === 'accepted' &&
            message.deliverySessionId === session.id &&
            message.targetBindingGeneration === address.bindingGeneration &&
            message.relayGeneration !== null &&
            message.leaseOwner?.startsWith('relay:')
          )
            stageUpdate(ctx, 'agentBusMessages', message.id, {
              targetBindingGeneration: address.bindingGeneration + 1,
              updatedAt: now,
            });
        }
        stageUpdate(ctx, 'agentBusAddresses', address.id, {
          currentSessionId: null,
          lastUpstreamSessionId: upstream,
          adapterProtocol: null,
          adapterCapabilities: null,
          readiness: upstream ? 'resumable' : 'offline',
          receiveHeartbeatAt: null,
          bindingGeneration: address.bindingGeneration + 1,
          lastSeenAt: session.heartbeatAt > address.lastSeenAt ? session.heartbeatAt : address.lastSeenAt,
          updatedAt: now,
        });
        stageUpdate(ctx, 'agentSessions', session.id, {
          adapterProtocol: null,
          adapterCapabilities: null,
          receiveHeartbeatAt: null,
          bindingGeneration: session.bindingGeneration + 1,
          updatedAt: now,
        });
        stageEndNames(ctx, session.id, session.endedAt);
        counts.released_bindings++;
      }
      for (const conference of ctx.draft.table('agentBusConferences').all()) {
        if (conference.pin && conference.pinExpiresAt && conference.pinExpiresAt <= now)
          stageUpdate(ctx, 'agentBusConferences', conference.id, {
            pin: null,
            pinExpiresAt: null,
            updatedAt: now,
          });
        if (conference.status !== 'adjourned' && conference.deadlineAt <= now) {
          stageUpdate(ctx, 'agentBusConferences', conference.id, {
            status: 'adjourned',
            adjournReason: 'Conference deadline passed',
            adjournedAt: now,
            pin: null,
            pinExpiresAt: null,
            updatedAt: now,
          });
          counts.conferences_adjourned++;
        }
      }
      for (const member of ctx.draft.table('agentBusConferenceMembers').all())
        if (member.state === 'dispatched' && member.dispatchDeadlineAt && member.dispatchDeadlineAt <= now) {
          stageUpdate(ctx, 'agentBusConferenceMembers', member.id, {
            state: 'seated',
            dispatchMessageId: null,
            dispatchDeadlineAt: null,
            updatedAt: now,
          });
          counts.dispatches_expired++;
        }
      for (const conference of ctx.draft.table('agentBusConferences').all()) {
        if (
          conference.status !== 'adjourning' ||
          conference.ownerAdminId !== null ||
          ctx.draft
            .table('agentBusConferenceMembers')
            .by('conferenceId', conference.id)
            .some((member) => member.state === 'dispatched') ||
          conferenceHasOwnedDeliveries(ctx.draft.view(), conference.id)
        )
          continue;
        stageUpdate(ctx, 'agentBusConferences', conference.id, {
          status: 'adjourned',
          adjournedAt: now,
          pin: null,
          pinExpiresAt: null,
          updatedAt: now,
        });
        for (const member of ctx.draft.table('agentBusConferenceMembers').by('conferenceId', conference.id))
          if (member.state !== 'left')
            stageUpdate(ctx, 'agentBusConferenceMembers', member.id, {
              state: 'left',
              leftAt: now,
              updatedAt: now,
            });
        counts.conferences_adjourned++;
      }
      return counts;
    },
  })) as Record<string, number>;
  if (result.expired || result.released_bindings)
    wsPublisher.publish('agent_messaging.queue.changed', result);
  if (result.conferences_adjourned || result.dispatches_expired)
    wsPublisher.publish('agent_messaging.conference.changed', {
      adjourned: result.conferences_adjourned,
      dispatches_expired: result.dispatches_expired,
    });
  return result;
}
