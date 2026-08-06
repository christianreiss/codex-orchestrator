import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Agent, CloseState, Presence } from "./types";

// `node --test` strips types but resolves specifiers verbatim, so the runtime
// import needs the ".ts" extension TypeScript rejects on a static import.
const presenceModule: string = "./presence.ts";
const { groupAgents, groupFor, livePresence, notListeningDetail, presenceView } = (await import(presenceModule)) as typeof import("./presence");

const NOW = Date.parse("2026-08-01T12:00:00.000Z");

function agent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: "a", engine: "codex", host: "crane", username: "chris", cwd: "/repo",
    status: "active", presence: "listening", relay_ready: true,
    active_turn_started_at: null,
    started_at: "2026-08-01T11:00:00.000Z",
    heartbeat_at: "2026-08-01T11:59:50.000Z",
    last_event_at: "2026-08-01T11:59:00.000Z",
    ended_at: null, expires_at: null, read_only: false,
    attention: null, close_requested_at: null, close: null, pending_prompt: null,
    ...overrides,
  };
}

describe("livePresence", () => {
  it("keeps the server verdict while the heartbeat is fresh", () => {
    assert.equal(livePresence(agent(), NOW), "listening");
  });

  // Otherwise the UI keeps claiming an agent is reachable for a whole poll
  // interval after it stopped answering.
  it("downgrades to offline on a stale heartbeat without waiting for a poll", () => {
    assert.equal(livePresence(agent({ heartbeat_at: "2026-08-01T11:58:00.000Z" }), NOW), "offline");
  });

  it("never overrides ended", () => {
    const stale = agent({ presence: "ended", heartbeat_at: "2026-08-01T10:00:00.000Z", ended_at: "x" });
    assert.equal(livePresence(stale, NOW), "ended");
  });
});

describe("presenceView", () => {
  it("allows sending only while listening", () => {
    const cases: Array<[Presence, boolean]> = [
      ["listening", true], ["idle", false], ["offline", false], ["ended", false],
    ];
    for (const [presence, canSend] of cases) {
      assert.equal(presenceView(agent({ presence }), NOW).canSend, canSend, presence);
    }
  });

  it("never labels a state with a colour word alone", () => {
    for (const presence of ["listening", "idle", "offline", "ended"] as Presence[]) {
      const view = presenceView(agent({ presence }), NOW);
      assert.ok(view.label.length > 0 && view.detail.length > 0, presence);
    }
  });
});

describe("notListeningDetail", () => {
  // "Busy" would be wrong for all four: nothing is busy when no relay was ever
  // opened, and a finished close is not the same as a pending one.
  it("distinguishes the reasons an agent is not listening", () => {
    assert.match(notListeningDetail(agent()), /#afk/);
    const states: Array<[CloseState, RegExp]> = [
      ["pending", /Closing/],
      ["acknowledged", /Closed by you/],
      ["undeliverable", /could not be delivered/],
    ];
    for (const [state, expected] of states) {
      const withClose = agent({ close: { requested_at: "2026-08-01T11:00:00.000Z", state } });
      assert.match(notListeningDetail(withClose), expected, state);
    }
  });
});

describe("groupAgents", () => {
  it("puts anything needing attention first, whatever its presence", () => {
    const offlineButWaiting = agent({
      id: "waiting", presence: "offline", heartbeat_at: "2026-08-01T11:00:00.000Z",
      attention: { since: "2026-08-01T11:30:00.000Z", summary: "Approve?" },
    });
    assert.equal(groupFor(offlineButWaiting, NOW), "attention");
    const groups = groupAgents([agent({ id: "live" }), offlineButWaiting], NOW);
    assert.equal(groups[0]!.key, "attention");
    assert.deepEqual(groups.map((g) => g.key), ["attention", "listening"]);
  });

  it("omits empty groups and sorts each by most recent activity", () => {
    const older = agent({ id: "older", last_event_at: "2026-08-01T10:00:00.000Z" });
    const newer = agent({ id: "newer", last_event_at: "2026-08-01T11:50:00.000Z" });
    const groups = groupAgents([older, newer], NOW);
    assert.equal(groups.length, 1);
    assert.deepEqual(groups[0]!.agents.map((a) => a.id), ["newer", "older"]);
  });

  it("falls back to started_at when a session has no events", () => {
    const noEvents = agent({ id: "fresh", last_event_at: null });
    assert.doesNotThrow(() => groupAgents([noEvents], NOW));
  });
});

describe("working", () => {
  const working = (overrides: Partial<Agent> = {}) =>
    agent({
      presence: "working",
      relay_ready: false,
      active_turn_started_at: "2026-08-01T11:56:00.000Z",
      ...overrides,
    });

  // Nothing polls the relay while the agent executes, so the relay is stale by
  // design here. Refusing to send would reproduce the exact bug this state
  // exists to fix: a busy agent advertised as "not listening".
  it("stays sendable even though the relay is not ready", () => {
    const view = presenceView(working(), NOW);
    assert.equal(view.label, "Working");
    assert.equal(view.canSend, true);
  });

  it("says how long the turn has been running", () => {
    assert.match(presenceView(working(), NOW).detail, /4m/);
  });

  it("still reads the turn as running when the server sent no start time", () => {
    const view = presenceView(working({ active_turn_started_at: null }), NOW);
    assert.equal(view.canSend, true);
    assert.doesNotMatch(view.detail, /NaN|null|undefined/);
  });

  // The heartbeat is the process, not the turn: if it stops, the agent is gone
  // whatever it claimed to be doing.
  it("is still downgraded to offline by a stale heartbeat", () => {
    assert.equal(livePresence(working({ heartbeat_at: "2026-08-01T11:00:00.000Z" }), NOW), "offline");
  });

  it("gets its own group, ahead of listening", () => {
    assert.equal(groupFor(working(), NOW), "working");
    const groups = groupAgents([agent({ id: "idle-one", presence: "listening" }), working({ id: "busy" })], NOW);
    assert.deepEqual(groups.map((g) => g.key), ["working", "listening"]);
  });
});

describe("an ended session releases the attention slot", () => {
  // A crashed agent used to hold the top of the list, unanswerable, for the
  // whole retention window -- and the only thing that cleared it was an action
  // the operator could no longer perform.
  it("groups an ended session under ended even with an outstanding notice", () => {
    const dead = agent({
      presence: "ended",
      ended_at: "2026-08-01T11:40:00.000Z",
      attention: { since: "2026-08-01T11:30:00.000Z", summary: "Approve?" },
    });
    assert.equal(groupFor(dead, NOW), "ended");
  });

  // Still true for an agent that is merely unreachable: it may yet come back.
  it("keeps an offline agent in Needs you", () => {
    const offline = agent({
      presence: "offline",
      heartbeat_at: "2026-08-01T11:00:00.000Z",
      attention: { since: "2026-08-01T11:30:00.000Z", summary: "Approve?" },
    });
    assert.equal(groupFor(offline, NOW), "attention");
  });
});

describe("the ended sentence follows the served retention", () => {
  it("reads the real expiry rather than a hardcoded 24 hours", () => {
    const ending = agent({
      presence: "ended",
      ended_at: "2026-08-01T11:40:00.000Z",
      expires_at: "2026-08-01T15:00:00.000Z",
    });
    assert.match(presenceView(ending, NOW).detail, /3 more hours/);
  });

  it("does not promise time it cannot confirm", () => {
    const ending = agent({ presence: "ended", ended_at: "2026-08-01T11:40:00.000Z", expires_at: null });
    assert.equal(presenceView(ending, NOW).detail, "Finished");
  });
});
