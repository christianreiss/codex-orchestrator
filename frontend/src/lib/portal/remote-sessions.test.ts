import { strict as assert } from "node:assert";
import { test } from "node:test";
const modulePath: string = "./remote-sessions.ts";
const { remoteForAgent, continuationBlockReason, hostBlockReason, remoteState } = await import(modulePath) as typeof import("./remote-sessions");
import type { AgentSessionRow } from "../api/agentSessions";
import type { DaemonHost, RemoteSession } from "../api/hostDaemons";

const host = { enabled: true, health: { state: "green" }, access: { allowed: true } } as DaemonHost;
const remote = { id: "remote", sessionId: "native", addressId: "address", status: "idle" } as RemoteSession;
test("remote association uses durable IDs, never a title or host", () => {
  assert.equal(remoteForAgent({ id: "native", work: {} } as AgentSessionRow, [remote]), remote);
  assert.equal(remoteForAgent({ id: "new-native", work: { address: "agent:address" } } as AgentSessionRow, [remote]), remote);
  assert.equal(remoteForAgent({ id: "other", work: { address: "agent:else" } } as AgentSessionRow, [remote]), undefined);
});
test("continuation blocks busy, ambiguous, inaccessible and unbound sessions", () => {
  for (const status of ["queued", "running", "stopping", "unknown", "future-status"]) assert.ok(continuationBlockReason({ ...remote, status }, host));
  for (const status of ["idle", "waiting", "closed", "failed"]) assert.equal(continuationBlockReason({ ...remote, status }, host), "");
  assert.match(continuationBlockReason({ ...remote, addressId: null }, host), /transcript/);
  assert.ok(continuationBlockReason(remote, { ...host, enabled: false }));
  assert.ok(hostBlockReason({ ...host, deadline_expired: true }));
  assert.ok(hostBlockReason({ ...host, access: { ...host.access!, allowed: false } }));
});
test("daemon running state is process evidence, not listening evidence", () => {
  assert.equal(remoteState("running").presence, "working");
  assert.equal(remoteState("closed").label, "Ended");
  assert.equal(remoteState("unrecognized").label, "Outcome unknown");
});
