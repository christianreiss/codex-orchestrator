import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Agent, EventRow } from "./types";

// `node --test` strips types but resolves specifiers verbatim, so the runtime
// import needs the ".ts" extension TypeScript rejects on a static import.
const unreadModule: string = "./unread.ts";
const { MAX_TRACKED_SESSIONS, notable, parseReadRecord, pruneReadRecord, shouldAdvanceRead, titleFor, unreadBadge } = (await import(unreadModule)) as typeof import("./unread");

function event(type: string): EventRow {
  return { cursor: 1, session_id: "a", type, source: "engine", payload: {}, created_at: "2026-08-01T12:00:00.000Z" };
}

function agent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: "a", engine: "codex", host: "crane", username: "chris", cwd: "/repo",
    status: "active", presence: "listening", relay_ready: true,
    started_at: "2026-08-01T11:00:00.000Z", heartbeat_at: "2026-08-01T11:59:50.000Z",
    last_event_at: "2026-08-01T11:59:00.000Z", ended_at: null, expires_at: null,
    read_only: false, attention: null, close_requested_at: null, close: null, pending_prompt: null,
    ...overrides,
  };
}

describe("notable", () => {
  // Counting progress would badge every working session, recreating the
  // "everything looks urgent" problem this replaces.
  it("ignores routine progress chatter", () => {
    for (const type of ["progress", "terminal_block", "message_accepted", "started", "user_message"]) {
      assert.equal(notable(event(type)), false, type);
    }
  });

  it("counts things a human has to act on", () => {
    for (const type of ["assistant_message", "attention", "waiting_input", "failed"]) {
      assert.equal(notable(event(type)), true, type);
    }
  });
});

describe("parseReadRecord", () => {
  it("survives absent, malformed and partial storage", () => {
    assert.deepEqual(parseReadRecord(null), {});
    assert.deepEqual(parseReadRecord("not json"), {});
    assert.deepEqual(parseReadRecord('{"a":{"cursor":"nope","at":"x"}}'), {});
    assert.deepEqual(parseReadRecord('{"a":{"cursor":4,"at":"x"}}'), { a: { cursor: 4, at: "x" } });
  });
});

describe("pruneReadRecord", () => {
  it("drops sessions the API no longer returns", () => {
    const record = { a: { cursor: 1, at: "2026-08-01T10:00:00.000Z" }, gone: { cursor: 2, at: "2026-08-01T11:00:00.000Z" } };
    assert.deepEqual(Object.keys(pruneReadRecord(record, ["a"])), ["a"]);
  });

  it("caps the record so a long-lived bookmark cannot grow forever", () => {
    const record: Record<string, { cursor: number; at: string }> = {};
    const ids: string[] = [];
    for (let i = 0; i < MAX_TRACKED_SESSIONS + 40; i += 1) {
      const id = `s${i}`;
      ids.push(id);
      record[id] = { cursor: i, at: new Date(Date.parse("2026-08-01T00:00:00.000Z") + i * 1000).toISOString() };
    }
    const pruned = pruneReadRecord(record, ids);
    assert.equal(Object.keys(pruned).length, MAX_TRACKED_SESSIONS);
    // Newest survive.
    assert.ok(pruned[`s${MAX_TRACKED_SESSIONS + 39}`]);
    assert.equal(pruned.s0, undefined);
  });
});

describe("unreadBadge", () => {
  it("ranks attention above any unread count", () => {
    const needy = agent({ attention: { since: "2026-08-01T11:00:00.000Z", summary: "Approve?" } });
    assert.deepEqual(unreadBadge(needy, {}, 9), { kind: "attention" });
  });

  // At boot the client cannot count events for a session it never opened, so
  // the seed is deliberately a dot rather than a wrong number.
  it("seeds a dot when something is new but uncounted", () => {
    assert.deepEqual(unreadBadge(agent(), {}, undefined), { kind: "dot" });
    const seen = { a: { cursor: 5, at: "2026-08-01T11:59:30.000Z" } };
    assert.equal(unreadBadge(agent(), seen, undefined), null);
  });

  it("promotes to a real count once live events are seen", () => {
    assert.deepEqual(unreadBadge(agent(), {}, 3), { kind: "count", value: 3 });
  });

  it("shows nothing for a session with no events at all", () => {
    assert.equal(unreadBadge(agent({ last_event_at: null }), {}, undefined), null);
  });
});

describe("shouldAdvanceRead", () => {
  // Not advancing while hidden is what makes the badge survive walking away.
  it("requires the right session, a visible tab and the bottom of the thread", () => {
    assert.equal(shouldAdvanceRead({ isSelected: true, documentVisible: true, atBottom: true }), true);
    assert.equal(shouldAdvanceRead({ isSelected: false, documentVisible: true, atBottom: true }), false);
    assert.equal(shouldAdvanceRead({ isSelected: true, documentVisible: false, atBottom: true }), false);
    assert.equal(shouldAdvanceRead({ isSelected: true, documentVisible: true, atBottom: false }), false);
  });
});

describe("titleFor", () => {
  it("puts attention ahead of a raw unread count", () => {
    assert.equal(titleFor(0, 0), "Fleet agents");
    assert.equal(titleFor(0, 3), "(3) Fleet agents");
    assert.equal(titleFor(1, 9), "(!) 1 needs you · Fleet agents");
    assert.equal(titleFor(2, 0), "(!) 2 need you · Fleet agents");
  });
});
