import type { OwnerStateSnapshot } from '../state/store.js';
import { ownedBridge } from '../state/messaging.js';
import { ForbiddenError } from '../../http/errors.js';

/** Recheck the exact bridge authority when its serialized command executes. */
export function authorizeAgentInsecureEnable(
  snapshot: OwnerStateSnapshot,
  proof: {
    sessionId: string;
    bridgeToken: string;
    bindingGeneration: number;
    hostId: number;
    addressId: string;
    targetHostId: number;
  },
): void {
  const current = ownedBridge(snapshot, proof.sessionId, proof.bridgeToken, {
    generation: proof.bindingGeneration,
  });
  if (
    current.host.id !== proof.hostId ||
    current.host.secure !== 1 ||
    current.host.status !== 'active' ||
    current.session.agentBusAddressId !== proof.addressId
  )
    throw new ForbiddenError('An active secure host is required', 'secure_host_required');
  const target = snapshot.hosts.get(proof.targetHostId);
  if (!target || target.status !== 'active') throw new ForbiddenError('Target host is inactive');
}
