import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ServiceUnavailableError,
  UnauthorizedError,
} from '../../http/errors.js';
import { sha256 } from '../../security/hash.js';
import { safeHashEqual } from '../../services/agent-messaging/internals.js';
import { messagingHostEligibleAt } from '../../services/agent-messaging/eligibility.js';
import { isTruthyFlagValue } from '../../services/settings.js';
import { activeHostEngines, type FleetEngineState } from '../../services/host-engine-policy.js';
import { ENGINES, type Engine } from '../../util/engine.js';
import type { OwnerStateSnapshot } from './store.js';
import { ownedCredentialDeadline } from '../credentials.js';

export function ownedEngineState(snapshot: OwnerStateSnapshot): FleetEngineState {
  return Object.fromEntries(
    ENGINES.map((engine) => [engine, !isTruthyFlagValue(snapshot.setting(engine + '_engine_disabled'))]),
  ) as unknown as FleetEngineState;
}
export function requireOwnedMessaging(snapshot: OwnerStateSnapshot): void {
  if (!isTruthyFlagValue(snapshot.setting('agent_messaging_enabled'), false))
    throw new ServiceUnavailableError('Agent Messaging is disabled', 'agent_messaging_disabled');
}
export function ownedMessagingHost(snapshot: OwnerStateSnapshot, hostId: number, now = Date.now()) {
  const host = snapshot.hosts.get(hostId);
  if (
    !host ||
    !messagingHostEligibleAt(host, now) ||
    (host.secure !== 1 &&
      (!host.insecureEnabledUntil || new Date(host.insecureEnabledUntil).getTime() <= now))
  )
    throw new ForbiddenError(
      'Agent Messaging requires a currently eligible host',
      'agent_messaging_host_ineligible',
    );
  if (host.expiresAt && (!Number.isFinite(Date.parse(host.expiresAt)) || Date.parse(host.expiresAt) <= now))
    throw new ForbiddenError('Host expired', 'agent_messaging_host_ineligible');
  return host;
}
export function ownedBridge(
  snapshot: OwnerStateSnapshot,
  sessionId: string,
  rawToken: string,
  options: { allowEnded?: boolean; generation?: number; now?: number } = {},
) {
  requireOwnedMessaging(snapshot);
  const now = options.now ?? Date.now(),
    session = snapshot.sessions.get(sessionId);
  if (!session || !safeHashEqual(sha256(rawToken), session.bridgeTokenHash))
    throw new UnauthorizedError('Invalid agent bridge credential', 'agent_bridge_unauthorized');
  const host = ownedMessagingHost(snapshot, session.hostId, now);
  if (!safeHashEqual(host.authFingerprint, session.hostAuthFingerprint))
    throw new UnauthorizedError('Agent bridge host credential changed', 'agent_bridge_host_auth_changed');
  if (!activeHostEngines(host.engines, ownedEngineState(snapshot)).includes(session.engine as Engine))
    throw new ForbiddenError('Engine disabled', 'engine_disabled');
  if (session.endedAt && !options.allowEnded)
    throw new ConflictError(
      'Agent session is finished. Resume the same native conversation in a new managed launch.',
      'agent_session_finished',
      { ended_reason: 'finished', recovery: 'resume_native_conversation' },
    );
  if (!session.endedAt && ownedCredentialDeadline(snapshot, 'session', sessionId) <= now)
    throw new UnauthorizedError('Agent bridge credential expired', 'agent_bridge_expired');
  if (options.generation !== undefined && session.bindingGeneration !== options.generation)
    throw new ConflictError('Session binding generation changed', 'agent_binding_changed');
  return { session, host };
}
export function ownedAddress(snapshot: OwnerStateSnapshot, id: string, now = Date.now()) {
  const address = snapshot.addresses.get(id);
  if (!address || address.enabled !== 1 || address.archivedAt)
    throw new NotFoundError('Agent address not found', 'agent_messaging_address_not_found');
  const host = ownedMessagingHost(snapshot, address.hostId, now);
  if (!activeHostEngines(host.engines, ownedEngineState(snapshot)).includes(address.engine as Engine))
    throw new NotFoundError('Agent address not found', 'agent_messaging_address_not_found');
  return address;
}
export function ownedRelay(
  snapshot: OwnerStateSnapshot,
  relayId: string,
  rawToken: string,
  now = Date.now(),
) {
  requireOwnedMessaging(snapshot);
  const relay = snapshot.table('agentBusRelays').get(relayId);
  if (
    !relay ||
    relay.status !== 'active' ||
    !relay.tokenHash ||
    !safeHashEqual(sha256(rawToken), relay.tokenHash)
  )
    throw new UnauthorizedError('Invalid agent relay credential', 'agent_messaging_relay_unauthorized');
  const host = ownedMessagingHost(snapshot, relay.hostId, now);
  if (ownedCredentialDeadline(snapshot, 'relay', relayId) <= now)
    throw new UnauthorizedError('Agent relay credential expired', 'agent_messaging_relay_expired');
  if (!safeHashEqual(host.authFingerprint, relay.hostAuthFingerprint))
    throw new UnauthorizedError(
      'Agent relay host credential changed',
      'agent_messaging_relay_host_auth_changed',
    );
  return { relay, host };
}
