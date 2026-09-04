/**
 * Derived presence for an Agent Messaging address.
 *
 * Presence is computed from a recent timestamp; it is never read out of a
 * stored state column. That is not a style preference, it is the lesson this
 * codebase already paid for once. `AGENT_PRESENCE_STATES` in `agent-portal.ts`
 * exists because `agent_sessions.status` was written at registration and never
 * updated, so every open terminal reported `active` whether or not it could be
 * reached. A stored flag can only be wrong in one direction — it latches on the
 * last write, and the write that would clear it is exactly the one you never
 * get when a wrapper is SIGKILLed, a laptop sleeps, or an SSH session drops.
 *
 * `agent_bus_addresses.readiness` is the same trap, and worse: it only moves
 * when a caller passes `receive_capable`, which only the `agent_listen` bind
 * path ever does. For an ordinary session it is written once at registration as
 * 'resumable' and never again until finish — which also writes 'resumable'. For
 * most of the fleet it is a constant carrying no information, which is why
 * `agent_list(online: true)` used to return agents last seen a month earlier.
 *
 * The signal comes from the session, not the address, because
 * `agent_bus_addresses.last_seen_at` is bumped on state change rather than on
 * contact — and one of those state changes is `finishSession`. A logout that
 * stamps a liveness field is the bug this module exists to remove.
 */

/** Ordered most-alive first. */
export const AGENT_ADDRESS_PRESENCE_STATES = ['listening', 'online', 'resumable', 'offline', 'disabled'] as const;
export type AgentAddressPresence = (typeof AGENT_ADDRESS_PRESENCE_STATES)[number];

/**
 * Default freshness window, in seconds. Agrees with
 * `AGENT_PORTAL_HEARTBEAT_FRESH_SECONDS` (`api/src/env.ts`) so the fleet has one
 * answer; callers that can reach env should pass the configured value instead.
 *
 * The wrapper heartbeats every 15s from its own goroutine, independent of
 * whatever turn the agent is inside (`agentportal/client.go`), so a long tool
 * call cannot make a live agent look dead. Three ticks of margin.
 */
export const AGENT_PRESENCE_FRESH_SECONDS = 45;

const PRESENT: ReadonlySet<string> = new Set<AgentAddressPresence>(['listening', 'online']);

/**
 * Is there a wrapper behind this address right now?
 *
 * 'resumable' is deliberately absent: it means a session ended and could be
 * resumed, not that anyone is home. Treating it as present is what made a
 * crashed agent look online to its peers while the operator console showed it
 * offline over the same rows.
 */
export function isPresent(presence: AgentAddressPresence): boolean {
  return PRESENT.has(presence);
}

export interface PresenceAddress {
  enabled: number;
  archivedAt: string | null;
  readiness: string;
  currentSessionId: string | null;
  lastUpstreamSessionId: string | null;
  receiveHeartbeatAt: string | null;
}

export interface PresenceSession {
  heartbeatAt: string | null;
  endedAt: string | null;
}

/**
 * `freshAfter` is an ISO instant; anything stamped at or before it is stale.
 * Server-authored timestamps are fixed-width second-precision UTC
 * (`util/timestamp.ts`), so lexical comparison is ordering — the same idiom the
 * delivery gate and the `live_addresses` metric already use.
 *
 * A missing session means the binding is gone: `finishSession` nulls
 * `current_session_id`, so a clean exit drops presence on the next read rather
 * than lingering for a further window.
 */
export function deriveAddressPresence(
  address: PresenceAddress,
  session: PresenceSession | null | undefined,
  freshAfter: string,
): AgentAddressPresence {
  if (address.readiness === 'disabled' || address.enabled !== 1 || address.archivedAt) return 'disabled';
  const live =
    address.currentSessionId != null &&
    session != null &&
    session.endedAt == null &&
    session.heartbeatAt != null &&
    session.heartbeatAt > freshAfter;
  if (live) {
    const receiving = address.receiveHeartbeatAt != null && address.receiveHeartbeatAt > freshAfter;
    return receiving ? 'listening' : 'online';
  }
  return address.lastUpstreamSessionId ? 'resumable' : 'offline';
}

/** Reachable first, then resumable, then gone. Used to order peer listings. */
export const AGENT_PRESENCE_RANK: Record<AgentAddressPresence, number> = {
  listening: 0,
  online: 1,
  resumable: 2,
  offline: 3,
  disabled: 4,
};
