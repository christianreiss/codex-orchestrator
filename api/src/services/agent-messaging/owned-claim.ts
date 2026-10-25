import { eq } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import { agentBusMessages } from '../../db/schema.js';
import { ConflictError } from '../../http/errors.js';
import type { Keyring } from '../../security/keyring.js';
import { decrypt } from '../../security/secret-box.js';
import type { Json } from '../../control-plane/commands.js';
import type { OwnerStateSnapshot } from '../../control-plane/state/store.js';
import { mutateOwnerState, type OwnerRuntime } from '../../control-plane/state/runtime.js';
import { ownedAddress, requireOwnedMessaging } from '../../control-plane/state/messaging.js';
import { stageUpdate } from '../../control-plane/state/rows.js';
import { receiverState } from '../agent-receiver-state.js';
import { ownedReceiverReady } from '../../control-plane/streams/receiver.js';
import { daemonAccepting } from '../host-daemon/policy.js';
import { jsonRecord, normalizeUuid } from './normalize.js';
import { deliveryView } from './views.js';
import type { MessageDelivery } from './types.js';
import {
  assertOwnedDelivery,
  assertOwnedScheduleAcceptance,
  deliveryAttachment,
  ownedFreshStartAllowed,
  type OwnedMessage,
} from './owned-delivery.js';
import { prepareOwnedPresentations } from './owned-presentations.js';

export interface OwnedClaimOptions {
  targetAddressIds: string[];
  leaseOwner: string;
  claimId: string;
  relayGeneration: number | null;
  skipReceiveCapable: boolean;
  receiverGeneration?: string;
  informationalOnly: boolean;
  smartQueue: boolean;
  peerBatch: boolean;
}
const isWork = (row: OwnedMessage) => !!row.workKind || ['request', 'task', 'schedule'].includes(row.kind);
const inFlight = (row: OwnedMessage) => ['leased', 'accepted', 'reboot_hold'].includes(row.status);
function presentationOrder(snapshot: OwnerStateSnapshot, row: OwnedMessage): number {
  if (row.kind !== 'digest') return row.dispatchOrder;
  const members = snapshot.messages
    .by('digestId', row.id)
    .filter((member) => row.deliveryClass !== 'coordination' || member.deliveryClass === 'coordination');
  return members.length ? Math.min(...members.map((member) => member.dispatchOrder)) : row.dispatchOrder;
}
/** Shared pure decision for claims and advisory mailbox/relay projections. */
export function ownedClaimCandidates(
  snapshot: OwnerStateSnapshot,
  options: OwnedClaimOptions,
  now = new Date().toISOString(),
): OwnedMessage[] {
  const sessionId = options.relayGeneration === null ? options.leaseOwner.slice(8) : null;
  const relevant = options.targetAddressIds.flatMap((id) => snapshot.messages.by('targetAddressId', id));
  const live = relevant.filter((row) => inFlight(row) || (row.status === 'queued' && row.expiresAt > now));
  return relevant
    .filter((row) => {
      if (
        row.status !== 'queued' ||
        row.expiresAt <= now ||
        (row.nextAttemptAt > now && (!sessionId || row.deliverySessionId === sessionId))
      )
        return false;
      if ((!options.smartQueue && row.kind === 'digest') || (options.informationalOnly && isWork(row)))
        return false;
      if (
        snapshot
          .table('agentRebootHandoffs')
          .by('addressId', row.targetAddressId)
          .some((h) => h.status === 'armed')
      )
        return false;
      const peers = live.filter(
        (other) => other.targetAddressId === row.targetAddressId && other.id !== row.id,
      );
      if (!options.smartQueue)
        return !peers.some((other) => inFlight(other) || other.dispatchOrder < row.dispatchOrder);
      const order = presentationOrder(snapshot, row);
      return !peers.some((other) => {
        if (isWork(row)) return inFlight(other) || (isWork(other) && other.dispatchOrder < row.dispatchOrder);
        if (isWork(other)) return false;
        if (inFlight(other)) return true;
        const earlier = presentationOrder(snapshot, other);
        if (row.deliveryClass === 'coordination')
          return other.deliveryClass === 'coordination' && earlier < order;
        if (other.deliveryClass === 'coordination') return true;
        return row.kind === 'digest'
          ? other.kind === 'digest' && earlier < order
          : other.kind === 'digest' || earlier < order;
      });
    })
    .sort((a, b) => {
      const rank = (row: OwnedMessage) =>
        row.deliveryClass === 'coordination' ? 0 : isWork(row) ? 1 : row.kind === 'digest' ? 2 : 3;
      return options.smartQueue
        ? rank(a) - rank(b) || presentationOrder(snapshot, a) - presentationOrder(snapshot, b)
        : a.dispatchOrder - b.dispatchOrder;
    });
}
function authorizeClaim(
  runtime: OwnerRuntime,
  snapshot: OwnerStateSnapshot,
  options: OwnedClaimOptions,
): string {
  // An authenticated protocol-1 stream proves the capability directly. Old
  // signed configs omitted its declaration; never substitute that stale claim
  // for the exact live attachment/native/generation proof checked here.
  const instance = deliveryAttachment(runtime, snapshot, options.leaseOwner);
  if (options.relayGeneration === null) {
    const session = snapshot.sessions.get(options.leaseOwner.slice(8))!;
    if (!session.agentBusAddressId || !options.targetAddressIds.includes(session.agentBusAddressId))
      throw new ConflictError('Agent address binding changed', 'agent_messaging_binding_stale');
    const receiver = receiverState(session.receiver);
    if (
      receiver &&
      (receiver.generation !== options.receiverGeneration || !ownedReceiverReady(runtime, session, 'peer'))
    )
      throw new ConflictError('Receiver generation is unavailable', 'receiver_generation_changed');
  } else {
    const relay = snapshot.table('agentBusRelays').get(options.leaseOwner.split(':')[1]!)!;
    if (relay.generation !== options.relayGeneration)
      throw new ConflictError('Relay generation changed', 'agent_messaging_lease_lost');
  }
  return instance;
}
function decorate(
  snapshot: OwnerStateSnapshot,
  delivery: MessageDelivery,
  message: OwnedMessage,
): MessageDelivery {
  const remote = snapshot.table('hostDaemonSessions').by('addressId', message.targetAddressId)[0];
  if (remote) delivery.target.daemon_session_id = remote.id;
  if (remote?.model) delivery.target.daemon_model = remote.model;
  if (ownedFreshStartAllowed(snapshot, message)) delivery.target.fresh_start_approved = true;
  if (message.kind === 'schedule') {
    const run = snapshot.table('agentScheduleRuns').by('messageId', message.id)[0];
    if (run) {
      Object.assign(delivery.target, {
        schedule_id: run.scheduleId,
        schedule_run_id: run.id,
        schedule_persistent: run.persistent === 1,
        progress_timeout_seconds: run.progressTimeoutSeconds,
      });
      const watchdog = snapshot.table('agentWatchdogs').by('scheduleId', run.scheduleId)[0];
      if (watchdog)
        Object.assign(delivery.target, {
          watchdog_id: watchdog.id,
          watchdog_deadline_at: watchdog.deadlineAt,
          watchdog_native_session_id: watchdog.nativeSessionId,
        });
    }
  }
  return delivery;
}
export async function claimOwnedDelivery(
  db: Database,
  runtime: OwnerRuntime,
  keyring: Keyring,
  rawOptions: OwnedClaimOptions,
): Promise<MessageDelivery | null> {
  const options = { ...rawOptions, claimId: normalizeUuid(rawOptions.claimId, 'claim_id') };
  runtime.assertOwner();
  authorizeClaim(runtime, runtime.state.snapshot(), options);
  const initial = runtime.state.snapshot();
  const replay = initial.messages
    .all()
    .find(
      (row) =>
        options.targetAddressIds.includes(row.targetAddressId) &&
        row.leaseOwner === options.leaseOwner &&
        row.claimId === options.claimId &&
        ['leased', 'accepted'].includes(row.status),
    );
  if (replay && replay.status === 'accepted') return null; // The executor already owns this work; never present it again.
  await prepareOwnedPresentations(db, runtime, keyring, options.targetAddressIds, {
    smart: options.smartQueue,
    peer: options.peerBatch,
    relay: options.skipReceiveCapable,
  });
  if (!replay && !ownedClaimCandidates(runtime.state.snapshot(), options).length) return null;
  let selected: OwnedMessage | undefined;
  const { targetAddressIds: _targets, ...request } = options;
  const result = await mutateOwnerState(runtime, {
    kind: 'messaging.claim',
    principal: options.leaseOwner,
    id: options.claimId,
    payload: JSON.parse(JSON.stringify(request)) as Json,
    authorize(snapshot) {
      authorizeClaim(runtime, snapshot, options);
      if (selected) {
        ownedAddress(snapshot, selected.targetAddressId);
        if (selected.expiresAt <= new Date().toISOString())
          throw new ConflictError('Message expired before delivery', 'agent_messaging_message_expired');
        if (selected.kind === 'schedule') {
          const run = snapshot.table('agentScheduleRuns').by('messageId', selected.id)[0],
            watchdog = run && snapshot.table('agentWatchdogs').by('scheduleId', run.scheduleId)[0];
          if (watchdog && watchdog.deadlineAt <= new Date().toISOString())
            throw new ConflictError('Watchdog recovery expired', 'watchdog_recovery_unavailable');
        }
      }
    },
    async prepare(ctx) {
      const snapshot = ctx.snapshot,
        now = new Date().toISOString(),
        instance = authorizeClaim(runtime, snapshot, options);
      const existing = snapshot.messages
        .all()
        .find(
          (row) =>
            options.targetAddressIds.includes(row.targetAddressId) &&
            row.leaseOwner === options.leaseOwner &&
            row.claimId === options.claimId &&
            row.status === 'leased',
        );
      if (existing) {
        if (options.informationalOnly && isWork(existing)) return null;
        assertOwnedDelivery(snapshot, existing, options.claimId, options.leaseOwner, options.relayGeneration);
        deliveryAttachment(runtime, snapshot, options.leaseOwner, existing.ownerInstanceId);
        selected = existing;
      } else
        for (const candidate of ownedClaimCandidates(snapshot, options).slice(0, 64)) {
          const target = ownedAddress(snapshot, candidate.targetAddressId);
          if (
            candidate.kind === 'presence_notice' &&
            (options.skipReceiveCapable || candidate.targetSessionId !== options.leaseOwner.slice(8))
          )
            continue;
          if (options.skipReceiveCapable && target.currentSessionId) continue;
          if (
            options.skipReceiveCapable &&
            !candidate.workKind &&
            (!target.lastUpstreamSessionId || target.continuity !== 'native')
          ) {
            stageUpdate(ctx, 'agentBusMessages', candidate.id, {
              status: 'dead',
              deadAt: now,
              lastErrorCode: 'native_transcript_missing',
              updatedAt: now,
            });
            continue;
          }
          if (!options.skipReceiveCapable && ownedFreshStartAllowed(snapshot, candidate)) {
            if (candidate.lastErrorCode !== 'fresh_start_waiting_idle')
              stageUpdate(ctx, 'agentBusMessages', candidate.id, {
                lastErrorCode: 'fresh_start_waiting_idle',
                updatedAt: now,
              });
            continue;
          }
          const relay =
            options.relayGeneration === null
              ? undefined
              : snapshot.table('agentBusRelays').get(options.leaseOwner.split(':')[1]!);
          const capabilities = jsonRecord(relay?.capabilities ?? target.adapterCapabilities) ?? {};
          if (candidate.executionContractVersion >= 2 && capabilities.execution_contract_version !== 2) {
            if (candidate.lastErrorCode !== 'adapter_upgrade_required')
              stageUpdate(ctx, 'agentBusMessages', candidate.id, {
                lastErrorCode: 'adapter_upgrade_required',
                updatedAt: now,
              });
            continue;
          }
          if (candidate.kind === 'schedule') {
            const run = snapshot.table('agentScheduleRuns').by('messageId', candidate.id)[0],
              schedule = run && snapshot.table('agentSchedules').get(run.scheduleId);
            if (
              !run ||
              !schedule?.enabled ||
              schedule.deletedAt ||
              (options.skipReceiveCapable && !run.persistent)
            )
              continue;
            const watchdog = snapshot.table('agentWatchdogs').by('scheduleId', run.scheduleId)[0];
            if (watchdog && capabilities.watchdog_protocol_version !== 1) {
              if (candidate.lastErrorCode !== 'adapter_upgrade_required')
                stageUpdate(ctx, 'agentBusMessages', candidate.id, {
                  lastErrorCode: 'adapter_upgrade_required',
                  updatedAt: now,
                });
              continue;
            }
            try {
              await assertOwnedScheduleAcceptance(db, snapshot, candidate, null);
            } catch (error) {
              if (error instanceof ConflictError) continue;
              throw error;
            }
          }
          const remote = snapshot.table('hostDaemonSessions').by('addressId', target.id)[0];
          if (remote && options.skipReceiveCapable) {
            const daemon = snapshot.daemons.get(remote.hostId),
              working = snapshot
                .table('hostDaemonSessions')
                .by('hostId', remote.hostId)
                .filter((row) => ['running', 'stopping'].includes(row.status));
            if (
              !daemon ||
              !daemonAccepting(daemon.settings) ||
              !['idle', 'waiting'].includes(remote.status) ||
              working.length >= daemon.settings.max_parallel
            )
              continue;
            if (Date.now() - Date.parse(candidate.createdAt) >= 600_000) {
              stageUpdate(ctx, 'agentBusMessages', candidate.id, {
                status: 'expired',
                expiredAt: now,
                updatedAt: now,
              });
              continue;
            }
            stageUpdate(ctx, 'hostDaemonSessions', remote.id, {
              status: 'running',
              activeMessageId: candidate.id,
              lastActivityAt: now,
            });
          }
          selected = stageUpdate(ctx, 'agentBusMessages', candidate.id, {
            status: 'leased',
            attempts: candidate.attempts + 1,
            leaseOwner: options.leaseOwner,
            leaseUntil: null,
            ownershipMode: 'connection',
            ownerInstanceId: instance,
            claimId: options.claimId,
            relayGeneration: options.relayGeneration,
            targetBindingGeneration: target.bindingGeneration,
            deliverySessionId: target.currentSessionId,
            deliveryUpstreamSessionId: target.lastUpstreamSessionId,
            updatedAt: now,
          });
          break;
        }
      if (!selected) return null;
      const [body] = await db
        .select({ contentEnc: agentBusMessages.contentEnc })
        .from(agentBusMessages)
        .where(eq(agentBusMessages.id, selected.id))
        .limit(1);
      if (!body) throw new Error('Claimed message body missing');
      const sender = snapshot.addresses.get(selected.senderAddressId),
        target = snapshot.addresses.get(selected.targetAddressId);
      if (!sender || !target) throw new Error('Claimed message participant missing');
      return JSON.parse(
        JSON.stringify(
          decorate(
            snapshot,
            deliveryView(selected, decrypt(body.contentEnc, keyring), sender, target),
            selected,
          ),
        ),
      ) as Json;
    },
  });
  if (!result) return null;
  const delivery = result as unknown as MessageDelivery,
    current = runtime.state.snapshot().messages.get(delivery.message_id);
  if (!current || current.status !== 'leased') return null;
  assertOwnedDelivery(
    runtime.state.snapshot(),
    current,
    options.claimId,
    options.leaseOwner,
    options.relayGeneration,
  );
  deliveryAttachment(runtime, runtime.state.snapshot(), options.leaseOwner, current.ownerInstanceId);
  ownedAddress(runtime.state.snapshot(), current.targetAddressId);
  if (current.expiresAt <= new Date().toISOString())
    throw new ConflictError('Message expired before delivery', 'agent_messaging_message_expired');
  await assertOwnedScheduleAcceptance(db, runtime.state.snapshot(), current, null);
  return delivery;
}
