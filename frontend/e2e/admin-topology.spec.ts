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
    kind: "communicator", id, host_id: id === C1 ? 4 : 5, host, username, version: "0.9.76",
    connected_at: new Date(now - 600_000).toISOString(), last_frame_at: new Date(now - 2_000).toISOString(), last_heartbeat_at: new Date(now - 3_000).toISOString(),
    health: "live", idle_s: 2, leases_reported: agent_ids.length, requests: 12, synced_at: null, sync_scopes: 0, sync_errors: 0, remote_address: "192.0.2.4",
    daemon_attached: false, agent_ids, can_terminate: false,
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
  const state = { topology: tree(), posts: [] as Array<{ path: string; body: Record<string, unknown> }>, disconnectStatus: 200 };
  await page.route("**/admin/**", async (route) => {
    const request = route.request();
    if (!request.headers().accept?.includes("application/json")) return route.continue();
    const path = new URL(request.url()).pathname;
    const json = (data: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(data) });
    if (path === "/admin/auth/status") return json({ authenticated: true, enforced: true, user: { id: 1, username: "operator", roles: ["owner"] }, capabilities });
    if (path === "/admin/setup/status") return json({ setup_complete: true, critical_complete: true, checks: [], next_actions: [], wizard: { completed_at: "2026-09-28T00:00:00Z", dismissed_at: null } });
    if (path === "/admin/ws/info") return json({ enabled: false });
    if (path === "/admin/topology") return json(state.topology);
    if (request.method() === "POST" && path.startsWith("/admin/communicators/")) {
      state.posts.push({ path, body: request.postDataJSON() });
      if (state.disconnectStatus !== 200) return json({ status: "error", message: "Communicator is not connected", code: "communicator_not_connected" }, state.disconnectStatus);
      // The server closed it: the old node is gone and a successor is listed.
      state.topology = { ...state.topology, communicators: state.topology.communicators.filter((c) => c.id !== C1), recent_disconnects: [{ id: C1, host_id: 4, host: "web01.example", username: "alice", version: "0.9.76", connected_at: "", ended_at: new Date().toISOString(), reason: "admin_disconnect", actor: "operator", affected_agent_ids: [A1, A2], successor_id: null }] };
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
  await expect(details.getByText("Agents on this connection (2)")).toBeVisible();
  await expect(details.getByRole("button", { name: /Raffaela/ })).toBeVisible();
  await expect(details.getByRole("button", { name: /Lisanne/ })).toHaveCount(0);

  await page.locator(`[data-node="${A3}"] .hit`).click();
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
  await expect(page.getByRole("complementary", { name: "Selection details" }).getByRole("heading", { name: "Server" })).toBeVisible();

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
