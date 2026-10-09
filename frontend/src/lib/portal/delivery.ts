import type { EventRow } from "./types";

export type Delivery = "sending" | "queued" | "delivered" | "read" | "processing" | "replied" | "failed" | "canceled";
export interface DeliveryActivity { presence: string; active_turn_id?: string | null; heartbeat_at?: string }

export const DELIVERY_LABEL: Record<Delivery, string> = {
  sending: "Sending…",
  queued: "Queued",
  delivered: "Delivered to agent",
  read: "Read by AI",
  processing: "AI is working…",
  replied: "Replied",
  failed: "Not delivered",
  canceled: "Not delivered — the agent never picked this up",
};

/** Only explicitly correlated receipts advance a message; transport is not reading. */
export function deliveryIndex(events: EventRow[]): Map<string, Delivery> {
  const index = new Map<string, Delivery>();
  const rank: Partial<Record<Delivery, number>> = { delivered: 1, read: 2, processing: 3, replied: 4 };
  for (const event of events) {
    const messageId = event.payload.message_id;
    if (typeof messageId !== "string") continue;
    const state: Delivery | undefined = ({ message_accepted: "delivered", message_read: "read",
      message_processing: "processing", assistant_message: "replied" } as Record<string, Delivery>)[event.type];
    const current = index.get(messageId);
    if (state) {
      if ((rank[state] ?? 0) >= (rank[current!] ?? 0)) index.set(messageId, state);
    } else if (!rank[current!]) {
      if (event.type === "message_canceled") index.set(messageId, "canceled");
      else if (event.type === "failed" && !current) index.set(messageId, "failed");
    }
  }
  return index;
}

export function deliveryFor(event: EventRow, index: Map<string, Delivery>, activity?: DeliveryActivity, now = Date.now()): Delivery | null {
  if (event.type !== "user_message") return null;
  const messageId = event.payload.message_id;
  if (typeof messageId !== "string") return null;
  const resolved = index.get(messageId);
  // A stored start is historical evidence. Show ongoing work only while the
  // server still reports this exact turn as working, never for an older bubble.
  if (resolved === "processing") return activity?.presence === "working" && activity.active_turn_id === messageId && Number.isFinite(Date.parse(activity.heartbeat_at ?? "")) && now - Date.parse(activity.heartbeat_at!) >= 0 && now - Date.parse(activity.heartbeat_at!) < 45_000 ? "processing" : "read";
  if (resolved) return resolved;
  return event.payload.delivery_status === "sending" ? "sending" : "queued";
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
