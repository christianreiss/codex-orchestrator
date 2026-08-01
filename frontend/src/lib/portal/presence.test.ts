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
