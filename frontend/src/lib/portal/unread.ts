import type { Agent, EventRow } from "./types";

export const READ_KEY = "fleetportal.read.v1";
export const PREFS_KEY = "fleetportal.prefs.v1";
/** Bounds the record so a long-lived bookmark cannot grow without limit. */
export const MAX_TRACKED_SESSIONS = 200;

export type ReadRecord = Record<string, { cursor: number; at: string }>;

/**
 * Which events are worth a badge.
 *
 * Deliberately excludes progress, terminal_block, message_accepted, started and
 * user_message. Counting progress would light up every session that is merely
 * working, which is the same "everything looks urgent" failure the redesign is
 * meant to remove.
 *
 * message_canceled is notable: it means something the operator sent was thrown
 * away, which they will otherwise never learn.
 */
const NOTABLE = new Set([
  "assistant_message",
  "attention",
  "waiting_input",
  "failed",
  "message_canceled",
]);

export function notable(event: EventRow): boolean {
  return NOTABLE.has(event.type);
}

export function parseReadRecord(raw: string | null): ReadRecord {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return {};
    const out: ReadRecord = {};
    for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
      const entry = value as { cursor?: unknown; at?: unknown };
      if (typeof entry?.cursor === "number" && typeof entry?.at === "string") {
        out[id] = { cursor: entry.cursor, at: entry.at };
      }
    }
    return out;
  } catch {
    return {};
  }
}

/** Drops sessions the API no longer returns, then caps by recency. */
export function pruneReadRecord(record: ReadRecord, liveIds: Iterable<string>): ReadRecord {
  const live = new Set(liveIds);
  const kept = Object.entries(record).filter(([id]) => live.has(id));
  kept.sort((a, b) => b[1].at.localeCompare(a[1].at));
  return Object.fromEntries(kept.slice(0, MAX_TRACKED_SESSIONS));
}

/**
 * Unread indicator for one session.
 *
 * At boot the client cannot count events for a session it has not opened -- it
 * would need one request per session. So the seed is deliberately coarse: "!"
 * when something needs you, "•" when there is merely something new, and a real
 * number only once live events have been counted this session.
 */
export type UnreadBadge = { kind: "attention" } | { kind: "dot" } | { kind: "count"; value: number } | null;

export function unreadBadge(agent: Agent, record: ReadRecord, counted: number | undefined): UnreadBadge {
  if (agent.attention) return { kind: "attention" };
  if (counted && counted > 0) return { kind: "count", value: counted };
  const seen = record[agent.id];
  if (!agent.last_event_at) return null;
  if (!seen) return { kind: "dot" };
  return agent.last_event_at > seen.at ? { kind: "dot" } : null;
}

/**
 * The read cursor advances only when the operator can actually have read the
 * message: right session, tab in front, scrolled to the bottom. Not advancing
 * while the tab is hidden is what makes the title and favicon badge survive
 * walking away from the machine.
 */
export function shouldAdvanceRead(input: {
  isSelected: boolean;
  documentVisible: boolean;
  atBottom: boolean;
}): boolean {
  return input.isSelected && input.documentVisible && input.atBottom;
}

export function titleFor(needsYou: number, unread: number): string {
  if (needsYou > 0) return `(!) ${needsYou} need${needsYou === 1 ? "s" : ""} you · Fleet agents`;
  if (unread > 0) return `(${unread}) Fleet agents`;
  return "Fleet agents";
}
