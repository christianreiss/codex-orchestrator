import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { describe, it } from "node:test";
import type { AgentSessionRow, AgentSessionsResponse } from "../api/agentSessions";
registerHooks({ resolve(specifier, context, nextResolve) { return nextResolve(specifier === "./presence" ? "./presence.ts" : specifier === "./activity" ? "./activity.ts" : specifier, context); } });
const modulePath: string = "./clients.ts";
const { clientClock, clientCounts, isOnlineActiveAgent, roomHasActiveAgent, snapshotIsStale, visibleClients } = await import(modulePath) as typeof import("./clients");
const NOW = Date.parse("2026-09-08T12:00:00Z");
function row(id: string, overrides: Partial<AgentSessionRow> = {}): AgentSessionRow {
  return { id, engine: "codex", host_id: 1, host: "crane", username: "operator", cwd: "/repo", status: "active", invocation_kind: "interactive", upstream_session_id: null, active_turn_id: null, active_turn_started_at: null, presence: "listening", relay_ready: true, started_at: new Date(NOW - 60_000).toISOString(), heartbeat_at: new Date(NOW - 5_000).toISOString(), last_event_at: null, ended_at: null, expires_at: null, read_only: false, attention: null, close_requested_at: null, close: null, pending_prompt: null, work: { task: "Inspect auth recovery", branch: "fix/refresh", target_branch: "main", declared_paths: ["api/auth"], worktree_path: "/repo/worktree", address: "agent-1", address_alias: "quiet-fox" }, ...overrides };
}
const options = { search: "", engine: "all" as const, filter: "all" as const, sort: "status" as const };
describe("client directory", () => {
  it("counts a room as current only when a reachable member is also an online agent", () => {
    const member = (session_id: string | null, reachable: boolean) => ({ id: "m", name: "n", engine: "codex", session_id, reachable, role: "member" });
    const room = (...members: ReturnType<typeof member>[]) => ({ id: "r", kind: "group" as const, title: "t", description: "", status: "open", created_at: "", members });
    const online = new Set(["a"]);
    assert.equal(roomHasActiveAgent(room(member("a", true)), online), true);
    assert.equal(roomHasActiveAgent(room(member("b", true)), online), false);
    assert.equal(roomHasActiveAgent(room(member("a", false)), online), false);
    assert.equal(roomHasActiveAgent(room(member(null, true)), online), false);
    // No agent overview: the roster flag is all there is.
    assert.equal(roomHasActiveAgent(room(member("b", true)), null), true);
    assert.equal(roomHasActiveAgent(room(), null), false);
  });
  it("lists only online, writable agents as current chats, whatever notices an offline one carries", () => {
    const notice = { since: "x", summary: null, severity: "critical" as const };
    const rows = [
      row("listening"), row("working", { presence: "working" }), row("idle", { presence: "idle" }),
      row("offline", { presence: "offline", attention: notice }),
      row("ended", { ended_at: new Date(NOW).toISOString(), attention: notice }),
      row("read-only", { read_only: true }),
    ];
    assert.deepEqual(visibleClients(rows, { ...options, filter: "active" }, NOW).map((r) => r.id).sort(), ["idle", "listening", "working"]);
    assert.equal(isOnlineActiveAgent(row("stale", { heartbeat_at: new Date(NOW - 120_000).toISOString() }), NOW), false);
  });
  it("counts and filters Grok clients and finds the cgx command", () => {
    const rows = [row("grok", { engine: "grok" }), row("codex")];
    assert.equal(clientCounts(rows, NOW).grok, 1);
    assert.deepEqual(visibleClients(rows, { ...options, search: "cgx", engine: "grok" }, NOW).map(r => r.id), ["grok"]);
  });
  it("keeps an unanswered prompt in needs-you counts after a notice resolves", () => {
    const pending = row("prompt", { pending_prompt: { id: "p", version: 1, question: "Continue?", options: [], created_at: new Date(NOW).toISOString() } });
    assert.equal(clientCounts([pending], NOW).attention, 1);
    assert.deepEqual(visibleClients([pending], { ...options, filter: "attention" }, NOW), [pending]);
    assert.equal(clientCounts([{ ...pending, ended_at: new Date(NOW).toISOString() }], NOW).attention, 0);
  });
  it("searches across work identity and filters both engines without mutating source rows", () => {
    const rows = [row("codex"), row("claude", { engine: "claude" })];
    assert.deepEqual(visibleClients(rows, { ...options, search: "QUIET-FOX api/auth", engine: "claude" }, NOW).map((r) => r.id), ["claude"]);
    assert.deepEqual(rows.map((r) => r.id), ["codex", "claude"]);
  });
  it("keeps ended attention out of actionable counts and filters", () => {
    const rows = [row("ended", { ended_at: new Date(NOW).toISOString(), attention: { since: "x", summary: null } }), row("offline", { presence: "offline", attention: { since: "x", summary: null } }), row("idle", { presence: "idle", engine: "claude" })];
    assert.deepEqual(clientCounts(rows, NOW), { online: 1, attention: 1, offline: 1, ended: 1, codex: 2, claude: 1, grok: 0 });
    assert.deepEqual(visibleClients(rows, { ...options, filter: "attention" }, NOW).map((r) => r.id), ["offline"]);
    assert.deepEqual(visibleClients(rows, { ...options, filter: "online" }, NOW).map((r) => r.id), ["idle"]);
  });
  it("sorts by priority or recent activity with deterministic ties", () => {
    const rows = [row("z", { last_event_at: new Date(NOW).toISOString() }), row("a", { presence: "working" }), row("attention", { presence: "offline", attention: { since: "x", summary: null } })];
    assert.deepEqual(visibleClients(rows, options, NOW).map((r) => r.id), ["attention", "a", "z"]);
    assert.equal(visibleClients(rows, { ...options, sort: "recent" }, NOW)[0].id, "z");
  });
  it("uses server snapshot time despite a browser clock several hours ahead", () => {
    const snapshot = { generated_at: new Date(NOW).toISOString() } as AgentSessionsResponse;
    assert.equal(clientClock(snapshot, NOW + 3_600_000, NOW + 3_610_000), NOW + 10_000);
    assert.equal(clientClock({ generated_at: "invalid" } as AgentSessionsResponse, NOW, NOW + 1_000), NOW + 1_000);
    assert.equal(snapshotIsStale(NOW, NOW + 45_000), false);
    assert.equal(snapshotIsStale(NOW, NOW + 45_001), true);
    assert.equal(snapshotIsStale(0, NOW), true);
  });
});
