import { expect, test, type Page } from "@playwright/test";
import type { AgentSessionRow } from "../src/lib/api/agentSessions";
import AxeBuilder from "@axe-core/playwright";

const CODEX = "11111111-1111-4111-8111-111111111111";
const CLAUDE = "22222222-2222-4222-8222-222222222222";
function session(id: string, engine: AgentSessionRow["engine"], presence: AgentSessionRow["presence"] = "listening"): AgentSessionRow {
  const now = Date.now();
  return { id, engine, host_id: 1, host: `${engine}.example`, username: "operator", cwd: "/srv/fleet/auth", invocation_kind: "interactive", upstream_session_id: null, status: "active", presence, relay_ready: presence === "listening", relay_enabled: true, relay_heartbeat_at: new Date(now - 2_000).toISOString(), active_turn_id: presence === "working" ? "turn-1" : null, active_turn_started_at: presence === "working" ? new Date(now - 60_000).toISOString() : null, started_at: new Date(now - 600_000).toISOString(), heartbeat_at: new Date(now - 1_000).toISOString(), last_event_at: new Date(now - 10_000).toISOString(), attention: null, ended_at: null, expires_at: null, close_requested_at: null, close: null, read_only: false, pending_prompt: null, work: { task: engine === "codex" ? "Inspect token recovery" : "Review release checks", branch: `fix/${engine}`, target_branch: "main", declared_paths: ["api/auth"], worktree_path: "/srv/fleet", address: `agent-${engine}`, address_alias: `${engine}-review` } };
}
async function fixtures(page: Page, manage = true) {
  const state = { clearPromptOnAttempt: false, dropSendResponses: 0, denySendResponses: 0, sendStatus: "queued", bodies: [] as Array<{ path: string; body: Record<string, unknown> }>, failList: false, failEvents: false, enabled: true, sessions: [session(CODEX, "codex"), session(CLAUDE, "claude", "working")], events: [] as Record<string, unknown>[], calls: [] as string[] };
  await page.addInitScript(() => {
    const feeds: EventTarget[] = [];
    (window as unknown as { clientFeeds: EventTarget[] }).clientFeeds = feeds;
    class MockEventSource extends EventTarget {
      constructor(public url: string) { super(); feeds.push(this); queueMicrotask(() => this.dispatchEvent(new Event("open"))); }
      close() {}
    }
    window.EventSource = MockEventSource as unknown as typeof EventSource;
  });
  await page.route("**/admin/**", async (route) => {
    const request = route.request();
    if (!request.headers().accept?.includes("application/json")) return route.continue();
    const path = new URL(request.url()).pathname;
    state.calls.push(`${request.method()} ${path}`);
    if (request.method() === "POST") state.bodies.push({ path, body: request.postDataJSON() });
    const json = (data: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(data) });
    if (path === "/admin/auth/status") return json({ authenticated: true, enforced: true, user: { id: 1, username: "operator", roles: ["owner"] }, capabilities: manage ? ["agent_portal.read", "agent_portal.manage", "agent_portal.reveal_transcript"] : ["agent_portal.read"] });
    if (path === "/admin/setup/status") return json({ setup_complete: true, critical_complete: true, checks: [], next_actions: [] });
    if (path === "/admin/ws/info") return json({ enabled: false });
    if (path === "/admin/agent-sessions") return state.failList ? json({ message: "Fixture API temporarily unavailable" }, 503) : json({ enabled: state.enabled, generated_at: new Date().toISOString(), timings: { heartbeat_fresh_seconds: 45, relay_fresh_seconds: 60, working_fresh_seconds: 3600, retention_hours: 24 }, sessions: state.sessions });
    if (path.endsWith("/events")) return state.failEvents ? json({ message: "Fixture timeline unavailable" }, 503) : json({ events: state.events, next_cursor: state.events.length });
    if (path.endsWith("/messages") || path.includes("/prompts/")) {
      if (state.clearPromptOnAttempt && path.includes("/prompts/")) state.sessions[0].pending_prompt = null;
      if (state.dropSendResponses > 0) { state.dropSendResponses--; return route.abort("failed"); }
      if (state.denySendResponses > 0) { state.denySendResponses--; return json({ message: "Permission changed during retry" }, 403); }
      return json({ message_id: "message-fixture", status: state.sendStatus });
    }
    return json({});
  });
  return state;
}
async function open(page: Page) {
  await page.goto("/admin/clients");
  await expect(page.getByRole("heading", { name: "Active Clients", exact: true })).toBeVisible();
  await expect(page.locator(`#client-${CODEX}`)).toBeVisible();
}
async function stream(page: Page, type: string, data?: string) {
  await page.evaluate(({ type, data }) => {
    const source = (window as unknown as { clientFeeds: EventTarget[] }).clientFeeds.at(-1);
    source?.dispatchEvent(data ? new MessageEvent(type, { data }) : new Event(type));
  }, { type, data });
}

test("client directory exposes both engines, real presence, searchable work, and visible status dots", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await fixtures(page); await open(page);
  await expect(page.locator(`#client-${CLAUDE}`)).toContainText("Working");
  const dot = page.locator(`#client-${CODEX} .presence-dot`);
  expect(await dot.evaluate((element) => element.getBoundingClientRect().width)).toBeGreaterThan(0);
  await page.getByLabel("Engine", { exact: true }).selectOption("claude");
  await expect(page.locator(`#client-${CODEX}`)).toHaveCount(0);
  await page.getByLabel("Find a client").fill("release fix/claude");
  await expect(page.locator(`#client-${CLAUDE}`)).toBeVisible();
  await page.getByLabel("Find a client").fill("no match");
  await expect(page.getByRole("heading", { name: "No clients match" })).toBeVisible();
  await page.getByRole("button", { name: "Clear filters", exact: true }).last().click();
  await page.locator(`#client-${CODEX}`).click();
  await expect(page.getByRole("heading", { name: "operator on codex.example" })).toBeFocused();
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeDisabled();
  const results = await new AxeBuilder({ page }).analyze();
  expect(results.violations.filter((v) => ["serious", "critical"].includes(v.impact ?? ""))).toEqual([]);
  await page.screenshot({ path: "/tmp/active-clients-desktop.png", fullPage: true });
});

test("failed refresh retains clients and drafts, then retry restores live actions", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const state = await fixtures(page); await open(page);
  await page.locator(`#client-${CODEX}`).click();
  await page.getByLabel("Message this agent").fill("Keep this draft");
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
  state.failList = true;
  await page.getByRole("button", { name: "Refresh clients" }).click();
  await expect(page.getByText("Client refresh failed", { exact: true })).toBeVisible();
  await expect(page.locator(`#client-${CODEX}`)).toBeVisible();
  await expect(page.getByLabel("Message this agent")).toHaveValue("Keep this draft");
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeDisabled();
  state.failList = false;
  await page.getByRole("button", { name: "Retry status" }).click();
  await expect(page.getByText("Client refresh failed", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
});

test("SSE reconnect refreshes the selected timeline and preserves reading position", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const state = await fixtures(page);
  state.events = Array.from({ length: 35 }, (_, i) => ({ cursor: i + 1, session_id: CODEX, type: "assistant_message", source: "engine", payload: { text: `Progress entry ${i + 1}. ` + "Detailed review evidence. ".repeat(12) }, created_at: new Date(Date.now() - (40 - i) * 1000).toISOString() }));
  await open(page); await page.locator(`#client-${CODEX}`).click();
  const timeline = page.getByRole("region", { name: "Session timeline" });
  await expect(timeline).toContainText("Progress entry 35");
  await timeline.evaluate((element) => { element.scrollTop = 0; element.dispatchEvent(new Event("scroll")); });
  await expect(page.getByRole("button", { name: "Latest" })).toBeVisible();
  await stream(page, "error");
  await expect(page.getByText("Live updates reconnecting", { exact: true })).toBeVisible();
  state.events.push({ cursor: 36, session_id: CODEX, type: "assistant_message", source: "engine", payload: { text: "Recovered latest event" }, created_at: new Date().toISOString() });
  await stream(page, "open");
  await expect(timeline).toContainText("Recovered latest event");
  expect(await timeline.evaluate((element) => element.scrollTop)).toBeLessThan(10);
  await expect(page.getByRole("button", { name: "1 new" })).toBeVisible();
});

test("viewer capability gates transcripts, streams, sends, and close controls", async ({ page }) => {
  const state = await fixtures(page, false); await open(page); await page.locator(`#client-${CODEX}`).click();
  await expect(page.getByRole("heading", { name: "Timeline hidden" })).toBeVisible();
  await expect(page.getByLabel("Message this agent")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Force close", exact: true })).toHaveCount(0);
  expect(state.calls.filter((call) => call.endsWith("/events"))).toEqual([]);
  expect(await page.evaluate(() => (window as unknown as { clientFeeds: EventTarget[] }).clientFeeds.length)).toBe(0);
});

test("mobile client details and return navigation remain reachable without overflow", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await fixtures(page); await open(page); await page.locator(`#client-${CLAUDE}`).click();
  await expect(page.getByRole("heading", { name: "operator on claude.example" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Client directory" })).toBeHidden();
  await expect(page.getByRole("region", { name: "Session timeline" })).toBeVisible();
  await expect(page.getByLabel("Message this agent")).toBeInViewport();
  const composerBox = await page.getByLabel("Message this agent").boundingBox();
  expect(composerBox!.y + composerBox!.height).toBeLessThan(780);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: "/tmp/active-clients-mobile.png", fullPage: true });
  await page.getByRole("button", { name: "Clients", exact: true }).click();
  await expect(page.locator(`#client-${CLAUDE}`)).toBeFocused();
});

test("a stale heartbeat becomes offline while stored status remains active", async ({ page }) => {
  const state = await fixtures(page);
  state.sessions[0].heartbeat_at = new Date(Date.now() - 120_000).toISOString();
  await open(page);
  await expect(page.locator(`#client-${CODEX}`)).toContainText("Offline");
  await page.locator(`#client-${CODEX}`).click();
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeDisabled();
  await expect(page.getByText("No confirmed connection. The client may reconnect; running work is unconfirmed.", { exact: true }).first()).toBeVisible();
});


test("historical prompt options cannot answer the current question", async ({ page }) => {
  const state = await fixtures(page);
  const current = "current-question";
  state.sessions[0].pending_prompt = { id: current, version: 2, question: "Current question?", options: ["Current accept"], created_at: new Date().toISOString() };
  state.events = [
    { cursor: 1, session_id: CODEX, type: "waiting_input", source: "engine", payload: { prompt_id: "old-question", prompt_version: 1, question: "Historical question?", options: ["Old accept"] }, created_at: new Date(Date.now() - 1000).toISOString() },
    { cursor: 2, session_id: CODEX, type: "waiting_input", source: "engine", payload: { prompt_id: current, prompt_version: 2, question: "Current question?", options: ["Current accept"] }, created_at: new Date().toISOString() },
  ];
  await open(page); await page.locator(`#client-${CODEX}`).click();
  await expect(page.getByText("Historical question?", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Old accept", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Current accept", exact: true }).click();
  await expect.poll(() => state.bodies.some((entry) => entry.path.endsWith(`/prompts/${current}/answer`) && entry.body.answer === "Current accept" && entry.body.version === 2)).toBe(true);
});

test("ambiguous send failures retain draft and retry the same instruction key", async ({ page }) => {
  const state = await fixtures(page); state.dropSendResponses = 2;
  await open(page); await page.locator(`#client-${CODEX}`).click();
  const composer = page.getByLabel("Message this agent");
  const send = page.getByRole("button", { name: "Send", exact: true });
  await composer.fill("Preserve this instruction"); await send.click();
  await expect.poll(() => state.bodies.filter((entry) => entry.path.endsWith("/messages")).length).toBe(2);
  await expect(send).toBeEnabled();
  await expect(composer).toHaveValue("Preserve this instruction");
  await send.click();
  await expect(composer).toHaveValue("");
  const attempts = state.bodies.filter((entry) => entry.path.endsWith("/messages"));
  expect(attempts).toHaveLength(3);
  expect(new Set(attempts.map((entry) => entry.body.client_message_id)).size).toBe(1);
  await composer.fill("Preserve this instruction"); await send.click();
  await expect(composer).toHaveValue("");
  const fresh = state.bodies.filter((entry) => entry.path.endsWith("/messages")).at(-1)!;
  expect(fresh.body.client_message_id).not.toBe(attempts[0].body.client_message_id);
});


test("an unconfirmed answer survives a later denial after the current prompt clears", async ({ page }) => {
  const state = await fixtures(page);
  state.dropSendResponses = 2; state.clearPromptOnAttempt = true;
  state.sessions[0].pending_prompt = { id: "uncertain-question", version: 4, question: "Proceed?", options: [], created_at: new Date().toISOString() };
  await open(page); await page.locator(`#client-${CODEX}`).click();
  const composer = page.getByLabel("Message this agent");
  const send = page.getByRole("button", { name: "Send", exact: true });
  await composer.fill("Yes, continue"); await send.click();
  await expect.poll(() => state.bodies.filter((entry) => entry.path.includes("/prompts/")).length).toBe(2);
  await expect(send).toBeEnabled();
  await expect(page.getByText(/A previous send was not confirmed/)).toBeVisible();
  state.denySendResponses = 1;
  await send.click();
  await expect.poll(() => state.bodies.filter((entry) => entry.path.includes("/prompts/")).length).toBe(3);
  await expect(send).toBeEnabled();
  await expect(composer).toHaveValue("Yes, continue");
  await send.click(); await expect(composer).toHaveValue("");
  const attempts = state.bodies.filter((entry) => entry.path.includes("/prompts/") || entry.path.endsWith("/messages"));
  expect(attempts).toHaveLength(4);
  expect(attempts.every((entry) => entry.path.endsWith("/prompts/uncertain-question/answer"))).toBe(true);
  expect(new Set(attempts.map((entry) => entry.body.client_message_id)).size).toBe(1);
});

test("an expired delivery response preserves the unsent draft", async ({ page }) => {
  const state = await fixtures(page); state.sendStatus = "dead";
  await open(page); await page.locator(`#client-${CODEX}`).click();
  const composer = page.getByLabel("Message this agent");
  await composer.fill("Keep undelivered work");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByText("This instruction was not delivered. Your draft is kept.", { exact: true })).toBeVisible();
  await expect(composer).toHaveValue("Keep undelivered work");
});
