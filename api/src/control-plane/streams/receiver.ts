import { legacyDrainFor } from '../legacy-drain.js';
import { randomUUID } from 'node:crypto';
import { ConflictError, ForbiddenError, UnauthorizedError } from '../../http/errors.js';
import { sha256 } from '../../security/hash.js';
import { safeHashEqual } from '../../services/agent-messaging/internals.js';
import {
  receiverState,
  receiverView,
  type ReceiverSource,
  type ReceiverState,
  type ReceiverClaimGate,
} from '../../services/agent-receiver-state.js';
import { smartQueueAllowed, peerBatchAllowed } from '../../services/agent-messaging/smart-queue.js';
import { activeHostEngines } from '../../services/host-engine-policy.js';
import { isTruthyFlagValue } from '../../services/settings.js';
import type { Env } from '../../env.js';
import type { Engine } from '../../util/engine.js';
import type { StateRow } from '../state/catalog.js';
import type { OwnerStateSnapshot } from '../state/store.js';
import {
  type OwnerRuntime,
  type OwnerMutationContext,
  mutateOwnerState,
  setOwnerRequestPrincipal,
} from '../state/runtime.js';
import { ownedMessagingHost, ownedEngineState } from '../state/messaging.js';
import { stageNativeIdentity } from '../state/session-lifecycle.js';
import { stageUpdate } from '../state/rows.js';
import { ownerPresence } from '../presence.js';
import { ownedCredentialDeadline } from '../credentials.js';

/** Common bridge proof; feature-specific enable switches belong to the caller. */
export function ownedSessionAuthority(
  snapshot: OwnerStateSnapshot,
  id: string,
  token: string,
  options: { allowEnded?: boolean; bindingGeneration?: number } = {},
) {
  const session = snapshot.sessions.get(id);
  if (
    snapshot.setting('api_disabled') === '1' ||
    !session ||
    !safeHashEqual(sha256(token), session.bridgeTokenHash)
  )
    throw new UnauthorizedError('Invalid agent bridge credential', 'agent_bridge_unauthorized');
  const host = ownedMessagingHost(snapshot, session.hostId);
  if (!safeHashEqual(host.authFingerprint, session.hostAuthFingerprint))
    throw new UnauthorizedError('Agent bridge host credential changed', 'agent_bridge_host_auth_changed');
  if (!activeHostEngines(host.engines, ownedEngineState(snapshot)).includes(session.engine as Engine))
    throw new ForbiddenError('Engine disabled', 'engine_disabled');
  if (session.endedAt && !options.allowEnded)
    throw new ConflictError('Agent session is finished', 'agent_session_finished');
  if (!session.endedAt && ownedCredentialDeadline(snapshot, 'session', id) <= Date.now())
    throw new UnauthorizedError('Agent bridge credential expired', 'agent_bridge_expired');
  if (options.bindingGeneration !== undefined && session.bindingGeneration !== options.bindingGeneration)
    throw new ConflictError('Session binding changed', 'receiver_binding_changed');
  return { session, host };
}
const enabled = (s: OwnerStateSnapshot, source: ReceiverSource) =>
  isTruthyFlagValue(s.setting(source === 'peer' ? 'agent_messaging_enabled' : 'agent_portal_enabled'), false);
export function ownedReceiverReady(
  runtime: OwnerRuntime,
  session: Readonly<StateRow<'agentSessions'>>,
  source: ReceiverSource,
): boolean {
  runtime.assertOwner();
  const state = receiverState(session.receiver);
  return Boolean(
    !session.endedAt &&
    state &&
    !state.failure &&
    state.probes[source] &&
    !(source === 'portal' && state.portal_closed) &&
    enabled(runtime.state.snapshot(), source) &&
    ownerPresence(runtime).hasReceiver(session.id, session.bindingGeneration, state.generation),
  );
}
export function ownedReceiverView(runtime: OwnerRuntime, session: Readonly<StateRow<'agentSessions'>>) {
  const state = receiverState(session.receiver);
  if (!state) return null;
  const view = receiverView(state, Date.parse(state.heartbeat_at))!;
  const sources = view.sources.map((item) => ({
    ...item,
    state: state.failure
      ? 'failed'
      : ownedReceiverReady(runtime, session, item.source as ReceiverSource) ||
          Boolean(legacyDrainFor(runtime)?.receiver(session.id, session.bindingGeneration, state.generation))
        ? 'ready'
        : 'unavailable',
  }));
  delete view.claim_gate;
  delete view.claim_gate_seconds;
  delete view.claim_gate_observed_at;
  delete view.claim_gate_note;
  const attachment = ownerPresence(runtime)
    .session(session.id, session.bindingGeneration, 'receiver')
    .find((a) => a.scope.receiver_generation === state.generation);
  const details = attachment ? ownerPresence(runtime).details(attachment.id) : undefined;
  const telemetry =
    details && typeof details === 'object' && !Array.isArray(details)
      ? (details as { gate?: { state: string; seconds: number }; observed_at?: string })
      : undefined;
  const gate = state.claim_gate_v1 && !state.failure ? telemetry?.gate : undefined;
  if (gate && telemetry?.observed_at) {
    view.claim_gate = gate.state as NonNullable<typeof view.claim_gate>;
    view.claim_gate_observed_at = telemetry.observed_at;
    const elapsed =
      gate.state === 'open' || gate.state === 'unknown'
        ? 0
        : Math.max(0, Math.floor((Date.now() - Date.parse(telemetry.observed_at)) / 1000));
    view.claim_gate_seconds = Math.min(604800, Math.max(0, gate.seconds + elapsed));
    view.claim_gate_note =
      'Local adapter state reported over its current connection; delivery is not confirmed.';
  }
  return {
    ...view,
    sources,
    state: state.failure
      ? 'failed'
      : sources.some((item) => item.state === 'ready')
        ? 'ready'
        : 'unavailable',
    ownership_mode: 'connection',
  };
}
function authorize(runtime: OwnerRuntime, id: string, token: string, source?: ReceiverSource) {
  const snapshot = runtime.state.snapshot(),
    { session } = ownedSessionAuthority(snapshot, id, token);
  if (source ? !enabled(snapshot, source) : !enabled(snapshot, 'peer') && !enabled(snapshot, 'portal'))
    throw new ForbiddenError('Receiver source is disabled', 'receiver_source_disabled');
  setOwnerRequestPrincipal({
    principal: `session:${id}:${session.bindingGeneration}`,
    revalidate: (s) => {
      ownedSessionAuthority(s, id, token, { bindingGeneration: session.bindingGeneration });
    },
  });
  return session;
}
function waitForPresence(context: OwnerMutationContext, id: string) {
  for (const message of context.draft.table('agentBusMessages').by('targetAddressId', id))
    if (
      ['queued', 'leased'].includes(message.status) &&
      message.kind !== 'presence_notice' &&
      message.awaitingPresence !== 1
    )
      stageUpdate(context, 'agentBusMessages', message.id, { awaitingPresence: 1 });
}
function response(runtime: OwnerRuntime, id: string) {
  const session = runtime.state.snapshot().sessions.get(id)!,
    state = receiverState(session.receiver)!,
    address = session.agentBusAddressId
      ? runtime.state.snapshot().addresses.get(session.agentBusAddressId)
      : undefined;
  const identity =
    session.launchName && session.launchName === address?.launchName && address.currentSessionId === id
      ? {
          identity_version: 1,
          name: session.launchName,
          uuid: address.id,
          address: `agent:${address.id}`,
          session_id: id,
          native_session_id: state.native_session_id,
          engine: session.engine,
          binding_generation: session.bindingGeneration,
        }
      : null;
  return {
    receiver: ownedReceiverView(runtime, session),
    sources: Object.keys(state.probes) as ReceiverSource[],
    capabilities: {
      control_state_protocol: 1,
      activity_v1: state.activity_v1 === true,
      queue_policy_v1: true,
      queue_delivery_v1: state.queue_delivery_v1 === true,
      peer_batch_v1: state.peer_batch_v1 === true,
      claim_gate_v1: state.claim_gate_v1 === true,
    },
    binding_generation: session.bindingGeneration,
    identity,
  };
}
export async function registerOwnedReceiver(
  runtime: OwnerRuntime,
  env: Env,
  id: string,
  token: string,
  input: {
    generation: string;
    protocol: ReceiverState['protocol'];
    native_session_id: string;
    capabilities?: { queue_delivery_v1?: boolean; peer_batch_v1?: boolean; claim_gate_v1?: boolean };
  },
) {
  const drain = legacyDrainFor(runtime),
    legacy = drain?.capturedSession(id);
  if (legacy) drain!.renew('session', id, token);
  const auth = authorize(runtime, id, token);
  if (legacy && legacy.nativeSessionId !== input.native_session_id)
    throw new ConflictError('Legacy native identity cannot be replaced', 'legacy_drain_fenced');
  if (
    { codex: 'codex-queue-v1', claude: 'claude-channel-v1', grok: 'grok-acp-v1' }[auth.engine] !==
    input.protocol
  )
    throw new ForbiddenError('Receiver engine mismatch', 'receiver_engine_mismatch');
  const check = (snapshot: OwnerStateSnapshot) => {
    const { session } = ownedSessionAuthority(snapshot, id, token, {
        bindingGeneration: auth.bindingGeneration,
      }),
      old = receiverState(session.receiver);
    if (
      old?.generation === input.generation &&
      (old.protocol !== input.protocol || old.native_session_id !== input.native_session_id)
    )
      throw new ConflictError(
        'Receiver generation was registered for another native identity',
        'receiver_registration_conflict',
      );
    if (
      old &&
      old.generation !== input.generation &&
      ownerPresence(runtime).hasReceiver(id, session.bindingGeneration, old.generation)
    )
      throw new ConflictError('Another receiver owns this session', 'receiver_owned');
    return { session, old };
  };
  const current = check(runtime.state.snapshot());
  if (current.old?.generation === input.generation) return response(runtime, id);
  await mutateOwnerState(runtime, {
    kind: 'receiver.register',
    payload: { id, ...input },
    authorize: (s) => {
      check(s);
    },
    prepare(context) {
      const { session, old } = check(context.snapshot),
        now = new Date().toISOString(),
        sources: ReceiverSource[] = [];
      if (enabled(context.snapshot, 'peer') && session.agentBusAddressId) sources.push('peer');
      if (enabled(context.snapshot, 'portal') && !old?.portal_closed) sources.push('portal');
      const next: ReceiverState = {
        generation: input.generation,
        protocol: input.protocol,
        native_session_id: input.native_session_id,
        portal_closed: old?.portal_closed,
        activity_v1: enabled(context.snapshot, 'portal'),
        peer_batch_v1: peerBatchAllowed(env, input.capabilities),
        queue_delivery_v1: smartQueueAllowed(env, session.hostId, input.capabilities),
        claim_gate_v1: input.capabilities?.claim_gate_v1 === true,
        heartbeat_at: now,
        failure: null,
        probes: Object.fromEntries(sources.map((source) => [source, {}])),
      };
      if (session.agentBusAddressId && sources.includes('peer')) {
        const address = stageNativeIdentity(context, session, input.native_session_id, now, runtime);
        stageUpdate(context, 'agentBusAddresses', address.id, {
          receiveHeartbeatAt: null,
          lastUpstreamSessionId: input.native_session_id,
          continuity: 'native',
          adapterProtocol: input.protocol,
        });
      }
      stageUpdate(context, 'agentSessions', id, {
        receiver: next,
        upstreamSessionId: input.native_session_id,
        adapterProtocol: input.protocol,
        receiveHeartbeatAt: null,
        relayHeartbeatAt: null,
        relayEnabled: sources.includes('portal') ? 1 : 0,
      });
      return null;
    },
  });
  if (legacy) drain!.receiverRebind(id, token, input.generation, input.native_session_id);
  return response(runtime, id);
}
export async function updateOwnedReceiver(
  runtime: OwnerRuntime,
  id: string,
  token: string,
  generation: string,
  operation: 'heartbeat' | 'stop' | 'ack',
  input: { source?: ReceiverSource; nonce?: string; failure?: string; claim_gate?: ReceiverClaimGate },
) {
  const legacy =
    operation === 'heartbeat' &&
    Boolean(legacyDrainFor(runtime)?.renew('session', id, token, { receiverGeneration: generation }));
  const session = authorize(runtime, id, token, input.source),
    state = receiverState(session.receiver);
  if (!state || state.generation !== generation)
    throw new ConflictError('Receiver generation changed', 'receiver_generation_changed');
  if (operation === 'ack') {
    const probe = input.source ? state.probes[input.source] : undefined;
    if (!probe || !input.nonce || probe.nonce !== input.nonce || !probe.delivered_at)
      throw new ConflictError('Probe does not match this delivery', 'receiver_probe_mismatch');
    return { receiver: ownedReceiverView(runtime, session) };
  }
  if (operation === 'heartbeat') {
    if (
      state.failure ||
      (!legacy && !ownerPresence(runtime).hasReceiver(id, session.bindingGeneration, generation))
    )
      throw new ConflictError('Receiver connection unavailable', 'receiver_expired');
    if (input.claim_gate && !state.claim_gate_v1)
      throw new ConflictError('Receiver claim gate not negotiated', 'receiver_claim_gate_unsupported');
    if (input.claim_gate)
      for (const attachment of ownerPresence(runtime).session(id, session.bindingGeneration, 'receiver'))
        if (attachment.scope.receiver_generation === generation)
          ownerPresence(runtime).update(attachment.id, {
            generation,
            gate: { state: input.claim_gate.state, seconds: input.claim_gate.seconds },
            observed_at: new Date().toISOString(),
          });
    return { receiver: ownedReceiverView(runtime, session) };
  }
  if (state.failure === (input.failure ?? 'receiver_stopped'))
    return { receiver: ownedReceiverView(runtime, session) };
  await mutateOwnerState(runtime, {
    kind: 'receiver.stop',
    payload: { id, generation, failure: input.failure ?? 'receiver_stopped' },
    authorize: (s) => {
      const current = ownedSessionAuthority(s, id, token).session;
      if (receiverState(current.receiver)?.generation !== generation)
        throw new ConflictError('Receiver generation changed', 'receiver_generation_changed');
    },
    prepare(context) {
      const current = context.snapshot.sessions.get(id)!,
        next = { ...receiverState(current.receiver)!, failure: input.failure ?? 'receiver_stopped' };
      stageUpdate(context, 'agentSessions', id, {
        receiver: next,
        receiveHeartbeatAt: null,
        relayHeartbeatAt: null,
        relayEnabled: 0,
      });
      if (current.agentBusAddressId) {
        waitForPresence(context, current.agentBusAddressId);
        stageUpdate(context, 'agentBusAddresses', current.agentBusAddressId, { receiveHeartbeatAt: null });
      }
      return null;
    },
  });
  return { receiver: ownedReceiverView(runtime, runtime.state.snapshot().sessions.get(id)!) };
}
export function assertOwnedReceiverClaim(
  runtime: OwnerRuntime,
  id: string,
  token: string,
  generation: string,
  source: ReceiverSource,
) {
  const session = authorize(runtime, id, token, source);
  if (
    receiverState(session.receiver)?.generation !== generation ||
    !ownedReceiverReady(runtime, session, source)
  )
    throw new ConflictError('Receiver is unavailable', 'receiver_expired');
  return session;
}
export function statusOwnedReceiver(runtime: OwnerRuntime, id: string, token: string) {
  return { receiver: ownedReceiverView(runtime, authorize(runtime, id, token)) };
}
export async function retryOwnedReceiver(runtime: OwnerRuntime, id: string) {
  await mutateOwnerState(runtime, {
    kind: 'receiver.retry',
    payload: { id },
    prepare(context) {
      const session = context.snapshot.sessions.get(id),
        state = receiverState(session?.receiver);
      if (!session || session.endedAt || !state)
        throw new ConflictError('No active receiver', 'receiver_missing');
      stageUpdate(context, 'agentSessions', id, {
        receiver: { ...state, failure: 'reconnect_requested', generation: randomUUID() },
        receiveHeartbeatAt: null,
        relayHeartbeatAt: null,
        relayEnabled: 0,
      });
      if (session.agentBusAddressId) {
        waitForPresence(context, session.agentBusAddressId);
        stageUpdate(context, 'agentBusAddresses', session.agentBusAddressId, { receiveHeartbeatAt: null });
      }
      return null;
    },
  });
  return { reconnect_requested: true, verification_requested: true };
}
