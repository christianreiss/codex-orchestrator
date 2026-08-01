import type { Agent, Presence } from "./types";

/** Matches AGENT_PORTAL_HEARTBEAT_FRESH_SECONDS in the API. */
export const HEARTBEAT_FRESH_MS = 45_000;

export interface PresenceView {
  presence: Presence;
  /** Short word shown in the chat list and thread header. */
  label: string;
  /** The sentence under it. Never "Busy" — see notListeningDetail(). */
  detail: string;
  canSend: boolean;
}

/**
 * The server computes presence when it answers, but heartbeats go stale on
 * wall-clock time. Without this the UI would keep claiming an agent is
 * listening for up to a full poll interval after it stopped.
 */
export function livePresence(agent: Agent, now: number): Presence {
  if (agent.presence === "ended") return "ended";
  const beat = Date.parse(agent.heartbeat_at);
  if (Number.isFinite(beat) && now - beat > HEARTBEAT_FRESH_MS) return "offline";
  return agent.presence;
}

/**
 * `idle` covers three different situations and they need different words.
 * Calling all of them "Busy" would be wrong for every one: nothing is busy when
 * the operator simply never opened a relay.
 */
export function notListeningDetail(agent: Agent): string {
  switch (agent.close?.state) {
    case "pending":
      return "Closing — waiting for the agent to pick up the note";
    case "acknowledged":
      return "Closed by you — the terminal is still open";
    case "undeliverable":
      return "The close could not be delivered";
    default:
      return "Run #afk in the local session to open the relay";
  }
}

export function presenceView(agent: Agent, now: number): PresenceView {
  const presence = livePresence(agent, now);
  switch (presence) {
    case "listening":
      return { presence, label: "Listening", detail: "You can reply", canSend: true };
    case "idle":
      return { presence, label: "Not listening", detail: notListeningDetail(agent), canSend: false };
    case "offline":
      return { presence, label: "Offline", detail: "No heartbeat in the last 45 seconds", canSend: false };
    case "ended":
      return { presence, label: "Ended", detail: "Finished — readable for 24 hours", canSend: false };
  }
}

/**
 * Sidebar grouping. "Needs you" is first and is orthogonal to presence: an
 * agent that has gone offline while waiting for an answer still needs you.
 */
export type GroupKey = "attention" | "listening" | "idle" | "offline" | "ended";

export const GROUP_ORDER: GroupKey[] = ["attention", "listening", "idle", "offline", "ended"];

export const GROUP_LABEL: Record<GroupKey, string> = {
  attention: "Needs you",
  listening: "Listening",
  idle: "Not listening",
  offline: "Offline",
  ended: "Recently ended",
};

export function groupFor(agent: Agent, now: number): GroupKey {
  if (agent.attention) return "attention";
  return livePresence(agent, now);
}

export function groupAgents(agents: Agent[], now: number): Array<{ key: GroupKey; agents: Agent[] }> {
  const buckets = new Map<GroupKey, Agent[]>(GROUP_ORDER.map((key) => [key, []]));
  for (const agent of agents) buckets.get(groupFor(agent, now))!.push(agent);
  for (const list of buckets.values()) {
    list.sort((a, b) => (b.last_event_at ?? b.started_at).localeCompare(a.last_event_at ?? a.started_at));
  }
  return GROUP_ORDER.map((key) => ({ key, agents: buckets.get(key)! })).filter((g) => g.agents.length > 0);
}
