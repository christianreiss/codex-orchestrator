import type { AgentSessionRow, AgentSessionsResponse } from "../api/agentSessions";
import type { PresenceTimings } from "./types";
import { livePresence } from "./presence";

export type ClientFilter = "all" | "active" | "online" | "attention" | "working" | "listening" | "idle" | "offline" | "ended";
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

export function clientCounts(rows: AgentSessionRow[], now: number, timings: PresenceTimings = {}) {
  const counts = { online: 0, attention: 0, offline: 0, ended: 0, codex: 0, claude: 0 };
  for (const row of rows) {
    const presence = livePresence(row, now, timings);
    counts[row.engine]++;
    if (presence === "ended") counts.ended++;
    else {
      if (row.attention || row.pending_prompt) counts.attention++;
      if (presence === "offline") counts.offline++;
      else counts.online++;
    }
  }
  return counts;
}

export function visibleClients(
  rows: AgentSessionRow[],
  options: { search: string; engine: "all" | "codex" | "claude"; filter: ClientFilter; sort: ClientSort },
  now: number,
  timings: PresenceTimings = {},
): AgentSessionRow[] {
  const terms = options.search.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const filtered = rows.filter((row) => {
    if (options.engine !== "all" && row.engine !== options.engine) return false;
    const presence = livePresence(row, now, timings);
    if (options.filter === "active" && presence === "ended") return false;
    if (options.filter === "online" && (presence === "ended" || presence === "offline")) return false;
    if (options.filter === "attention" && (!(row.attention || row.pending_prompt) || presence === "ended")) return false;
    if (!["all", "active", "online", "attention"].includes(options.filter) && presence !== options.filter) return false;
    const text = [row.id, row.engine, row.username, row.host, row.cwd, row.invocation_kind,
      row.work.task, row.work.branch, row.work.target_branch, row.work.worktree_path,
      row.work.address, row.work.address_alias, ...row.work.declared_paths].filter(Boolean).join(" ").toLocaleLowerCase();
    return terms.every((term) => text.includes(term));
  });
  const order = { working: 1, listening: 2, idle: 3, offline: 4, ended: 5 };
  const priority = (row: AgentSessionRow) => {
    const presence = livePresence(row, now, timings);
    return (row.attention || row.pending_prompt) && presence !== "ended" ? 0 : order[presence];
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
