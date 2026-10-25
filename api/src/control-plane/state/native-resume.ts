import { ownerPresence } from '../presence.js';
import type { OwnerRuntime } from './runtime.js';
import type { OwnerStateSnapshot } from './store.js';
import type { ScopeSession } from './coordination.js';

/** Explicit continuation after a completed lifecycle, never a disconnected-owner takeover. */
export function resumedNativeAttachment(
  owner: OwnerRuntime,
  snapshot: OwnerStateSnapshot,
  previousSessionId: string,
  previousGeneration: number,
  current: ScopeSession,
) {
  const previous = snapshot.sessions.get(previousSessionId);
  if (
    !previous ||
    previous.id === current.id ||
    previous.status !== 'completed' ||
    !previous.endedAt ||
    !Number.isFinite(Date.parse(previous.endedAt)) ||
    Date.parse(previous.endedAt) > Date.now() ||
    current.endedAt ||
    !previous.upstreamSessionId ||
    previous.upstreamSessionId !== current.upstreamSessionId ||
    !previous.agentBusAddressId ||
    previous.agentBusAddressId !== current.agentBusAddressId ||
    previous.hostId !== current.hostId ||
    previous.engine !== current.engine ||
    previous.username !== current.username ||
    previous.hostAuthFingerprint !== current.hostAuthFingerprint ||
    ![previousGeneration, previousGeneration + 1].includes(previous.bindingGeneration) ||
    ownerPresence(owner).hasSession(previous.id, previousGeneration)
  )
    return undefined;
  const address = snapshot.addresses.get(current.agentBusAddressId!);
  if (
    !address ||
    address.enabled !== 1 ||
    address.archivedAt ||
    address.currentSessionId !== current.id ||
    address.bindingGeneration !== current.bindingGeneration ||
    address.lastUpstreamSessionId !== current.upstreamSessionId
  )
    return undefined;
  return ownerPresence(owner)
    .session(current.id, current.bindingGeneration, 'session')
    .find((attachment) => attachment.scope.native_instance_id);
}
