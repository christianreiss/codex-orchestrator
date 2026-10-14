import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Topology, TopologyAgent, TopologyCommunicator } from "../api/topology";

const modelModule: string = "./model.ts";
const { trackGhosts, emptyGhostState, graphModel, matchesQuery, nodeState, communicatorAppearance, communicatorLabel, summarize, actionReason, ageLabel, GHOST_TTL_MS } =
  (await import(modelModule)) as typeof import("./model");

const comm = (id: string, overrides: Partial<TopologyCommunicator> = {}): TopologyCommunicator => ({
  kind: "communicator", id, label: "alice@web01", host_id: 4, host: "web01.example.com", username: "alice", version: "0.9.74",
  connected_at: "2026-10-13T17:00:00Z", last_frame_at: "2026-10-13T17:59:00Z", last_heartbeat_at: null, health: "live", idle_s: 2,
  leases_reported: 1, requests: 3, synced_at: null, sync_scopes: 0, sync_errors: 0, remote_address: null, daemon_attached: false,
  agent_ids: [], process: null, can_terminate: false, ...overrides,
});
const agent = (id: string, overrides: Partial<TopologyAgent> = {}): TopologyAgent => ({
  kind: "agent", id, name: "Raffaela", engine: "claude", host_id: 4, host: "web01.example.com", username: "alice", cwd: "/srv/work",
  invocation_kind: "interactive", presence: "listening", status: "active", relay_ready: true, started_at: "2026-10-13T17:00:00Z",
  heartbeat_at: "2026-10-13T17:59:50Z", heartbeat_age_s: 4, address: "agent:abc", address_alias: null, binding_generation: 1, close: null, daemon: null,
  association: { state: "attributed", basis: "session_traffic", parent_id: "c1", last_seen_at: null, age_s: 3, also_seen_on: [] },
  actions: {
    request_close: { allowed: true, reason: null }, stop_process: { allowed: false, reason: "not_daemon_managed" }, end_record: { allowed: true, reason: null },
  },
  ...overrides,
});
const snapshot = (communicators: TopologyCommunicator[], agents: TopologyAgent[], extra: Partial<Topology> = {}): Topology => ({
  generated_at: "2026-10-13T18:00:00Z",
  server: { id: "server", label: "orch", started_at: "", uptime_s: 1, communicator_enabled: true, portal_enabled: true, scope: "api_process" },
  communicators, agents, recent_disconnects: [],
  counts: { communicators: communicators.length, agents: agents.length, attributed: agents.length, stale: 0, unattributed: 0 },
  ...extra,
});

describe("ghost tracking", () => {
  it("keeps a node that left as a ghost, then drops it after the ttl", () => {
    const first = trackGhosts(emptyGhostState(), snapshot([comm("c1")], [agent("a1")]), 1000);
    assert.equal(first.ghosts.size, 0);
    const second = trackGhosts(first, snapshot([], []), 2000);
    assert.deepEqual([...second.ghosts.keys()].sort(), ["a1", "c1"]);
    const third = trackGhosts(second, snapshot([], []), 2000 + GHOST_TTL_MS - 1);
    assert.equal(third.ghosts.size, 2);
    const fourth = trackGhosts(third, snapshot([], []), 2000 + GHOST_TTL_MS + 1);
    assert.equal(fourth.ghosts.size, 0);
  });

  it("stops treating a node as a ghost when it comes back", () => {
    const a = trackGhosts(emptyGhostState(), snapshot([comm("c1")], []), 1000);
    const b = trackGhosts(a, snapshot([], []), 2000);
    assert.equal(b.ghosts.size, 1);
    const c = trackGhosts(b, snapshot([comm("c1")], []), 3000);
    assert.equal(c.ghosts.size, 0);
  });

  it("attaches the server's record of how it left, and learns of a successor later", () => {
    const base = trackGhosts(emptyGhostState(), snapshot([comm("c1")], []), 1000);
    const departure = {
      id: "c1", label: "alice@web01", host_id: 4, host: "web01.example.com", username: "alice", version: "0.9.74", connected_at: "", ended_at: "",
      reason: "admin_disconnect" as const, actor: "ops", pid: null, affected_agent_ids: [], successor_id: null, successor_basis: null, candidate_ids: [],
    };
    const gone = trackGhosts(base, snapshot([], [], { recent_disconnects: [departure] }), 2000);
    assert.equal(gone.ghosts.get("c1")!.departure!.reason, "admin_disconnect");
    const redialled = trackGhosts(gone, snapshot([comm("c2")], [], { recent_disconnects: [{ ...departure, successor_id: "c2", successor_basis: "same_runtime" as const }] }), 3000);
    assert.equal(redialled.ghosts.get("c1")!.departure!.successor_id, "c2");
  });
});

describe("node state", () => {
  it("derives state from health, association, and ghosthood", () => {
    assert.equal(nodeState(comm("c1", { health: "stale" }), false), "stale");
    assert.equal(nodeState(comm("c1", { health: "closing" }), false), "closing");
    assert.equal(nodeState(agent("a1"), false), "live");
    assert.equal(nodeState(agent("a1", { association: { ...agent("a").association, state: "stale" } }), false), "stale");
    assert.equal(nodeState(agent("a1"), true), "gone");
  });
});

describe("search", () => {
  it("matches names, engines, hosts, users, addresses and ids; empty matches all", () => {
    const a = agent("0eed881f-ba5a-4983-9b80-caf25052428e", { address: "agent:xyz" });
    for (const q of ["rAFF", "claude", "web01", "alice", "agent:xyz", "0eed88", "listening", ""]) assert.equal(matchesQuery(a, q), true, q);
    assert.equal(matchesQuery(a, "grok"), false);
    assert.equal(matchesQuery(comm("c1"), "communicator"), true);
    assert.equal(matchesQuery(comm("c1"), "0.9.74"), true);
  });
});

describe("labels and summaries", () => {
  it("labels a communicator by full FQDN and retains runtime disambiguation", () => {
    assert.equal(communicatorLabel(comm("c1")), "web01.example.com");
    assert.equal(communicatorLabel(comm("c2", { label: "alice@web01 · rt0123" })), "web01.example.com · rt0123");
  });
  it("uses fresh owner mode rather than requested residence or daemon attachment", () => {
    const report = { mode: "on_demand", resident_enabled: true, stale: false } as NonNullable<TopologyCommunicator["resident"]>;
    assert.equal(communicatorAppearance(comm("c1", { resident: report, daemon_attached: true })).kind, "spawned");
    assert.equal(communicatorAppearance(comm("c1", { resident: { ...report, mode: "resident" } })).kind, "persistent");
    assert.equal(communicatorAppearance(comm("c1", { resident: { ...report, mode: "resident", stale: true } })).kind, "unknown");
    assert.equal(communicatorAppearance(comm("c1", { daemon_attached: true })).kind, "unknown");
  });
  it("summarises the tree", () => {
    const s = summarize(snapshot([comm("c1"), comm("c2", { health: "stale" })], [agent("a1", { presence: "working" }), agent("a2")]));
    assert.deepEqual(s, { communicators: 2, liveCommunicators: 1, agents: 2, attributed: 2, stale: 0, unattributed: 0, working: 1, listening: 1 });
    assert.equal(summarize(undefined).agents, 0);
  });
  it("explains why an action is off, in words", () => {
    assert.match(actionReason("agent_not_listening"), /not listening/);
    assert.equal(actionReason(null), "");
  });
  it("formats ages", () => {
    assert.equal(ageLabel(null), "never");
    assert.equal(ageLabel(0), "just now");
    assert.equal(ageLabel(30), "30s ago");
    assert.equal(ageLabel(600), "10 min ago");
    assert.equal(ageLabel(7200), "2 h ago");
  });
});

describe("graph model", () => {
  it("draws live nodes at full strength and ghosts fading with age", () => {
    const base = trackGhosts(emptyGhostState(), snapshot([comm("c1"), comm("c2")], [agent("a1")]), 1000);
    const gone = trackGhosts(base, snapshot([comm("c2")], []), 2000);
    const model = graphModel(snapshot([comm("c2")], []), gone, 2000 + GHOST_TTL_MS / 2);
    assert.deepEqual(model.communicators.map((c) => [c.node.id, c.ghost !== null]), [["c2", false], ["c1", true]]);
    assert.equal(model.communicators[0]!.strength, 1);
    const fading = model.communicators[1]!.strength;
    assert.ok(fading > 0.4 && fading < 0.6, `strength ${fading}`);
    assert.deepEqual(model.agents.map((a) => a.node.id), ["a1"]);
    assert.equal(graphModel(undefined, emptyGhostState(), 0).agents.length, 0);
  });
});
