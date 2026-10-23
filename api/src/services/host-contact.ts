export const CONTACT_CHECKPOINT_MS = 30_000;

const contactWrittenAt = new Map<number, number>();

/**
 * Session heartbeats name their host on every beat. Only display and pruning
 * (measured in days) read hosts.last_contact_at; presence uses session
 * evidence. So the beats persist it at the checkpoint cadence, remembered in
 * this process.
 */
export function hostContactWriteDue(hostId: number, nowMs = Date.now()): boolean {
  const last = contactWrittenAt.get(hostId);
  if (last !== undefined && nowMs >= last && nowMs - last < CONTACT_CHECKPOINT_MS) return false;
  contactWrittenAt.set(hostId, nowMs);
  return true;
}
