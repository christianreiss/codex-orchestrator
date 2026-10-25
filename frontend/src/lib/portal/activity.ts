import type { Agent, ActivityState } from "./types";

/** Activity does not determine whether the receiver can accept a message. */
export function liveActivity(agent: Agent, now: number): ActivityState | null {
  if (!agent.activity) return null; // Older server.
  const a = agent.activity;
  if (a.source === "portal-question" && agent.pending_prompt) return "waiting";
  const connectionBound = agent.presence_source === "connection" && a.expires_at === null;
  if (connectionBound ? ["offline", "ended"].includes(agent.presence) : !(Date.parse(a.expires_at ?? "") > now)) return "unknown";
  const receiver = agent.receiver;
  if (
    receiver &&
    (receiver.failure ||
      !(agent.presence_source === "connection" || (
        Date.parse(receiver.heartbeat_at) <= now &&
        Date.parse(receiver.heartbeat_at) > now - 45_000
      )))
  )
    return "unknown";
  return ["working", "idle", "waiting", "unknown"].includes(a.state)
    ? a.state
    : "unknown";
}

export const ACTIVITY_LABEL: Record<ActivityState, string> = {
  working: "Working",
  idle: "Idle",
  waiting: "Waiting for you",
  unknown: "Unknown",
};
