import type { AgentSession } from '../../db/schema.js';
import { ConflictError, ForbiddenError } from '../../http/errors.js';
import { normalizeOptionalText, normalizeSessionStatus } from '../../services/agent-messaging/normalize.js';
import { publicAddress } from '../../services/agent-messaging/views.js';
import { receiverState } from '../../services/agent-receiver-state.js';
import type { Json } from '../commands.js';
import { canonicalCommand } from '../commands.js';
import { ownedCredentialDeadline } from '../credentials.js';
import { ownerPresence } from '../presence.js';
import { ownedAddress, ownedBridge } from './messaging.js';
import { stageUpdate } from './rows.js';
import { mutateOwnerState, type OwnerRuntime } from './runtime.js';
import { assertOwnedHousekeeping, stageNativeIdentity } from './session-lifecycle.js';
import type { OwnerStateSnapshot } from './store.js';

export interface SessionUpdate {
  status?: string;
  upstreamSessionId?: string | null;
  adapterProtocol?: string | null;
  adapterCapabilities?: Record<string, unknown> | null;
  receiveCapable?: boolean;
  expectedBindingGeneration?: number | null;
  continuity?: 'native' | 'reset';
  skipIfUnbound?: boolean;
}
const json = (value: unknown): Json => JSON.parse(JSON.stringify(value)) as Json;
function inspect(
  runtime: OwnerRuntime,
  snapshot: OwnerStateSnapshot,
  sessionId: string,
  token: string,
  input: SessionUpdate,
) {
  const { session } = ownedBridge(snapshot, sessionId, token);
  if (
    snapshot
      .table('sessionHousekeepingReservations')
      .by('hostId', session.hostId)
      .some((row) => row.engine === session.engine)
  )
    throw new ConflictError(
      'Session housekeeping is recovering or running on this host',
      'session_housekeeping_busy',
    );
  if (!session.agentBusAddressId) {
    if (input.skipIfUnbound) return null;
    throw new ConflictError('Agent session has no messaging address', 'agent_messaging_address_missing');
  }
  const address = ownedAddress(snapshot, session.agentBusAddressId);
  if (
    address.currentSessionId !== session.id ||
    (input.expectedBindingGeneration != null && address.bindingGeneration !== input.expectedBindingGeneration)
  )
    throw new ConflictError('Agent address binding changed', 'agent_messaging_binding_stale');
  const receiver = receiverState(session.receiver);
  if (
    receiver &&
    !receiver.failure &&
    ownerPresence(runtime).hasReceiver(session.id, session.bindingGeneration, receiver.generation) &&
    input.receiveCapable !== undefined
  )
    throw new ConflictError('Automatic receiver owns this session', 'receiver_owned');
  const upstream = normalizeOptionalText(input.upstreamSessionId, 255) ?? session.upstreamSessionId;
  if (input.upstreamSessionId && receiver && !receiver.failure && receiver.native_session_id !== upstream)
    throw new ConflictError('Automatic receiver owns the native identity', 'receiver_owned');
  const patch: Partial<AgentSession> = {
    status: normalizeSessionStatus(input.status) ?? session.status,
    upstreamSessionId: upstream,
    adapterProtocol: normalizeOptionalText(input.adapterProtocol, 32) ?? session.adapterProtocol,
    adapterCapabilities: input.adapterCapabilities ? {...input.adapterCapabilities, ...((session.adapterCapabilities as Record<string,unknown>|null)?.supervisor_model ? {supervisor_model:(session.adapterCapabilities as Record<string,unknown>).supervisor_model} : {})} : session.adapterCapabilities,
  };
  const continuity = input.continuity ?? (upstream ? 'native' : address.continuity);
  const changed =
    Object.entries(patch).some(
      ([field, value]) =>
        canonicalCommand(json(value)) !== canonicalCommand(json(session[field as keyof AgentSession])),
    ) || continuity !== address.continuity;
  return { session, address, patch, continuity, changed };
}
export async function updateOwnedSession(
  runtime: OwnerRuntime,
  sessionId: string,
  token: string,
  input: SessionUpdate,
): Promise<Record<string, unknown> | null> {
  runtime.assertOwner();
  const initial = inspect(runtime, runtime.state.snapshot(), sessionId, token, input);
  if (!initial) return null;
  const view = (snapshot: OwnerStateSnapshot) => {
    const { session } = ownedBridge(snapshot, sessionId, token);
    if (!session.agentBusAddressId) return null;
    const address = ownedAddress(snapshot, session.agentBusAddressId);
    return {
      enabled: true,
      expires_at: new Date(ownedCredentialDeadline(snapshot, 'session', sessionId)).toISOString(),
      status: session.status,
      address: publicAddress(address),
      ownership_mode: 'connection',
    };
  };
  if (!initial.changed) return view(runtime.state.snapshot());
  await mutateOwnerState(runtime, {
    kind: 'messaging.session.update',
    principal: `session:${sessionId}`,
    payload: json({ sessionId, input }),
    authorize(snapshot) {
      ownedBridge(snapshot, sessionId, token, { generation: initial.session.bindingGeneration });
    },
    prepare(context) {
      const current = inspect(runtime, context.snapshot, sessionId, token, input);
      if (!current) return null;
      assertOwnedHousekeeping(context, current.session.hostId, current.session.engine);
      const now = new Date().toISOString();
      const address =
        input.upstreamSessionId && current.patch.upstreamSessionId
          ? stageNativeIdentity(context, current.session, current.patch.upstreamSessionId, now, runtime)
          : current.address;
      if (!address || address.archivedAt || !address.enabled)
        throw new ForbiddenError('Agent address is disabled', 'agent_messaging_address_disabled');
      stageUpdate(context, 'agentSessions', sessionId, { ...current.patch, updatedAt: now });
      stageUpdate(context, 'agentBusAddresses', address.id, {
        lastUpstreamSessionId: current.patch.upstreamSessionId ?? address.lastUpstreamSessionId,
        continuity: current.continuity,
        adapterProtocol: current.patch.adapterProtocol,
        adapterCapabilities: current.patch.adapterCapabilities,
        updatedAt: now,
      });
      return null;
    },
  });
  return view(runtime.state.snapshot());
}
