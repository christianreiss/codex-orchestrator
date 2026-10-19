import { AGENT_NAME_COOLDOWN_SECONDS } from '../agent-messaging/names.js';

/** A wake-up's agent counts as gone after the same 24 h an agent name stays reserved. */
export const SCHEDULE_TARGET_GRACE_SECONDS = AGENT_NAME_COOLDOWN_SECONDS;

type Target = { archivedAt: string | null; lastSeenAt: string } | null | undefined;
type Session = { endedAt: string | null; bridgeExpiresAt: string } | null | undefined;

/**
 * When the target agent was last known to be alive, or null while it still is.
 *
 * Mirrors `nameLeaseState`: a session that has ended (or whose bridge expired)
 * ends the agent; a brief loss of presence on a live session does not. A missing
 * or archived address is gone outright.
 */
export function targetGoneSince(target: Target, session: Session, now: string): string | null {
  if (!target) return new Date(0).toISOString();
  if (target.archivedAt) return target.archivedAt;
  if (!session) return target.lastSeenAt;
  const ended = session.endedAt ?? (Date.parse(session.bridgeExpiresAt) <= Date.parse(now) ? session.bridgeExpiresAt : null);
  if (!ended) return null;
  // Never count the agent gone earlier than the last time it was seen.
  return Date.parse(ended) > Date.parse(target.lastSeenAt) ? ended : target.lastSeenAt;
}

export function targetIsGone(target: Target, session: Session, now: Date): boolean {
  const since = targetGoneSince(target, session, now.toISOString());
  return since !== null && Date.parse(since) <= now.getTime() - SCHEDULE_TARGET_GRACE_SECONDS * 1000;
}
