import { legacyDrainFor } from '../legacy-drain.js';
import { ownerPresence } from '../presence.js';
import type { OwnerRuntime } from './runtime.js';
const registries = new WeakMap<OwnerRuntime, Map<number, number>>();
const stops = new WeakMap<OwnerRuntime, () => void>();
/** Operational activity only. It never extends an authorization deadline. */
export function trackHostActivity(owner: OwnerRuntime): void {
  if (registries.has(owner)) return;
  const last = new Map<number, number>();
  registries.set(owner, last);
  const presence = ownerPresence(owner);
  for (const attachment of presence.all()) last.set(attachment.hostId, Date.now());
  const stopPresence = presence.subscribe((change) => last.set(change.attachment.hostId, Date.now()));
  const stopState = owner.state.subscribe((snapshot) => {
    for (const id of last.keys()) if (!snapshot.hosts.has(id)) last.delete(id);
  });
  stops.set(owner, () => {
    stopPresence();
    stopState();
    last.clear();
    registries.delete(owner);
    stops.delete(owner);
  });
}
export function hostActivity(
  owner: OwnerRuntime,
  hostId: number,
): { connected: boolean; lastAt: number | null } {
  trackHostActivity(owner);
  const legacy = legacyDrainFor(owner)?.hostActivity(hostId);
  const connected =
    ownerPresence(owner)
      .all()
      .some((attachment) => attachment.hostId === hostId) || legacy?.connected === true;
  const lastAt = Math.max(registries.get(owner)!.get(hostId) ?? 0, legacy?.lastAt ?? 0);
  return { connected, lastAt: connected ? Date.now() : lastAt || null };
}

export function stopHostActivity(owner: OwnerRuntime): void {
  stops.get(owner)?.();
}
