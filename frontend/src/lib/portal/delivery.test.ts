import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { EventRow } from "./types";

// `node --test` strips types but resolves specifiers verbatim, so the runtime
// import needs the ".ts" extension TypeScript rejects on a static import.
const deliveryModule: string = "./delivery.ts";
const { deliveryFor, deliveryIndex, isOptimistic, optimisticEvent, reconcileOptimistic } = (await import(deliveryModule)) as typeof import("./delivery");

let cursor = 0;
function event(type: string, payload: Record<string, unknown> = {}): EventRow {
  cursor += 1;
  return { cursor, session_id: "a", type, source: "portal", payload, created_at: "2026-08-01T12:00:00.000Z" };
}

describe("delivery state", () => {
  it("reads queued off the event the API writes at enqueue time", () => {
    const sent = event("user_message", { message_id: "m1", text: "hi", delivery_status: "queued" });
    assert.equal(deliveryFor(sent, deliveryIndex([sent])), "queued");
  });

  // Acceptance arrives as a separate later event, so it has to be assembled
  // across the timeline rather than read off the message row.
  it("promotes to delivered when message_accepted names the same message", () => {
    const sent = event("user_message", { message_id: "m1", text: "hi" });
    const accepted = event("message_accepted", { message_id: "m1" });
    assert.equal(deliveryFor(sent, deliveryIndex([sent, accepted])), "delivered");
  });

  it("marks a failure that names the message", () => {
    const sent = event("user_message", { message_id: "m1", text: "hi" });
    const failed = event("failed", { message_id: "m1" });
    assert.equal(deliveryFor(sent, deliveryIndex([sent, failed])), "failed");
  });

  it("lets an acceptance win over a later unrelated failure", () => {
    const sent = event("user_message", { message_id: "m1", text: "hi" });
    const accepted = event("message_accepted", { message_id: "m1" });
    const failed = event("failed", { message_id: "m1" });
    assert.equal(deliveryFor(sent, deliveryIndex([sent, accepted, failed])), "delivered");
  });

  it("reports nothing for incoming messages", () => {
    const incoming = event("assistant_message", { text: "hello" });
    assert.equal(deliveryFor(incoming, deliveryIndex([incoming])), null);
  });
});

describe("optimistic sends", () => {
  it("uses a negative cursor so it sorts last and keys stably", () => {
    const optimistic = optimisticEvent("a", "c1", "hello", "2026-08-01T12:00:00.000Z");
    assert.ok(isOptimistic(optimistic));
    assert.ok(optimistic.cursor < 0);
    assert.equal(deliveryFor(optimistic, new Map()), "sending");
  });

  // The server mints its own message_id, so the pairing is the text.
  it("drops the placeholder when the real event arrives", () => {
    const optimistic = optimisticEvent("a", "c1", "hello", "2026-08-01T12:00:00.000Z");
    const real = event("user_message", { message_id: "server-id", text: "hello" });
    const next = reconcileOptimistic([optimistic], real);
    assert.equal(next.length, 0);
  });

  it("leaves the timeline alone for unrelated events", () => {
    const optimistic = optimisticEvent("a", "c1", "hello", "2026-08-01T12:00:00.000Z");
    const other = event("assistant_message", { text: "hello" });
    assert.equal(reconcileOptimistic([optimistic], other).length, 1);
  });
});

describe("message_canceled", () => {
  // A message accepted into the queue and then discarded because nothing ever
  // claimed it used to read "Queued" for the rest of the session's life, so the
  // operator never learned their instruction had been thrown away.
  it("reports a message nothing ever picked up as not delivered", () => {
    const sent = event("user_message", { message_id: "m1", text: "hi", delivery_status: "queued" });
    const events = [sent, event("message_canceled", { message_id: "m1" })];
    const index = deliveryIndex(events);
    assert.equal(index.get("m1"), "canceled");
    assert.equal(deliveryFor(sent, index), "canceled");
  });

  // Acceptance is the agent confirming it holds the work; a later cancel is
  // reporting on a lease that was already honoured.
  it("never downgrades an accepted message", () => {
    const sent = event("user_message", { message_id: "m1", text: "hi", delivery_status: "queued" });
    const events = [
      sent,
      event("message_accepted", { message_id: "m1" }),
      event("message_canceled", { message_id: "m1" }),
    ];
    assert.equal(deliveryIndex(events).get("m1"), "delivered");
  });

  it("leaves other messages alone", () => {
    const sent = event("user_message", { message_id: "m1", text: "hi", delivery_status: "queued" });
    const events = [sent, event("message_canceled", { message_id: "m2" })];
    assert.equal(deliveryFor(sent, deliveryIndex(events)), "queued");
  });
});
