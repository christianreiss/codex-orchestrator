import { liveActivity } from './activity';
import type { AgentSessionRow, AgentSessionsResponse } from "../api/agentSessions";
import type { PresenceTimings } from "./types";
import { livePresence } from "./presence";
import type { ChatRoom } from "../api/roomChats";

export type ClientFilter = "waiting" | "unknown" | "all" | "active" | "online" | "attention" | "working" | "listening" | "idle" | "offline" | "ended";
export type ClientSort = "status" | "recent" | "host";

/** Age server timestamps using the server snapshot clock, then elapsed browser time. */
export function clientClock(snapshot: AgentSessionsResponse | undefined, updatedAt: number, now: number): number {
  const generated = snapshot?.generated_at ? Date.parse(snapshot.generated_at) : NaN;
  return Number.isFinite(generated) && updatedAt > 0 ? generated + Math.max(0, now - updatedAt) : now;
}

export function snapshotIsStale(updatedAt: number, now: number, timings: PresenceTimings = {}): boolean {
  const window = timings.heartbeat_fresh_seconds;
  const freshMs = typeof window === "number" && Number.isFinite(window) && window > 0 ? window * 1000 : 45_000;
  return updatedAt <= 0 || now - updatedAt > freshMs;
}

/**
 * The Chats rule shared with the Android app: an agent is listed as a current
 * chat only while it is online (listening, working or idle) and not read-only.
 * Ended and offline agents stay out, whatever notices they carry.
 */
export function isOnlineActiveAgent(row: AgentSessionRow, now: number, timings: PresenceTimings = {}): boolean {
  if (row.read_only) return false;
  const presence = livePresence(row, now, timings);
  return presence === "listening" || presence === "working" || presence === "idle";
}

export function clientCounts(rows: AgentSessionRow[], now: number, timings: PresenceTimings = {}) {
  const counts = { online: 0, attention: 0, offline: 0, ended: 0, codex: 0, claude: 0, grok: 0 };
  for (const row of rows) {
    const presence = livePresence(row, now, timings);
    counts[row.engine]++;
    if (row.attention?.severity) counts.attention++;
    if (presence === "ended") counts.ended++;
    else {
      if (!row.attention?.severity && (row.attention || (row.pending_prompt && !row.pending_prompt.answer_mode))) counts.attention++;
      if (presence === "offline") counts.offline++;
      else counts.online++;
    }
  }
  return counts;
}

export function visibleClients(
  rows: AgentSessionRow[],
  options: { search: string; engine: "all" | "codex" | "claude" | "grok"; filter: ClientFilter; sort: ClientSort },
  now: number,
  timings: PresenceTimings = {},
): AgentSessionRow[] {
  const terms = options.search.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const filtered = rows.filter((row) => {
    if (options.engine !== "all" && row.engine !== options.engine) return false;
    const presence = livePresence(row, now, timings);
    if (options.filter === "active" && !isOnlineActiveAgent(row, now, timings)) return false;
    if (options.filter === "online" && (presence === "ended" || presence === "offline")) return false;
    if (options.filter === "attention" && (!row.attention?.severity && (!(row.attention || (row.pending_prompt && !row.pending_prompt.answer_mode)) || presence === "ended"))) return false;
    if (!["all", "active", "online", "attention"].includes(options.filter) && (presence === "offline" || presence === "ended" || options.filter === "listening" ? presence : liveActivity(row, now) ?? presence) !== options.filter) return false;
    const text = [row.id, row.launch_name, row.session_name, row.task_title, row.preview?.summary, row.engine, row.engine === "codex" ? "cdx" : row.engine === "claude" ? "clx" : "cgx", row.username, row.host, row.cwd, row.invocation_kind,
      row.work.task, row.work.branch, row.work.target_branch, row.work.worktree_path,
      row.work.address, row.work.address_alias, ...row.work.declared_paths].filter(Boolean).join(" ").toLocaleLowerCase();
    return terms.every((term) => text.includes(term));
  });
  const order = { waiting: 0.5, unknown: 3.5, working: 1, listening: 2, idle: 3, offline: 4, ended: 5 };
  const priority = (row: AgentSessionRow) => {
    const presence = livePresence(row, now, timings);
    return row.attention?.severity || ((row.attention || (row.pending_prompt && !row.pending_prompt.answer_mode)) && presence !== "ended") ? 0 : order[presence === "offline" || presence === "ended" ? presence : liveActivity(row, now) ?? presence];
  };
  const activity = (row: AgentSessionRow) => Date.parse(row.last_event_at ?? row.started_at) || 0;
  return filtered.sort((a, b) => {
    if (options.sort === "status") {
      const difference = priority(a) - priority(b);
      if (difference) return difference;
    }
    if (options.sort === "host") {
      const difference = (a.host ?? "").localeCompare(b.host ?? "") || a.username.localeCompare(b.username);
      if (difference) return difference;
    }
    return activity(b) - activity(a) || a.id.localeCompare(b.id);
  });
}

/**
 * A room is current when a reachable member is also an agent the Chats list
 * shows as online; the roster's `reachable` only means a fresh heartbeat. With
 * no agent overview (`onlineSessionIds` null) the roster flag is all there is.
 */
export function roomHasActiveAgent(room: ChatRoom, onlineSessionIds: ReadonlySet<string> | null): boolean {
  return room.members.some((m) => m.reachable && (onlineSessionIds === null || (m.session_id !== null && onlineSessionIds.has(m.session_id))));
}
