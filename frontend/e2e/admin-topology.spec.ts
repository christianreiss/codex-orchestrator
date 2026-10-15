import { expect, test, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import type { Topology, TopologyAgent, TopologyCommunicator } from "../src/lib/api/topology";

const C1 = "c1111111-1111-4111-8111-111111111111";
const C2 = "c2222222-2222-4222-8222-222222222222";
const A1 = "a1111111-1111-4111-8111-111111111111";
const A2 = "a2222222-2222-4222-8222-222222222222";
const A3 = "a3333333-3333-4333-8333-333333333333";

function communicator(id: string, username: string, host: string, agent_ids: string[]): TopologyCommunicator {
  const now = Date.now();
  return {
    kind: "communicator", id, label: `${username}@${host.split(".")[0]}`, host_id: id === C1 ? 4 : 5, host, username, version: "0.9.76",
    connected_at: new Date(now - 600_000).toISOString(), last_frame_at: new Date(now - 2_000).toISOString(), last_heartbeat_at: new Date(now - 3_000).toISOString(),
    health: "live", idle_s: 2, leases_reported: agent_ids.length, requests: 12, synced_at: null, sync_scopes: 0, sync_errors: 0, remote_address: "192.0.2.4",
    daemon_attached: false, agent_ids,
    // C1's owner announced that it can be stopped remotely; C2's predates the control frame.
    process: id === C1 ? { pid: 4242, started_at: new Date(now - 600_000).toISOString(), instance_id: "11111111-aaaa-4aaa-8aaa-111111111111", runtime_id: "rt0123456789abcd" } : null, can_terminate: id === C1,
  };
}
function agent(id: string, name: string, engine: string, parent: string, overrides: Partial<TopologyAgent> = {}): TopologyAgent {
  const now = Date.now();
  const direct = parent === "server";
  return {
    kind: "agent", id, name, engine, host_id: 4, host: "web01.example", username: "alice", cwd: "/srv/work", invocation_kind: "interactive", presence: "listening", status: "active",
    relay_ready: true, started_at: new Date(now - 900_000).toISOString(), heartbeat_at: new Date(now - 2_000).toISOString(), heartbeat_age_s: 2, address: `agent:${id}`, address_alias: null,
    binding_generation: 1, close: null, daemon: null,
    association: direct
      ? { state: "unattributed", basis: "none", parent_id: "server", last_seen_at: null, age_s: null, also_seen_on: [] }
      : { state: "attributed", basis: "session_traffic", parent_id: parent, last_seen_at: new Date(now - 4_000).toISOString(), age_s: 4, also_seen_on: [] },
    actions: { request_close: { allowed: true, reason: null }, stop_process: { allowed: false, reason: "not_daemon_managed" }, end_record: { allowed: true, reason: null } },
    ...overrides,
  };
}
function tree(): Topology {
  return {
    generated_at: new Date().toISOString(),
    server: { id: "server", label: "orchestrator.example", started_at: new Date(Date.now() - 86_400_000).toISOString(), uptime_s: 86_400, communicator_enabled: true, portal_enabled: true, scope: "api_process" },
    communicators: [communicator(C1, "alice", "web01.example", [A1, A2]), communicator(C2, "bob", "app02.example", [])],
    agents: [agent(A1, "Raffaela", "claude", C1), agent(A2, "Britta", "codex", C1), agent(A3, "Lisanne", "grok", "server")],
    recent_disconnects: [],
    counts: { communicators: 2, agents: 3, attributed: 2, stale: 0, unattributed: 1 },
  };
}

async function fixtures(page: Page, capabilities = ["hosts.read", "agent_portal.read", "agent_portal.manage", "agent_messaging.manage"]) {
  const state = { topology: tree(), posts: [] as Array<{ path: string; body: Record<string, unknown> }>, disconnectStatus: 200, terminateOutcome: "acknowledged_closed" as string, departure: {} as Record<string, unknown> };
  await page.route("**/admin/**", async (route) => {
    const request = route.request();
    if (!request.headers().accept?.includes("application/json")) return route.continue();
    const path = new URL(request.url()).pathname;
    const json = (data: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(data) });
    if (path === "/admin/auth/status") return json({ authenticated: true, enforced: true, user: { id: 1, username: "operator", roles: ["owner"] }, capabilities });
    if (path === "/admin/setup/status") return json({ setup_complete: true, critical_complete: true, checks: [], next_actions: [], wizard: { completed_at: "2026-09-28T00:00:00Z", dismissed_at: null } });
    if (path === "/admin/ws/info") return json({ enabled: false });
    if (path === "/admin/topology") return json(state.topology);
    if (request.method() === "POST" && path.endsWith("/terminate")) {
      state.posts.push({ path, body: request.postDataJSON() });
      const done = state.terminateOutcome === "acknowledged_closed";
      if (done) state.topology = { ...state.topology, communicators: state.topology.communicators.filter((c) => c.id !== C1) };
      return json({ outcome: state.terminateOutcome, connection_id: C1, host_id: 4, username: "alice", version: "0.9.76", process: { pid: 4242, started_at: null }, acknowledged: done || state.terminateOutcome === "acknowledged", connection_closed: done, affected: { agent_ids: [A1, A2], leases_reported: 2 }, replayed: false });
    }
    if (request.method() === "POST" && path.startsWith("/admin/communicators/")) {
      state.posts.push({ path, body: request.postDataJSON() });
      if (state.disconnectStatus !== 200) return json({ status: "error", message: "Communicator is not connected", code: "communicator_not_connected" }, state.disconnectStatus);
      // The server closed it: the old node is gone and a successor is listed.
      state.topology = { ...state.topology, communicators: state.topology.communicators.filter((c) => c.id !== C1), recent_disconnects: [{ id: C1, label: "alice@web01", host_id: 4, host: "web01.example", username: "alice", version: "0.9.76", connected_at: "", ended_at: new Date().toISOString(), reason: "admin_disconnect", actor: "operator", affected_agent_ids: [A1, A2], pid: null, successor_id: null, successor_basis: null, candidate_ids: [], ...state.departure }] };
      return json({ outcome: "closed", connection_id: C1, host_id: 4, username: "alice", version: "0.9.76", reconnect_expected: true, affected: { agent_ids: [A1, A2], leases_reported: 2 }, replayed: false });
    }
    return json({});
  });
  return state;
}

async function open(page: Page) {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/admin/topology");
  await expect(page.getByRole("heading", { name: "Live topology", exact: true })).toBeVisible({ timeout: 15_000 });
  await expect(page.locator("[data-node]")).toHaveCount(5);
}

test("draws the server, communicators and agents and says who carries whom", async ({ page }) => {
  await fixtures(page);
  await open(page);
  await expect(page.getByText("2 communicators", { exact: true })).toBeVisible();
  await expect(page.getByText("2 via a communicator")).toBeVisible();
  await expect(page.getByText("1 direct", { exact: true })).toBeVisible();

  await page.locator(`[data-node="${C1}"] .hit`).click();
  const details = page.getByRole("complementary", { name: "Selection details" });
  await expect(details.getByRole("heading", { name: "alice@web01" })).toBeVisible();
  await details.getByText("Runtime and connected agents", { exact: true }).click();
  await expect(details.getByText("Agents on this connection (2)")).toBeVisible();
  await expect(details.getByRole("button", { name: /Raffaela/ })).toBeVisible();
  await expect(details.getByRole("button", { name: /Lisanne/ })).toHaveCount(0);

  await page.locator(`[data-node="${A3}"] .hit`).click();
  await details.getByText("Session details", { exact: true }).click();
  await expect(details.getByText("Direct", { exact: true })).toBeVisible();
  await page.locator(`[data-node="${A1}"] .hit`).click();
  await expect(details.getByText("Carried by")).toBeVisible();
  await expect(details.getByRole("button", { name: "Stop the process…" })).toBeDisabled();
  await expect(details.getByText(/not launched by a host daemon/)).toBeVisible();
});

test("disconnecting a communicator names the target and its agents, then reports the result", async ({ page }) => {
  const state = await fixtures(page);
  await open(page);
  await page.locator(`[data-node="${C1}"] .hit`).click();
  await page.getByRole("button", { name: "Disconnect this communicator…" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText("alice@web01")).toBeVisible();
  await expect(dialog.getByText("Raffaela · Claude · listening")).toBeVisible();
  await expect(dialog.getByText("Britta · Codex · listening")).toBeVisible();
  await expect(dialog.getByText(/redials within 1–30 s/)).toBeVisible();
  await dialog.getByLabel(/Note for the audit record/).fill("stuck sync");
  await dialog.getByRole("button", { name: "Disconnect", exact: true }).click();
  await expect(dialog.getByText("Connection closed")).toBeVisible();
  expect(state.posts).toHaveLength(1);
  expect(state.posts[0]!.path).toBe(`/admin/communicators/${C1}/disconnect`);
  expect(state.posts[0]!.body).toMatchObject({ expect: { host_id: 4, username: "alice" }, note: "stuck sync" });
  expect(typeof state.posts[0]!.body.client_message_id).toBe("string");
  await dialog.getByRole("button", { name: "Close", exact: true }).first().click();
  // It lingers as a ghost for a few seconds, then leaves the canvas.
  await expect(page.locator(`[data-node="${C1}"]`)).toHaveCount(0, { timeout: 20_000 });
});

test("a target that is already gone is reported as such, not as a failure to retry blindly", async ({ page }) => {
  const state = await fixtures(page);
  state.disconnectStatus = 404;
  await open(page);
  await page.locator(`[data-node="${C2}"] .hit`).click();
  await page.getByRole("button", { name: "Disconnect this communicator…" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Disconnect", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("already gone");
});

test("controls are unavailable without the management permission", async ({ page }) => {
  await fixtures(page, ["hosts.read", "agent_portal.read"]);
  await open(page);
  await page.locator(`[data-node="${C1}"] .hit`).click();
  await expect(page.getByRole("button", { name: "Disconnect this communicator…" })).toBeDisabled();
  await page.locator(`[data-node="${A1}"] .hit`).click();
  await expect(page.getByRole("button", { name: "Ask the agent to close…" })).toBeDisabled();
  await page.getByText("More actions", { exact: true }).click();
  await expect(page.getByRole("button", { name: "End the session record…" })).toBeDisabled();
});

test("works from the keyboard and offers the same tree as a list", async ({ page }) => {
  await fixtures(page);
  await open(page);
  await page.locator(`[data-node="${C1}"]`).focus();
  await page.keyboard.press("PageDown");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("complementary", { name: "Selection details" }).getByRole("heading", { name: "Raffaela" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("complementary", { name: "Selection details" })).toBeHidden();

  await page.getByRole("button", { name: "List", exact: true }).click();
  await expect(page.getByRole("region", { name: "Communicator alice@web01" })).toContainText("Raffaela");
  await expect(page.getByRole("region", { name: "Agents with no communicator" })).toContainText("Lisanne");
  await page.getByLabel("Find a node").fill("britta");
  await expect(page.getByRole("button", { name: /Raffaela/ })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Britta/ })).toBeVisible();
});

test("has no serious accessibility violations and respects reduced motion", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await fixtures(page);
  await open(page);
  await page.locator(`[data-node="${C1}"] .hit`).click();
  const results = await new AxeBuilder({ page }).include("main").analyze();
  expect(results.violations.filter((v) => v.impact === "serious" || v.impact === "critical")).toEqual([]);
  const animated = await page.evaluate(() => [...document.querySelectorAll(".edge-flow, .pulse")].filter((el) => getComputedStyle(el).animationName !== "none").length);
  expect(animated).toBe(0);
});

test("stopping the communicator process is only offered to an owner that said it can be stopped, and reported as observed", async ({ page }) => {
  const state = await fixtures(page);
  await open(page);
  await page.locator(`[data-node="${C2}"] .hit`).click();
  await expect(page.getByRole("button", { name: /Stop the communicator process/ })).toHaveCount(0);
  await expect(page.getByText(/did not announce that it can be stopped remotely/)).toBeVisible();

  await page.locator(`[data-node="${C1}"] .hit`).click();
  await page.getByText("Connection details", { exact: true }).click();
  await expect(page.getByText("pid 4242", { exact: false }).first()).toBeVisible();
  await page.getByRole("button", { name: "Stop the communicator process…" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText("pid 4242 (self-reported)")).toBeVisible();
  await expect(dialog.getByText(/Native agent sessions are not signalled/)).toBeVisible();
  await dialog.getByRole("button", { name: "Stop process", exact: true }).click();
  await expect(dialog.getByText("Stop accepted, connection closed")).toBeVisible();
  await expect(dialog.getByText(/acknowledged the request and its connection to the server then closed/)).toBeVisible();
  // Honest about what was not observed: no claim that the process has exited.
  await expect(dialog.getByText(/not a confirmed exit/)).toBeVisible();
  await expect(dialog.getByText("Process stopped")).toHaveCount(0);
  expect(state.posts.at(-1)!.path).toBe(`/admin/communicators/${C1}/terminate`);
  expect(state.posts.at(-1)!.body).toMatchObject({ expect: { host_id: 4, username: "alice" } });
});

test("a process that declines (or was not the one addressed) is a warning, not a success", async ({ page }) => {
  const state = await fixtures(page);
  state.terminateOutcome = "refused";
  await open(page);
  await page.locator(`[data-node="${C1}"] .hit`).click();
  await page.getByRole("button", { name: "Stop the communicator process…" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Stop process", exact: true }).click();
  await expect(page.getByRole("dialog").getByText("The process declined")).toBeVisible();
  await expect(page.getByRole("dialog").getByText(/Nothing was stopped/)).toBeVisible();
  await expect(page.getByRole("dialog").getByText("Stop accepted, connection closed")).toHaveCount(0);
});

test("a stop nobody acknowledged is a warning, not a success", async ({ page }) => {
  const state = await fixtures(page);
  state.terminateOutcome = "unacknowledged";
  await open(page);
  await page.locator(`[data-node="${C1}"] .hit`).click();
  await page.getByRole("button", { name: "Stop the communicator process…" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Stop process", exact: true }).click();
  await expect(page.getByRole("dialog").getByText("No acknowledgement")).toBeVisible();
  await expect(page.getByRole("dialog").getByText(/still running/)).toBeVisible();
  await expect(page.getByRole("dialog").getByText("Stop accepted, connection closed")).toHaveCount(0);
  // The node is still there: the server did not see it go.
  await page.getByRole("dialog").getByRole("button", { name: "Close", exact: true }).first().click();
  await expect(page.locator(`[data-node="${C1}"]`)).toHaveCount(1);
});

test("a connection that merely shares host and user is an unverified candidate, never a reconnect", async ({ page }) => {
  const state = await fixtures(page);
  state.departure = { candidate_ids: [C2] };
  await open(page);
  await page.locator(`[data-node="${C1}"] .hit`).click();
  await page.getByRole("button", { name: "Disconnect this communicator…" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "Disconnect", exact: true }).click();
  await expect(dialog.getByText("Connection closed")).toBeVisible();
  await expect(dialog.getByText("Unverified:")).toBeVisible();
  await expect(dialog.getByText(/nothing proves it is this owner coming back/)).toBeVisible();
  await expect(dialog.getByText(/reconnected as/)).toHaveCount(0);
});

test("a reconnect is stated only when the owner's identity proves it", async ({ page }) => {
  const state = await fixtures(page);
  state.departure = { successor_id: C2, successor_basis: "same_process" };
  await open(page);
  await page.locator(`[data-node="${C1}"] .hit`).click();
  await page.getByRole("button", { name: "Disconnect this communicator…" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "Disconnect", exact: true }).click();
  await expect(dialog.getByText(/The same process reconnected as/)).toBeVisible();
  await expect(dialog.getByText("Unverified:")).toHaveCount(0);
});


test("owner runtime is a stale report with retained work, never exit proof", async ({ page }) => {
  const state = await fixtures(page);
  state.topology.communicators[0]!.resident = {
    sequence: 1, owner_instance_id: state.topology.communicators[0]!.process!.instance_id!, runtime_protocol: 1,
    mode: "resident", managed: true, resident_enabled: true, execution_enabled: false,
    binary_sha256: "a".repeat(64), draining: true, local_requests: 1, legacy_clients: 2,
    execution: { running: true, fenced: true, verified: false, workload: { accepted: 3, peer_claims: 4, children: 5, receipts: 6, writes: 0, requests: 0, legacy_clients: 0 } },
    received_at: new Date(Date.now() - 60_000).toISOString(), age_s: 60, stale: true,
  };
  await open(page);
  await page.locator(`[data-node="${C1}"] .hit`).click();
  await page.getByText("Runtime and connected agents", { exact: true }).click();
  const report = page.getByRole("region", { name: "Resident owner report" });
  await expect(report).toBeVisible();
  await expect(report).toContainText("Latest report · stale");
  await expect(report).toContainText("Resident · draining");
  await expect(report).toContainText("Remote startsdisabled");
  await expect(report).toContainText("3 accepted · 5 children · 6 receipts · 4 claims");
  await expect(report).toContainText("admission fenced · state unverified");
  await expect(report).toContainText("not a confirmed exit");
  await expect(report).toContainText("a".repeat(64));
  await page.locator(`[data-node="${C2}"] .hit`).click();
  await expect(report).toHaveCount(0); // An older owner never fabricated this report.
});

test("filters, collapses and persists preferences without inventing runtime mode", async ({ page }) => {
  await fixtures(page); await open(page);
  await expect(page.locator('path[data-runtime="unknown"]')).toHaveCount(2);
  await page.locator(`[data-node="${C1}"] .hit`).click();
  await page.getByRole('button', { name: 'Collapse agents (2)' }).click();
  await expect(page.locator(`[data-node="${A1}"]`)).toHaveCount(0);
  await page.getByRole('button', { name: 'Expand agents (2)' }).click();
  await expect(page.locator(`[data-node="${A1}"]`)).toHaveCount(1);
  await page.getByLabel('Filter runtime').selectOption('resident');
  await expect(page.locator('[data-node]')).toHaveCount(0);
  await page.reload();
  await expect(page.getByLabel('Filter runtime')).toHaveValue('resident');
  await page.getByRole('button', { name: 'Reset filters' }).click();
  await expect(page.locator('[data-node]')).toHaveCount(5);
  await page.getByRole('button', { name: 'Fullscreen', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Exit fullscreen' })).toBeVisible();
  await page.screenshot({ path: '/tmp/alicia-topology.png' });
});

test("native stop keeps its target and waits for an exit receipt", async ({ page }) => {
  const state = await fixtures(page);
  state.topology.agents[0].native_control = { instance_id: C2, binding_generation: 3, status: 'ready', request_id: null, available: true, updated_at: new Date().toISOString() };
  let status = 'requested';
  await page.route(`**/admin/agent-sessions/${A1}/stop`, async route => {
    if (route.request().method() === 'POST') state.posts.push({ path: new URL(route.request().url()).pathname, body: route.request().postDataJSON() });
    await route.fulfill({ json: { status } });
  });
  await open(page);
  await page.locator(`[data-node="${A1}"] .hit`).click();
  await page.getByRole('button', { name: 'Stop the process…' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Stop process', exact: true }).click();
  await expect(page.getByText('Process stop requested', { exact: true })).toBeVisible();
  expect(state.posts[0].body).toMatchObject({ expect: { instance_id: C2, binding_generation: 3 } });
  status = 'unknown';
  await expect(page.getByText('Stop outcome unknown', { exact: true })).toBeVisible();
  status = 'exited';
  await expect(page.getByText('Process exited', { exact: true })).toBeVisible();
});

test("embedded chat preserves drafts and spawn preselects the communicator host", async ({ page }) => {
  const state = await fixtures(page, ['hosts.read','agent_portal.read','agent_portal.manage','agent_portal.reveal_transcript','agent_messaging.manage']);
  const stamp = () => new Date().toISOString();
  const sessions = state.topology.agents.map(a => ({ ...a, launch_name: a.name, read_only: false, ended_at: null, pending_prompt: null, attention: null, active_turn_id: null, close_requested_at: null, relay_enabled: true, relay_heartbeat_at: stamp(), last_event_at: stamp(), work: { task: 'Topology fixture', declared_paths: [], address: a.address } }));
  await page.route('**/admin/agent-sessions', route => route.fulfill({ json: { enabled: true, generated_at: stamp(), timings: { heartbeat_fresh_seconds: 45, relay_fresh_seconds: 60 }, sessions } }));
  await page.route('**/admin/agent-sessions/events?*', route => route.fulfill({ status: 200, contentType: 'text/event-stream', body: ': fixture\n\n' }));
  await page.route('**/admin/agent-sessions/*/events*', route => route.fulfill({ json: { events: [], next_cursor: 0 } }));
  await page.route('**/admin/host-daemons', route => route.fulfill({ json: { hosts: [{ host_id: 4, fqdn: 'web01.example', enabled: true, username: 'alice', default_cwd: '/srv/work', max_parallel: 4, idle_minutes: 60, question_minutes: 60, health: { state: 'green', reasons: [], used_slots: 0, max_slots: 4, heartbeat_at: stamp(), evaluated_at: stamp() }, access: { allowed: true, reason: null }, engines: ['codex', 'claude', 'grok'], sessions: [] }] } }));
  await open(page);
  await page.locator(`[data-node="${A1}"] .hit`).click();
  await page.getByRole('button', { name: 'Chat', exact: true }).click();
  const chat = page.getByRole('complementary', { name: 'Topology conversation' });
  const composer = chat.locator('textarea');
  await expect(composer).toBeVisible();
  await composer.fill('Keep this draft on Raffaela');
  await page.locator(`[data-node="${A2}"] .hit`).click();
  await expect(composer).toHaveValue('Keep this draft on Raffaela');
  await page.getByRole('button', { name: 'Chat', exact: true }).click();
  await expect(composer).toHaveValue('');
  await page.locator(`[data-node="${A1}"] .hit`).click();
  await page.getByRole('button', { name: 'Chat', exact: true }).click();
  await expect(composer).toHaveValue('Keep this draft on Raffaela');
  await page.getByRole('button', { name: 'Close chat', exact: true }).click();
  await page.locator(`[data-node="${C1}"] .hit`).click();
  await page.getByRole('complementary', { name: 'Selection details' }).getByRole('button', { name: 'Start agent' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel('Host', { exact: true })).toHaveValue('4');
  await dialog.getByLabel('Title', { exact: true }).fill('Inspect host');
  await dialog.getByLabel('Instruction', { exact: true }).fill('Inspect this host');
  await page.route('**/admin/daemon-sessions', async route => {
    state.posts.push({ path: '/admin/daemon-sessions', body: route.request().postDataJSON() });
    await route.fulfill({ json: { session_id: C2 } });
  });
  await page.route(`**/admin/daemon-sessions/${C2}`, route => route.fulfill({ json: { id: C2, title: 'Inspect host', engine: 'codex', cwd: '/srv/work', status: 'queued', sessionId: null, addressId: null } }));
  await dialog.getByRole('button', { name: 'Start session', exact: true }).click();
  await expect(dialog).toBeHidden();
  expect(state.posts.at(-1)?.body).toMatchObject({ host_id: 4, cwd: '/srv/work', prompt: 'Inspect this host' });
  await expect(chat.getByText('Inspect host', { exact: true })).toBeVisible();
  await expect(page.locator('[data-node]')).toHaveCount(5);
  await page.screenshot({ path: '/tmp/alicia-topology-spawn.png' });
});

test("mobile inspector stays within the viewport and closes without losing the graph", async ({ page }) => {
  await fixtures(page); await open(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator(`[data-node="${C1}"] .hit`).click();
  const inspector = page.getByRole('complementary', { name: 'Selection details' });
  await expect(inspector).toBeVisible();
  const box = await inspector.boundingBox();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(390);
  expect(box!.y + box!.height).toBeLessThanOrEqual(845);
  await page.screenshot({ path: '/tmp/alicia-topology-mobile.png' });
  await page.getByRole('button', { name: 'Close inspector' }).click();
  await expect(inspector).toBeHidden();
  await expect(page.locator('[data-node]')).toHaveCount(5);
});
