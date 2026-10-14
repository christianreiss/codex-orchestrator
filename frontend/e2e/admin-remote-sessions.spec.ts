import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import type { AgentSessionRow } from "../src/lib/api/agentSessions";
import type { DaemonHost, RemoteSession } from "../src/lib/api/hostDaemons";
const NATIVE = "11111111-1111-4111-8111-111111111111";
const REMOTE = "22222222-2222-4222-8222-222222222222";
const OTHER = "33333333-3333-4333-8333-333333333333";
const stamp = () => new Date().toISOString();
function agent(id: string): AgentSessionRow {
  return { id, engine: "codex", launch_name: id === NATIVE ? "Rebecca" : "Judith", session_name: "Review", host_id: 1, host: "worker.test", username: "operator", cwd: "/srv/project", invocation_kind: "interactive", upstream_session_id: "upstream", status: "active", presence: "listening", relay_ready: true, relay_heartbeat_at: stamp(), active_turn_id: null, active_turn_started_at: null, started_at: stamp(), heartbeat_at: stamp(), last_event_at: stamp(), attention: null, ended_at: null, expires_at: null, close_requested_at: null, close: null, read_only: false, pending_prompt: null, work: { task: "Review release", branch: null, target_branch: null, declared_paths: [], worktree_path: null, address: null, address_alias: null } };
}
async function fixture(page: Page, read = true, manage = true) {
  let emit: ((data: string) => void) | undefined;
  await page.routeWebSocket("**/remote-clients-ws", ws => { emit = data => ws.send(data); });
  const remote: RemoteSession = { id: REMOTE, engine: "codex", title: "Review release on worker", cwd: "/srv/project", status: "idle", sessionId: NATIVE, addressId: "address", createdAt: stamp(), lastActivityAt: stamp(), operations: [{ id: "op", status: "completed", result: { reply: "Diagnostic operation output" } }] };
  const host: DaemonHost = { host_id: 1, fqdn: "worker.test", enabled: true, username: "operator", default_cwd: "/srv/project", engines: ["codex", "claude", "grok"], max_parallel: 8, idle_minutes: 60, question_minutes: 1440, health: { state: "green", reasons: [], heartbeat_at: stamp(), evaluated_at: stamp(), used_slots: 0, max_slots: 8 }, access: { allowed: true, reason: null, secure: true, enabled_until: null }, sessions: [remote] };
  const state = { update: async (type = "host.daemon.changed") => {
    await expect.poll(() => Boolean(emit)).toBe(true);
    emit!(JSON.stringify({ type, payload: {}, ts: new Date().toISOString() }));
  }, host, remote, agents: [agent(NATIVE), agent(OTHER)], failStart: 0, failTurn: 0, calls: [] as string[], posts: [] as { path: string; body: Record<string, unknown> }[] };
  await page.addInitScript(() => {
    class Feed extends EventTarget { constructor(_url: string) { super(); queueMicrotask(() => this.dispatchEvent(new Event("open"))); } close() {} }
    window.EventSource = Feed as unknown as typeof EventSource;
  });
  await page.route("**/admin/**", async route => {
    const req = route.request();
    if (!req.headers().accept?.includes("application/json")) return route.continue();
    const path = new URL(req.url()).pathname;
    state.calls.push(path);
    const json = (body: unknown, status = 200) => route.fulfill({ status, json: body });
    if (path === "/admin/auth/status") return json({ authenticated: true, enforced: true, user: { id: 1, username: "operator", roles: ["owner"] }, capabilities: ["admin.read", "agent_portal.read", ...(read ? ["agent_portal.reveal_transcript"] : []), ...(manage ? ["agent_messaging.manage", "agent_portal.manage"] : [])] });
    if (path === "/admin/setup/status") return json({ setup_complete: true, critical_complete: true, checks: [], next_actions: [], wizard: { completed_at: stamp(), dismissed_at: null } });
    if (path === "/admin/ws/info") return json({ enabled: true, url: new URL("/remote-clients-ws", req.url()).href.replace(/^http/, "ws") });
    if (path === "/admin/host-daemons") return json({ hosts: [host] });
    if (path === "/admin/agent-sessions") return json({ enabled: true, generated_at: stamp(), timings: { heartbeat_fresh_seconds: 45, relay_fresh_seconds: 60 }, sessions: state.agents });
    if (path.endsWith("/events")) return json({ events: [{ cursor: 1, session_id: NATIVE, type: "assistant_message", source: "engine", payload: { text: "The real conversation is here." }, created_at: stamp() }], next_cursor: 1 });
    if (req.method() === "POST") {
      state.posts.push({ path, body: req.postDataJSON() });
      if (path === "/admin/daemon-sessions") {
        if (state.failStart-- > 0) return route.abort("failed");
        return json({ session_id: REMOTE });
      }
      if (path === `/admin/daemon-sessions/${REMOTE}/messages` && state.failTurn-- > 0) return route.abort("failed");
      if (path.endsWith("/stop")) remote.status = "closed";
      return json({ session_id: REMOTE, message_id: "accepted", status: "queued" });
    }
    if (path.startsWith("/admin/daemon-sessions/")) return json(host.sessions.find(row => path.endsWith(row.id)) ?? remote);
    return json({});
  });
  return state;
}
const workspace = (page: Page) => page.getByRole("group", { name: "Client workspace" });
async function openRemote(page: Page) {
  await page.goto("/admin/clients?view=remote");
  await expect(page.locator(`#remote-${REMOTE}`)).toBeVisible();
  await page.locator(`#remote-${REMOTE}`).click();
}

test("remote and ordinary agents stay separate and use the same real conversation", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const state = await fixture(page);
  await page.goto("/admin/clients");
  await expect(page.locator(`#client-${OTHER}`)).toBeVisible();
  await expect(page.locator(`#client-${NATIVE}`)).toHaveCount(0);
  await workspace(page).getByRole("button", { name: "Remote sessions", exact: true }).click();
  await page.locator(`#remote-${REMOTE}`).click();
  await expect(page.getByRole("region", { name: "Session timeline" })).toContainText("The real conversation is here.");
  await expect(page.getByText("Diagnostic operation output")).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Nativen Session-Verlauf öffnen" })).toHaveCount(0);
  await page.getByLabel("Continue remote session").fill("Check remaining work");
  await workspace(page).getByRole("button", { name: "Agents", exact: true }).click();
  await workspace(page).getByRole("button", { name: "Remote sessions", exact: true }).click();
  await expect(page.getByLabel("Continue remote session")).toHaveValue("Check remaining work");
  await state.update();
  await expect(page.getByLabel("Continue remote session")).toHaveValue("Check remaining work");
  await page.screenshot({ path: "/tmp/rebecca-remote-desktop.png", fullPage: true });
  expect((await new AxeBuilder({ page }).include('section[aria-label="Remote session conversation"]').analyze()).violations).toEqual([]);
});

test("native and remote bookmarks select the right workspace without pinning later selection", async ({ page }) => {
  const state = await fixture(page);
  state.host.sessions.push({ ...state.remote, id: OTHER, sessionId: null, title: "Second remote", status: "queued" });
  for (const query of [`session=${NATIVE}`, `remote=${REMOTE}`]) {
    await page.goto(`/admin/clients?${query}`);
    await expect(workspace(page).getByRole("button", { name: "Remote sessions", exact: true })).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByRole("region", { name: "Session timeline" })).toBeVisible();
    await page.locator(`#remote-${OTHER}`).click();
    await state.update();
    await expect(page.getByRole("heading", { name: "Second remote", exact: true })).toBeVisible();
    await expect(page.getByRole("region", { name: "Session timeline" })).toHaveCount(0);
  }
});

test("start panel supports all engines and keeps one request ID after a lost response", async ({ page }) => {
  const state = await fixture(page); state.failStart = 1;
  await page.goto("/admin/clients");
  await page.getByRole("button", { name: "Start remote session", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.getByLabel("Engine", { exact: true }).selectOption("grok");
  await page.getByLabel("Title", { exact: true }).fill("Build helper");
  await page.getByLabel("Instruction", { exact: true }).fill("Run the build");
  await page.getByRole("button", { name: "Start session", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Your instruction is kept");
  await expect(page.getByLabel("Instruction", { exact: true })).toHaveValue("Run the build");
  await page.screenshot({ path: "/tmp/rebecca-remote-start.png", fullPage: true });
  await page.getByRole("button", { name: "Start session", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(state.posts[0].body).toEqual(state.posts[1].body);
  expect(state.posts[0].body).toMatchObject({ host_id: 1, engine: "grok", cwd: "/srv/project", title: "Build helper", prompt: "Run the build" });
});

test("continue retries are stable; busy and missing transcripts cannot resume; stop updates state", async ({ page }) => {
  const state = await fixture(page); state.failTurn = 1;
  await openRemote(page);
  await page.getByLabel("Continue remote session").fill("Continue the review");
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Your draft is kept");
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(page.getByLabel("Continue remote session")).toHaveValue("");
  expect(state.posts[0].body).toEqual(state.posts[1].body);
  state.remote.status = "queued";
  await state.update();
  await expect(page.getByRole("button", { name: "Continue", exact: true })).toBeDisabled();
  state.remote.status = "idle"; state.remote.addressId = null;
  await state.update();
  await expect(page.getByText(/No native transcript is available/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Continue", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "Details", exact: true }).click();
  await page.getByRole("button", { name: "End session", exact: true }).click();
  await expect(page.getByRole("button", { name: "End session", exact: true })).toHaveCount(0);
  expect(state.posts.at(-1)?.path).toBe(`/admin/daemon-sessions/${REMOTE}/stop`);
});

test("running remote sessions send through the existing agent composer", async ({ page }) => {
  const state = await fixture(page); state.remote.status = "running";
  await openRemote(page);
  await page.getByLabel("Message this agent").fill("Inspect the logs");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect.poll(() => state.posts.length).toBe(1);
  expect(state.posts[0].path).toBe(`/admin/agent-sessions/${NATIVE}/messages`);
  await expect(page.getByLabel("Continue remote session")).toHaveCount(0);
});

test("remote sessions survive disabled hosts and empty native lists", async ({ page }) => {
  const state = await fixture(page); state.agents = []; state.host.enabled = false; state.remote.status = "closed";
  await page.goto("/admin/clients?view=remote");
  await page.getByRole("group", { name: "Show remote sessions" }).getByRole("button", { name: "Ended", exact: true }).click();
  await page.locator(`#remote-${REMOTE}`).click();
  await expect(page.getByText("Remote starts are disabled on this host.")).toBeVisible();
  await page.getByLabel("Continue remote session").fill("Must not run");
  await expect(page.getByRole("button", { name: "Continue", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "Start remote session", exact: true }).click();
  await expect(page.getByRole("button", { name: "Start session", exact: true })).toBeDisabled();
  expect(state.posts).toEqual([]);
});

test("transcript permission gates remote details and conversation requests", async ({ page }) => {
  const state = await fixture(page, false);
  await openRemote(page);
  await page.getByRole("button", { name: "Details", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Timeline hidden" })).toBeVisible();
  await expect(page.getByText("Diagnostic operation output")).toHaveCount(0);
  await expect(page.getByLabel("Continue remote session")).toHaveCount(0);
  expect(state.calls.some(path => path.endsWith("/events") || path.startsWith("/admin/daemon-sessions/"))).toBe(false);
});

test("non-managers cannot start or control remote work", async ({ page }) => {
  const state = await fixture(page, true, false);
  await page.goto("/admin/clients?view=remote");
  await expect(page.locator(`#client-${NATIVE}`)).toBeVisible();
  await expect(page.getByRole("button", { name: "Start remote session", exact: true })).toHaveCount(0);
  expect(state.calls).not.toContain("/admin/host-daemons");
});

test("mobile keeps a single pane, fits long titles and returns focus to the list", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const state = await fixture(page);
  state.remote.title = "A very long remote task title that must never force the conversation outside the phone screen";
  await openRemote(page);
  await expect(page.getByRole("region", { name: "Session timeline" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Remote session directory" })).not.toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: "/tmp/rebecca-remote-mobile.png", fullPage: true });
  await page.getByRole("button", { name: "Back to remote sessions" }).click();
  await expect(page.locator(`#remote-${REMOTE}`)).toBeFocused();
  await expect(page.getByRole("region", { name: "Session timeline" })).toHaveCount(0);
});

test("search and engine filters handle a long retained list", async ({ page }) => {
  const state = await fixture(page);
  for (let i = 0; i < 50; i++) state.host.sessions.push({ ...state.remote, id: `history-${i}`, title: `Archived review ${i}`, engine: i % 2 ? "claude" : "grok", sessionId: null, status: "closed" });
  await page.goto("/admin/clients?view=remote");
  await page.getByRole("group", { name: "Show remote sessions" }).getByRole("button", { name: "Ended", exact: true }).click();
  await expect(page.locator('[id^="remote-history-"]')).toHaveCount(50);
  await page.getByLabel("Remote engine").selectOption("grok");
  await expect(page.locator('[id^="remote-history-"]')).toHaveCount(25);
  await page.getByLabel("Find a remote session").fill("Archived review 48");
  await expect(page.locator('[id^="remote-history-"]')).toHaveCount(1);
  await page.locator('#remote-history-48').click();
  await expect(page.getByRole("heading", { name: "Archived review 48", exact: true })).toBeVisible();
});

test("waiting questions retain their answer action rather than creating another continuation", async ({ page }) => {
  const state = await fixture(page); state.remote.status = "waiting";
  state.agents[0].pending_prompt = { id: "question", version: 1, question: "Which check?", answer_mode: "buttons", choices: [{ label: "Run checks", value: "checks" }], options: [], created_at: stamp() };
  await openRemote(page);
  await page.getByRole("button", { name: "Run checks", exact: true }).click();
  await expect.poll(() => state.posts.length).toBe(1);
  expect(state.posts[0].path).toBe(`/admin/agent-sessions/${NATIVE}/prompts/question/answer`);
  expect(state.posts[0].body).toMatchObject({ answer: "checks", version: 1 });
  await expect(page.getByLabel("Continue remote session")).toHaveCount(0);
});
