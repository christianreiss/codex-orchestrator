import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { EventRow } from "./types";

// `node --test` strips types but resolves specifiers verbatim, so the runtime
// import needs the ".ts" extension TypeScript rejects on a static import.
const groupingModule: string = "./grouping.ts";
const { buildTimeline, dayLabel, eventText, roleFor } = (await import(groupingModule)) as typeof import("./grouping");

let cursor = 0;
function event(type: string, at: string, payload: Record<string, unknown> = {}): EventRow {
  cursor += 1;
  return { cursor, session_id: "a", type, source: "engine", payload, created_at: at };
}

const T = (minute: number, second = 0) =>
  `2026-08-01T12:${String(minute).padStart(2, "0")}:${String(second).padStart(2, "0")}.000Z`;

describe("roleFor", () => {
  // The original bug: attention shared a bucket with progress, so the one thing
  // demanding a human rendered exactly like the noise around it.
  it("separates attention from routine status", () => {
    assert.equal(roleFor(event("attention", T(0))), "attention");
    assert.equal(roleFor(event("progress", T(0))), "status");
    assert.notEqual(roleFor(event("attention", T(0))), roleFor(event("progress", T(0))));
  });

  it("maps each signal to its own presentation", () => {
    assert.equal(roleFor(event("user_message", T(0))), "you");
    assert.equal(roleFor(event("assistant_message", T(0))), "agent");
    assert.equal(roleFor(event("waiting_input", T(0))), "prompt");
    assert.equal(roleFor(event("close_requested", T(0))), "close");
    assert.equal(roleFor(event("completed", T(0))), "lifecycle");
    assert.equal(roleFor(event("terminal_block", T(0))), "status");
  });
});

describe("eventText", () => {
  it("reads text for messages and summary for everything else", () => {
    assert.equal(eventText(event("assistant_message", T(0), { text: "hi" })), "hi");
    assert.equal(eventText(event("attention", T(0), { summary: "look" })), "look");
    assert.equal(eventText(event("waiting_input", T(0), { question: "ok?" })), "ok?");
    assert.equal(eventText(event("message_accepted", T(0))), "Instruction accepted by the running agent.");
    assert.equal(eventText(event("terminal_block", T(0))), "terminal block");
  });
});

describe("buildTimeline", () => {
  it("opens with a day separator and labels today and yesterday", () => {
    const now = new Date("2026-08-01T13:00:00.000Z");
    const items = buildTimeline([event("assistant_message", T(0), { text: "a" })], now);
    assert.equal(items[0]!.kind, "day");
    assert.equal(dayLabel(T(0), now), "Today");
    assert.equal(dayLabel("2026-07-31T12:00:00.000Z", now), "Yesterday");
  });

  it("groups consecutive same-sender bubbles and tails only the last", () => {
    const items = buildTimeline([
      event("assistant_message", T(0), { text: "one" }),
      event("assistant_message", T(1), { text: "two" }),
      event("user_message", T(2), { text: "reply" }),
    ]);
    const bubbles = items.filter((i) => i.kind === "event") as Extract<typeof items[number], { kind: "event" }>[];
    assert.deepEqual(bubbles.map((b) => [b.role, b.startsGroup, b.endsGroup]), [
      ["agent", true, false],
      ["agent", false, true],
      ["you", true, true],
    ]);
  });

  it("breaks a group when the gap exceeds five minutes", () => {
    const items = buildTimeline([
      event("assistant_message", T(0), { text: "one" }),
      event("assistant_message", T(30), { text: "much later" }),
    ]);
    const bubbles = items.filter((i) => i.kind === "event") as Extract<typeof items[number], { kind: "event" }>[];
    assert.ok(bubbles.every((b) => b.startsGroup && b.endsGroup));
  });

  // This collapse is what physically stops attention from drowning in noise.
  it("collapses a run of three or more status events", () => {
    const items = buildTimeline([
      event("progress", T(0)), event("progress", T(1)), event("progress", T(2)), event("progress", T(3)),
      event("assistant_message", T(4), { text: "done" }),
    ]);
    const run = items.find((i) => i.kind === "run") as Extract<typeof items[number], { kind: "run" }> | undefined;
    assert.ok(run, "expected a collapsed run");
    assert.equal(run!.events.length, 4);
  });

  it("leaves short runs inline", () => {
    const items = buildTimeline([
      event("progress", T(0)), event("progress", T(1)),
      event("assistant_message", T(2), { text: "done" }),
    ]);
    assert.equal(items.find((i) => i.kind === "run"), undefined);
  });

  // Live progress must stay readable while you are watching it happen.
  it("keeps a trailing run expanded", () => {
    const items = buildTimeline([
      event("assistant_message", T(0), { text: "working" }),
      event("progress", T(1)), event("progress", T(2)), event("progress", T(3)), event("progress", T(4)),
    ]);
    assert.equal(items.find((i) => i.kind === "run"), undefined);
  });

  it("never collapses attention or a prompt into a run", () => {
    const items = buildTimeline([
      event("progress", T(0)), event("progress", T(1)),
      event("attention", T(2), { summary: "needs you" }),
      event("progress", T(3)), event("progress", T(4)), event("progress", T(5)), event("progress", T(6)),
      event("assistant_message", T(7), { text: "x" }),
    ]);
    const roles = items.filter((i) => i.kind === "event").map((i) => (i as { role: string }).role);
    assert.ok(roles.includes("attention"), "attention survived the collapse");
  });
});
