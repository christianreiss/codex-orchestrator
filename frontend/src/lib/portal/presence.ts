import type { Agent, Presence } from "./types";

/**
 * Fallback for AGENT_PORTAL_HEARTBEAT_FRESH_SECONDS. The API serves the real
 * value on `GET /go/api/state`; this is only what the first render uses before
 * that lands, so the two can no longer drift permanently.
 */
export const HEARTBEAT_FRESH_MS = 45_000;

/** Set from the served timings once bootstrap completes. */
let heartbeatFreshMs = HEARTBEAT_FRESH_MS;

export function setHeartbeatFreshMs(seconds: number | undefined): void {
  if (typeof seconds === "number" && Number.isFinite(seconds) && seconds > 0) {
    heartbeatFreshMs = seconds * 1000;
  }
}

export function heartbeatFreshWindowMs(): number {
  return heartbeatFreshMs;
}

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
  if (Number.isFinite(beat) && now - beat > heartbeatFreshMs) return "offline";
  return agent.presence;
}

/**
 * `idle` used to cover three different situations. The third — the agent
 * accepted an instruction and is executing it — is now `working`, reported from
 * `active_turn_id` rather than guessed, so the remaining two can be named
 * plainly. Nothing here says "Busy" for an agent whose operator simply never
 * opened a relay.
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

/** Coarse age for a sentence, e.g. "4m". Seconds are noise at this scale. */
export function coarseAge(iso: string | null, now: number): string | null {
  const at = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(at)) return null;
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  return `${Math.floor(seconds / 3600)}h`;
}

/**
 * How long the session stays readable. The retention window is server
 * configuration, so the sentence is built from the served `expires_at` rather
 * than the "24 hours" that used to be typed into the UI in two places.
 */
export function endedDetail(agent: Agent, now: number): string {
  const at = agent.expires_at ? Date.parse(agent.expires_at) : NaN;
  if (!Number.isFinite(at) || at <= now) return "Finished";
  const hours = Math.round((at - now) / 3_600_000);
  if (hours < 1) return "Finished — readable for a little longer";
  return `Finished — readable for ${hours} more ${hours === 1 ? "hour" : "hours"}`;
}

export function presenceView(agent: Agent, now: number): PresenceView {
  const presence = livePresence(agent, now);
  switch (presence) {
    case "listening":
      return { presence, label: "Listening", detail: "You can reply", canSend: true };
    case "working": {
      const age = coarseAge(agent.active_turn_started_at, now);
      return {
        presence,
        label: "Working",
        // Still sendable: the agent returns to its relay when the turn ends and
        // picks the queue up then. Refusing here would be the old behaviour,
        // where a busy agent looked unreachable.
        detail: age ? `Running your instruction — started ${age} ago` : "Running your instruction",
        canSend: true,
      };
    }
    case "idle":
      return { presence, label: "Not listening", detail: notListeningDetail(agent), canSend: false };
    case "offline":
      return {
        presence,
        label: "Offline",
        detail: "No heartbeat — the session can only be ended from here",
        canSend: false,
      };
    case "ended":
      return { presence, label: "Ended", detail: endedDetail(agent, now), canSend: false };
  }
}

/**
 * Sidebar grouping. "Needs you" is first and is orthogonal to presence: an
 * agent that has gone offline while waiting for an answer still needs you.
 */
export type GroupKey = "attention" | "working" | "listening" | "idle" | "offline" | "ended";

export const GROUP_ORDER: GroupKey[] = [
  "attention",
  "working",
  "listening",
  "idle",
  "offline",
  "ended",
];

export const GROUP_LABEL: Record<GroupKey, string> = {
  attention: "Needs you",
  working: "Working",
  listening: "Listening",
  idle: "Not listening",
  offline: "Offline",
  ended: "Recently ended",
};

export function groupFor(agent: Agent, now: number): GroupKey {
  const presence = livePresence(agent, now);
  // An ended session cannot be answered, so it must not hold a "Needs you"
  // slot: a crashed agent used to sit at the top of the list, unanswerable, for
  // the whole retention window. The server stops reporting attention for a
  // terminal session and this is the same rule applied locally, which also
  // covers the poll interval during which the client still holds the old row.
  if (presence === "ended") return "ended";
  if (agent.attention) return "attention";
  return presence;
}

export function groupAgents(agents: Agent[], now: number): Array<{ key: GroupKey; agents: Agent[] }> {
  const buckets = new Map<GroupKey, Agent[]>(GROUP_ORDER.map((key) => [key, []]));
  for (const agent of agents) buckets.get(groupFor(agent, now))!.push(agent);
  for (const list of buckets.values()) {
    list.sort((a, b) => (b.last_event_at ?? b.started_at).localeCompare(a.last_event_at ?? a.started_at));
  }
  return GROUP_ORDER.map((key) => ({ key, agents: buckets.get(key)! })).filter((g) => g.agents.length > 0);
}
