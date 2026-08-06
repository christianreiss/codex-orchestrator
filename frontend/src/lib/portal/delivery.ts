import type { EventRow } from "./types";

export type Delivery = "sending" | "queued" | "delivered" | "failed" | "canceled";

export const DELIVERY_LABEL: Record<Delivery, string> = {
  sending: "Sending…",
  queued: "Queued",
  delivered: "Delivered",
  failed: "Not delivered",
  canceled: "Not delivered — the agent never picked this up",
};

/**
 * Outgoing messages carry `delivery_status: "queued"` on the user_message event
 * the API writes at enqueue time. Acceptance arrives later as a separate
 * message_accepted event naming the same message_id, so the state has to be
 * assembled across the timeline rather than read off one row.
 *
 * message_canceled closes the third case: a message that was accepted into the
 * queue and then discarded because no agent ever claimed it. Without it such a
 * message reads "Queued" for the rest of the session's life.
 */
export function deliveryIndex(events: EventRow[]): Map<string, Delivery> {
  const index = new Map<string, Delivery>();
  for (const event of events) {
    const messageId = event.payload.message_id;
    if (typeof messageId !== "string") continue;
    // Acceptance is final: the agent has it, and a later cancel of the same id
    // would be reporting on a lease that was already honoured.
    if (event.type === "message_accepted") index.set(messageId, "delivered");
    else if (index.get(messageId) === "delivered") continue;
    else if (event.type === "message_canceled") index.set(messageId, "canceled");
    else if (event.type === "failed" && !index.has(messageId)) index.set(messageId, "failed");
  }
  return index;
}

export function deliveryFor(event: EventRow, index: Map<string, Delivery>): Delivery | null {
  if (event.type !== "user_message") return null;
  const messageId = event.payload.message_id;
  if (typeof messageId !== "string") return null;
  const resolved = index.get(messageId);
  if (resolved) return resolved;
  const status = event.payload.delivery_status;
  if (status === "sending") return "sending";
  return "queued";
}

/** Optimistic sends use a negative cursor so they sort last and key stably. */
export function optimisticEvent(sessionId: string, clientMessageId: string, text: string, now: string): EventRow {
  return {
    cursor: -Date.parse(now),
    session_id: sessionId,
    type: "user_message",
    source: "portal",
    payload: { message_id: clientMessageId, text, delivery_status: "sending" },
    created_at: now,
  };
}

export function isOptimistic(event: EventRow): boolean {
  return event.cursor < 0;
}

/**
 * Replaces an optimistic bubble once the real event lands. The server assigns
 * its own message_id, so the two cannot be matched by id -- the pairing is the
 * text plus the fact that only one send can be in flight per composer.
 */
export function reconcileOptimistic(timeline: EventRow[], incoming: EventRow): EventRow[] {
  if (incoming.type !== "user_message" || incoming.cursor < 0) return timeline;
  const text = incoming.payload.text;
  const match = timeline.findIndex(
    (row) => isOptimistic(row) && row.payload.text === text && row.session_id === incoming.session_id,
  );
  if (match === -1) return timeline;
  const next = [...timeline];
  next.splice(match, 1);
  return next;
}
