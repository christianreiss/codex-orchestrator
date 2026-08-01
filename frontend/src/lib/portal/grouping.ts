import type { EventRow } from "./types";

/** Consecutive bubbles from the same side merge while they stay this close. */
export const GROUP_GAP_MS = 5 * 60_000;
/** A run this long collapses; shorter runs read fine inline. */
export const COLLAPSE_RUN_AT = 3;

export type Role = "you" | "agent" | "attention" | "prompt" | "close" | "status" | "lifecycle";

/**
 * `attention` used to fall into the same bucket as `progress`, which is exactly
 * why an attention notice looked like background noise: it rendered as a small
 * grey dashed line among dozens of identical ones.
 */
export function roleFor(event: EventRow): Role {
  switch (event.type) {
    case "user_message": return "you";
    case "assistant_message": return "agent";
    case "attention": return "attention";
    case "waiting_input": return "prompt";
    case "close_requested": return "close";
    case "started":
    case "resumed":
    case "completed":
    case "failed": return "lifecycle";
    default: return "status";
  }
}

/** Only these collapse into a run; signal rows always break one. */
const COLLAPSIBLE: Role[] = ["status"];

export function eventText(event: EventRow): string {
  const payload = event.payload;
  if (typeof payload.text === "string") return payload.text;
  if (typeof payload.question === "string") return payload.question;
  if (typeof payload.summary === "string") return payload.summary;
  if (event.type === "message_accepted") return "Instruction accepted by the running agent.";
  return String(event.type).replaceAll("_", " ");
}

export function dayKey(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toDateString();
}

export function dayLabel(iso: string, now = new Date()): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const today = now.toDateString();
  const yesterday = new Date(now.getTime() - 86_400_000).toDateString();
  const key = date.toDateString();
  if (key === today) return "Today";
  if (key === yesterday) return "Yesterday";
  return new Intl.DateTimeFormat(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: date.getFullYear() === now.getFullYear() ? undefined : "numeric",
  }).format(date);
}

export type TimelineItem =
  | { kind: "day"; id: string; label: string }
  | { kind: "event"; id: string; event: EventRow; role: Role; startsGroup: boolean; endsGroup: boolean }
  | { kind: "run"; id: string; events: EventRow[] };

/**
 * Turns the flat event list into what the thread renders: day separators,
 * bubble groups, and collapsed runs of status noise.
 *
 * A run that is the last thing in the timeline stays expanded, so live progress
 * remains visible while you are watching it happen.
 */
export function buildTimeline(events: EventRow[], now = new Date()): TimelineItem[] {
  const items: TimelineItem[] = [];
  let lastDay = "";
  let index = 0;

  while (index < events.length) {
    const event = events[index]!;
    const day = dayKey(event.created_at);
    if (day !== lastDay) {
      items.push({ kind: "day", id: `day:${day}`, label: dayLabel(event.created_at, now) });
      lastDay = day;
    }

    const role = roleFor(event);
    if (COLLAPSIBLE.includes(role)) {
      const run: EventRow[] = [];
      let cursor = index;
      while (
        cursor < events.length &&
        COLLAPSIBLE.includes(roleFor(events[cursor]!)) &&
        dayKey(events[cursor]!.created_at) === day
      ) {
        run.push(events[cursor]!);
        cursor += 1;
      }
      const reachesEnd = cursor >= events.length;
      if (run.length >= COLLAPSE_RUN_AT && !reachesEnd) {
        items.push({ kind: "run", id: `run:${run[0]!.cursor}`, events: run });
      } else {
        for (const row of run) {
          items.push({ kind: "event", id: `e:${row.cursor}`, event: row, role: "status", startsGroup: true, endsGroup: true });
        }
      }
      index = cursor;
      continue;
    }

    const previous = events[index - 1];
    const next = events[index + 1];
    const groups = role === "you" || role === "agent";
    const continues = (other: EventRow | undefined) =>
      Boolean(
        other &&
          roleFor(other) === role &&
          dayKey(other.created_at) === day &&
          Math.abs(Date.parse(other.created_at) - Date.parse(event.created_at)) < GROUP_GAP_MS,
      );

    items.push({
      kind: "event",
      id: `e:${event.cursor}`,
      event,
      role,
      startsGroup: !groups || !continues(previous),
      endsGroup: !groups || !continues(next),
    });
    index += 1;
  }

  return items;
}
