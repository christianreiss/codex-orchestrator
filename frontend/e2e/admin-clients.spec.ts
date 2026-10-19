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
  let emit: ((data: string) => void) | undefined;
  await page.routeWebSocket("**/clients-ws", ws => { emit = data => ws.send(data); });
  const state = { update: async (type = "agent_portal.sessions.changed") => {
    await expect.poll(() => Boolean(emit)).toBe(true);
    emit!(JSON.stringify({ type, payload: {}, ts: new Date().toISOString() }));
  }, clearPromptOnAttempt: false, dropSendResponses: 0, denySendResponses: 0, sendStatus: "queued", bodies: [] as Array<{ path: string; body: Record<string, unknown> }>, failList: false, failEvents: false, enabled: true, sessions: [session(CODEX, "codex"), session(CLAUDE, "claude", "working")], events: [] as Record<string, unknown>[], calls: [] as string[] };
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
    if (path === "/admin/auth/status") return json({ authenticated: true, enforced: true, user: { id: 1, username: "operator", roles: ["owner"] }, capabilities: manage ? ["agent_portal.read", "agent_portal.manage", "agent_portal.reveal_transcript", "agent_messaging.manage"] : ["agent_portal.read"] });
    if (path === "/admin/setup/status") return json({ setup_complete: true, critical_complete: true, checks: [], next_actions: [], wizard: { completed_at: "2026-09-28T00:00:00Z", dismissed_at: null } });
    if (path === "/admin/ws/info") return json({ enabled: true, url: new URL("/clients-ws", request.url()).href.replace(/^http/, "ws") });
    if (path === "/admin/agent-portal/state") {
      if (request.method() === "POST") state.enabled = request.postDataJSON().enabled;
      return json({ enabled: state.enabled, active_sessions: state.sessions.length, queued_messages: 0, dead_messages: 0 });
    }
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
async function open(page: Page, ready = CODEX) {
  await page.goto("/admin/agents");
  await expect(page.getByRole("heading", { name: "Agents", exact: true, level: 1 })).toBeVisible({ timeout: 15_000 });
  await expect(page.locator(`#client-${ready}`)).toBeVisible();
}
async function stream(page: Page, type: string, data?: string) {
  await page.evaluate(({ type, data }) => {
    const source = (window as unknown as { clientFeeds: EventTarget[] }).clientFeeds.at(-1);
    source?.dispatchEvent(data ? new MessageEvent(type, { data }) : new Event(type));
  }, { type, data });
}

test("only online chats are listed; offline and ended ones stay readable by link", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const state = await fixtures(page);
  state.events = [{ cursor: 1, session_id: CODEX, type: "assistant_message", source: "engine", payload: { text: "Retained conversation" }, created_at: new Date().toISOString() }];
  await open(page);
  for (const presence of ["offline", "ended", "listening"]) {
    Object.assign(state.sessions[0], {
      presence, relay_ready: presence === "listening", read_only: presence === "ended",
      ended_at: presence === "ended" ? new Date().toISOString() : null,
      expires_at: presence === "ended" ? new Date(Date.now() + 86_400_000).toISOString() : null,
    });
    await page.reload();
    if (presence !== "listening") {
      await expect(page.locator(`#client-${CLAUDE}`)).toBeVisible();
      await expect(page.locator(`#client-${CODEX}`)).toHaveCount(0);
      await page.goto(`/admin/agents?session=${CODEX}`);
    } else {
      await expect(page.locator(`#client-${CODEX}`)).toBeVisible();
      await page.locator(`#client-${CODEX}`).click();
    }
    await expect(page.getByRole("region", { name: "Session timeline" })).toContainText("Retained conversation");
    if (presence === "ended") await expect(page.getByLabel("Message this agent")).toHaveCount(0);
    else {
      await page.getByLabel("Message this agent").fill("Continue");
      if (presence === "offline") await expect(page.getByRole("button", { name: "Send", exact: true })).toBeDisabled();
      else await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
    }
  }
  state.sessions = state.sessions.filter(row => row.id !== CODEX);
  await state.update();
  await expect(page.locator(`#client-${CODEX}`)).toHaveCount(0);
});

test("client directory exposes both engines, searchable work, and accessible avatar status icons", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await fixtures(page); await open(page);
  await expect(page.getByRole("button", { name: "Refresh clients" })).toHaveCount(0);
  await expect(page.locator(`#client-${CLAUDE}`).getByRole("img", { name: "Working", exact: true })).toBeVisible();
  const icon = page.locator(`#client-${CODEX} [data-client-status="listening"]`);
  expect(await icon.evaluate((element) => element.getBoundingClientRect().width)).toBeGreaterThan(0);
  await page.getByLabel("Engine", { exact: true }).selectOption("claude");
  await expect(page.locator(`#client-${CODEX}`)).toHaveCount(0);
  await page.getByLabel("Find a client").fill("release fix/claude");
  await expect(page.locator(`#client-${CLAUDE}`)).toBeVisible();
  await page.getByLabel("Find a client").fill("no match");
  await expect(page.getByRole("heading", { name: "No clients match" })).toBeVisible();
  await page.getByRole("button", { name: "Clear filters", exact: true }).last().click();
  await page.locator(`#client-${CODEX}`).click();
  await expect(page.getByRole("heading", { name: "codex-review" })).toBeFocused();
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeDisabled();
  const results = await new AxeBuilder({ page }).analyze();
  expect(results.violations.filter((v) => ["serious", "critical"].includes(v.impact ?? ""))).toEqual([]);
  await page.screenshot({ path: "/tmp/active-clients-desktop.png", fullPage: true });
});

test("the chat list shows online agents only and native activity on avatars", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const state = await fixtures(page);
  const at = new Date().toISOString();
  const expires = new Date(Date.now() + 120_000).toISOString();
  state.sessions[0].activity = { state: "idle", source: "engine", wait_reason: null, changed_at: at, expires_at: expires };
  state.sessions[1].activity = { state: "working", source: "engine", wait_reason: null, changed_at: at, expires_at: expires };
  const waiting = session("waiting", "grok");
  waiting.activity = { state: "waiting", source: "engine", wait_reason: "input", changed_at: at, expires_at: expires };
  const offline = session("offline", "grok", "offline");
  offline.activity = { state: "working", source: "engine", wait_reason: null, changed_at: at, expires_at: expires };
  offline.attention = { since: at, summary: "Reconnect needed", severity: "important" };
  const ended = session("ended-notice", "claude", "ended");
  ended.ended_at = at;
  ended.attention = { since: at, summary: "Result needs review", severity: "critical" };
  const unknown = session("unknown", "codex");
  unknown.activity = { state: "working", source: "engine", wait_reason: null, changed_at: at, expires_at: new Date(Date.now() - 1_000).toISOString() };
  state.sessions.push(waiting, offline, ended, unknown);
  await open(page);
  await expect(page.getByRole("group", { name: "Show sessions" })).toHaveCount(0);
  await expect(page.locator(`#client-${CODEX} [data-client-status="idle"]`)).toBeVisible();
  await expect(page.locator(`#client-${CLAUDE} [data-client-status="working"]`)).toBeVisible();
  await expect(page.locator('#client-waiting [data-client-status="waiting"]')).toBeVisible();
  await expect(page.locator('#client-unknown [data-client-status="unknown"]')).toBeVisible();
  // Same rule as the Android app: offline and ended agents are not current chats, even with a notice.
  await expect(page.locator('#client-offline')).toHaveCount(0);
  await expect(page.locator('#client-ended-notice')).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: "/tmp/active-clients-compact-mobile.png", fullPage: true });
  await expect(page.locator('#client-waiting')).toBeVisible();
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.screenshot({ path: "/tmp/active-clients-compact-desktop.png", fullPage: true });
});

test("failed refresh retains clients and drafts, then retry restores live actions", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const state = await fixtures(page); await open(page);
  await page.locator(`#client-${CODEX}`).click();
  await page.getByLabel("Message this agent").fill("Keep this draft");
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
  state.failList = true;
  await state.update();
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
  await expect(page.getByRole("heading", { name: "claude-review" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Client directory" })).toBeHidden();
  await expect(page.getByRole("region", { name: "Session timeline" })).toBeVisible();
  await expect(page.getByLabel("Message this agent")).toBeInViewport();
  const composerBox = await page.getByLabel("Message this agent").boundingBox();
  expect(composerBox!.y + composerBox!.height).toBeLessThan(780);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: "/tmp/active-clients-mobile.png", fullPage: true });
  await page.getByRole("button", { name: "Agents", exact: true }).click();
  await expect(page.locator(`#client-${CLAUDE}`)).toBeFocused();
});

test("a stale heartbeat becomes offline while stored status remains active", async ({ page }) => {
  const state = await fixtures(page);
  state.sessions[0].heartbeat_at = new Date(Date.now() - 120_000).toISOString();
  await open(page, CLAUDE);
  await expect(page.locator(`#client-${CODEX}`)).toHaveCount(0);
  await page.goto(`/admin/agents?session=${CODEX}`);
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

for (const engine of ["codex", "claude"] as const) {
  test(`${engine} resolved attention follows the snapshot and leaves its question actionable`, async ({ page }) => {
    await page.setViewportSize(engine === "codex" ? { width: 1440, height: 1000 } : { width: 390, height: 844 });
    const state = await fixtures(page);
    const target = state.sessions.find((row) => row.engine === engine)!;
    const raised = new Date(Date.now() - 1000).toISOString();
    const question = `question-${engine}`;
    target.attention = { since: raised, summary: "Local acknowledgment needed" };
    target.pending_prompt = { id: question, version: 3, question: "Keep this question open?", options: ["Answer current question"], created_at: raised };
    state.events = [
      { cursor: 1, session_id: target.id, type: "attention", source: "engine", payload: { summary: "Local acknowledgment needed" }, created_at: raised },
      { cursor: 2, session_id: target.id, type: "waiting_input", source: "engine", payload: { prompt_id: question, prompt_version: 3, question: "Keep this question open?", options: ["Answer current question"] }, created_at: raised },
    ];
    await open(page); await page.locator(`#client-${target.id}`).click();
    const banner = page.getByRole("region", { name: "Needs you", exact: true });
    await expect(banner).toBeVisible();
    await expect(banner).toContainText("Local acknowledgment needed");
    await page.getByLabel("Message this agent").fill("Keep my unrelated draft");
    await page.locator("#client-detail").screenshot({ path: `/tmp/needs-you-active-${engine === "codex" ? "desktop" : "mobile"}.png` });
    const resolution = { cursor: 3, session_id: target.id, type: "attention_resolved", source: "engine", payload: { summary: "Acknowledged locally" }, created_at: new Date().toISOString() };
    state.events.push(resolution);
    const before = state.calls.filter((call) => call === "GET /admin/agent-sessions").length;
    await stream(page, "agent", JSON.stringify(resolution));
    await expect.poll(() => state.calls.filter((call) => call === "GET /admin/agent-sessions").length).toBeGreaterThan(before);
    await expect(page.getByRole("region", { name: "Session timeline" })).not.toContainText(/Needed you|Attention resolved|Local acknowledgment needed/);
    // The event alone must not invent a cleared server projection.
    await expect(banner).toContainText("Local acknowledgment needed");
    await expect(page.getByRole("button", { name: "Refresh clients", exact: true, includeHidden: true })).toHaveCount(0);
    target.attention = null;
    await stream(page, "agent", JSON.stringify(resolution));
    await expect(banner).not.toContainText("Local acknowledgment needed");
    await expect(banner).toContainText("Keep this question open?");
    await expect(page.locator(`#client-${target.id}`)).toHaveClass(/ring-destructive/);
    await page.getByRole("button", { name: "Answer current question", exact: true }).click();
    await expect.poll(() => state.bodies.some((entry) => entry.path.endsWith(`/prompts/${question}/answer`) && entry.body.version === 3)).toBe(true);
    await expect(page.getByLabel("Message this agent")).toHaveValue("Keep my unrelated draft");
    await expect(page.getByRole("button", { name: "Refresh clients", exact: true, includeHidden: true })).toHaveCount(0);
    target.pending_prompt = null;
    await stream(page, "agent", JSON.stringify(resolution));
    await expect(banner).toHaveCount(0);
    await expect(page.getByRole("region", { name: "Session timeline" })).not.toContainText(/Needed you|Attention resolved/);
    await page.locator("#client-detail").screenshot({ path: `/tmp/needs-you-resolved-${engine === "codex" ? "desktop" : "mobile"}.png` });
  });
}

test("a current attention bar disappears on resolution without leaving chat notices", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const state = await fixtures(page);
  const raised = new Date().toISOString();
  state.sessions[0].attention = { since: raised, summary: "Check the local result" };
  // The current bar must work even when its original event is outside the tail.
  await open(page); await page.locator(`#client-${CODEX}`).click();
  const banner = page.getByRole("region", { name: "Needs you", exact: true });
  await expect(banner).toContainText("Check the local result");
  await page.getByLabel("Message this agent").fill("Draft stays with me");
  await banner.getByRole("button", { name: "Reply", exact: true }).click();
  await expect(page.getByLabel("Message this agent")).toBeFocused();
  state.sessions[0].attention = null;
  state.events = [
    { cursor: 1, session_id: CODEX, type: "attention", source: "engine", payload: { summary: "Check the local result" }, created_at: raised },
    { cursor: 2, session_id: CODEX, type: "attention_resolved", source: "engine", payload: { summary: "Done" }, created_at: new Date().toISOString() },
  ];
  await stream(page, "agent", JSON.stringify(state.events[1]));
  await expect(banner).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Session timeline" })).not.toContainText(/Needed you|Attention resolved|Check the local result/);
  await expect(page.getByLabel("Message this agent")).toHaveValue("Draft stays with me");
});


test("receiver health offers silent reconnection without model verification", async ({ page }) => {
  const state = await fixtures(page);
  state.sessions[0].receiver = {
    generation: CODEX, protocol: "codex-queue-v1", native_session_id: "native",
    heartbeat_at: new Date().toISOString(), failure: null, state: "ready",
    sources: [{ source: "peer", state: "ready", delivery_id: null, delivered_at: null, acknowledged_at: null, latency_ms: null }],
  };
  await open(page);
  await page.locator(`#client-${CODEX}`).click();
  await page.getByRole("button", { name: "Session details", exact: true }).click();
  await expect(page.getByText("peer: ready · transport health", { exact: true })).toBeVisible();
  await expect(page.getByText(/model acknowledgment|Verify reception/)).toHaveCount(0);
  await page.getByRole("button", { name: "Reconnect receiver", exact: true }).click();
  await expect.poll(() => state.bodies.filter((b) => b.path.endsWith("/receiver/verify")).length).toBe(1);
  expect(state.bodies.some((b) => b.path.endsWith("/messages"))).toBe(false);
});


test("Grok clients are visible and searchable by cgx", async ({ page }) => {
  const state = await fixtures(page);
  const id = "33333333-3333-4333-8333-333333333333";
  state.sessions.push(session(id, "grok", "idle"));
  await open(page);
  await expect(page.locator(`#client-${id}`)).toBeVisible();
  await page.getByLabel("Engine", { exact: true }).selectOption("grok");
  await page.getByLabel("Find a client").fill("cgx");
  await expect(page.locator(`#client-${id}`)).toBeVisible();
  await expect(page.locator(`#client-${CODEX}`)).toHaveCount(0);
  await page.locator(`#client-${id}`).click();
  await expect(page.getByRole("heading", { name: "grok-review" })).toBeVisible();
  await expect(page.getByText("Grok · Not listening", { exact: false })).toBeVisible();
});

for (const width of [1440, 390]) {
  test(`client cards show launch names, directories, status, local engine logos and summaries at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1000 });
    const state = await fixtures(page);
    state.sessions.push(session("33333333-3333-4333-8333-333333333333", "grok", "idle"));
    for (const [index, row] of state.sessions.entries()) {
      row.launch_name = ["Vivienne", "Claudia", "Greta"][index];
      row.session_name = `(${row.launch_name}) Release review`;
      row.preview = { summary: `Verified ${row.engine} release`, cursor: index + 1, created_at: new Date().toISOString() };
      row.cwd = `/home/operator/Documents/${row.engine}/nested/directory`;
    }
    await open(page);
    for (const row of state.sessions) {
      const card = page.locator(`#client-${row.id}`);
      await expect(card).toContainText(row.launch_name!);
      await expect(card).toContainText(row.cwd);
      await expect(card).toContainText(row.preview!.summary);
      const bounds = await card.boundingBox();
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
      const logo = card.getByRole("img", { name: row.engine === "codex" ? "Codex" : row.engine === "claude" ? "Claude" : "Grok", exact: true });
      await expect(logo).toBeVisible();
      expect(await logo.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0)).toBe(true);
      expect(new URL(await logo.getAttribute("src") ?? "", page.url()).origin).toBe(new URL(page.url()).origin);
    }
    await expect(page.locator(`#client-${CLAUDE}`).getByRole("img", { name: "Working", exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: `/tmp/active-clients-cards-${width}.png`, fullPage: true });
    await page.getByLabel("Find a client").fill("Vivienne Verified codex");
    await expect(page.locator(`#client-${CODEX}`)).toBeVisible();
    await expect(page.locator(`#client-${CLAUDE}`)).toHaveCount(0);
    await page.locator(`#client-${CODEX}`).click();
    await expect(page.getByRole("heading", { name: "Vivienne", exact: true })).toBeVisible();
  });
}


test("session settings live in Policies and disabled clients link there", async ({ page }) => {
  const state = await fixtures(page);
  await page.route("**/admin/authorization", route => route.fulfill({ json: { mode: "compatible", would_deny: [], updated_at: null } }));
  await open(page);
  await expect(page.getByRole("switch", { name: "Agent sessions", exact: true })).toHaveCount(0);
  await page.goto("/admin/settings#agent-sessions");
  const toggle = page.getByRole("switch", { name: "Agent sessions", exact: true });
  await expect(toggle).toBeVisible();
  await toggle.click();
  await expect(toggle).not.toBeChecked();
  expect(state.enabled).toBe(false);
  await page.goto("/admin/agents");
  await expect(page.getByRole("heading", { name: "Agent sessions are off", exact: true })).toBeVisible();
  await page.getByRole("link", { name: "Agent session settings", exact: true }).click();
  await expect(toggle).toBeVisible();
  await toggle.click();
  await expect(toggle).toBeChecked();
});

 test("planned reboot links the previous and resumed launch", async ({ page }) => {
  const state = await fixtures(page);
  const handoff = { request_id: "33333333-3333-4333-8333-333333333333", state: "resumed", old_session_id: CODEX, new_session_id: CLAUDE };
  state.sessions[0].reboot = handoff;
  state.sessions[1].reboot = handoff;
  await open(page);
  await page.locator(`#client-${CODEX}`).click();
  await expect(page.getByText("Planned reboot · resumed")).toBeVisible();
  await page.getByRole("button", { name: "Open resumed session" }).click();
  await expect(page.getByRole("heading", { name: "claude-review", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Open previous session" }).click();
  await expect(page.getByRole("heading", { name: "codex-review", exact: true })).toBeVisible();
});

test("rich buttons send stable values and ordinary questions remain separate from Needs you",async({page})=>{
  const state=await fixtures(page);state.sessions[0].pending_prompt={id:CODEX,version:1,question:'Deploy this change?',answer_mode:'buttons',choices:[{label:'Approve deployment',value:'approve'}],options:[],created_at:new Date().toISOString()};
  await open(page);await page.locator(`#client-${CODEX}`).click();
  await expect(page.getByRole('region',{name:'Your answer',exact:true})).toBeVisible();await expect(page.getByLabel('Message this agent')).toHaveCount(0);
  await page.getByRole('button',{name:'Approve deployment',exact:true}).click();
  await expect.poll(()=>state.bodies.some(b=>b.body.answer==='approve' && (b.body.metadata as Record<string,unknown>).choice_value==='approve')).toBe(true);
});

test("explicit offline urgency survives browsing and resolves only the targeted notice",async({page})=>{
  const state=await fixtures(page);const notice='44444444-4444-4444-8444-444444444444';const raised=new Date().toISOString();
  state.sessions[0].presence='ended';state.sessions[0].ended_at=raised;state.sessions[0].read_only=true;
  state.sessions[0].attention={id:notice,severity:'blocker',summary:'Review the failed rollout',since:raised};state.sessions[0].notices=[{id:notice,severity:'blocker',summary:'Review the failed rollout',since:raised}];
  await open(page, CLAUDE);await expect(page.locator(`#client-${CODEX}`)).toHaveCount(0);
  await page.goto(`/admin/agents?session=${CODEX}`);
  await expect(page.getByRole('region',{name:'Needs you',exact:true})).toContainText('blocker');
  expect(state.bodies.filter(b=>b.path.endsWith('/notices/resolve'))).toHaveLength(0);
  await page.getByRole('button',{name:'Mark resolved',exact:true}).click();
  await expect.poll(()=>state.bodies.some(b=>b.path.endsWith('/notices/resolve') && b.body.notice_id===notice)).toBe(true);
});

test("attachment-only upload retains an ID through chunking and sends once sealed",async({page})=>{
  const state=await fixtures(page);let attachment='';
  await page.route('**/admin/agent-sessions/*/attachments**',async route=>{
    const path=new URL(route.request().url()).pathname;const body=route.request().postDataJSON();
    if(path.endsWith('/attachments')) attachment=body.id;
    await route.fulfill({contentType:'application/json',body:JSON.stringify({id:attachment,uploaded_bytes:path.endsWith('/chunks')?5:0,status:path.endsWith('/seal')?'ready':'uploading'})});
  });
  await open(page);await page.locator(`#client-${CODEX}`).click();
  await page.locator('input[type=file]').first().setInputFiles({name:'test.txt',mimeType:'text/plain',buffer:Buffer.from('hello')});
  await expect(page.getByText('test.txt · ready',{exact:false})).toBeVisible();await page.getByRole('button',{name:'Send',exact:true}).click();
  await expect.poll(()=>state.bodies.some(b=>b.path.endsWith('/messages') && b.body.content==='' && (b.body.metadata as {attachments:string[]}).attachments[0]===attachment)).toBe(true);
});

test('switching conversations pauses queued uploads and keeps drafts with their original conversation', async ({page}) => {
  await fixtures(page);
  let chunkStarted = false;
  let creates = 0;
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/admin/agent-sessions/*/attachments**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/chunks')) { chunkStarted = true; await blocked; }
    if (path.endsWith('/attachments')) creates++;
    await route.fulfill({contentType:'application/json',body:JSON.stringify({uploaded_bytes:0,status:'uploading'})}).catch(() => {});
  });
  try {
    await open(page); await page.locator(`#client-${CODEX}`).click();
    await page.locator('input[type=file]').first().setInputFiles([
      {name:'first.txt',mimeType:'text/plain',buffer:Buffer.from('first')},
      {name:'queued.txt',mimeType:'text/plain',buffer:Buffer.from('queued')},
    ]);
    await expect.poll(() => chunkStarted).toBe(true);
    await page.locator(`#client-${CLAUDE}`).click();
    await expect(page.getByText('first.txt ·', {exact:false})).toHaveCount(0);
    await page.locator(`#client-${CODEX}`).click();
    await expect(page.getByText('first.txt · failed', {exact:false})).toBeVisible();
    await expect(page.getByText('queued.txt · failed', {exact:false})).toBeVisible();
    expect(creates).toBe(1);
  } finally { release(); }
});

test("native activity changes labels without changing receiver send permission", async ({ page }) => {
  const state = await fixtures(page);
  state.sessions[0].activity = { state: "working", wait_reason: null, source: "codex-thread", changed_at: new Date().toISOString(), expires_at: new Date(Date.now() + 45_000).toISOString() };
  await open(page);
  await expect(page.locator(`#client-${CODEX}`).getByRole("img", { name: "Working", exact: true })).toBeVisible();
  await page.locator(`#client-${CODEX}`).click();
  await page.getByLabel("Message this agent").fill("Next instruction");
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
  for (const [activity, label] of [["idle", "Idle"], ["waiting", "Waiting for you"], ["unknown", "Unknown"]] as const) {
    state.sessions[0].activity = { ...state.sessions[0].activity!, state: activity, wait_reason: activity === "waiting" ? "approval" : null };
    await state.update();
    await expect(page.locator(`#client-${CODEX}`).getByRole("img", { name: label, exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
  }
  state.sessions[0].activity = { ...state.sessions[0].activity!, state: "working", expires_at: new Date(Date.now() - 1000).toISOString() };
  await state.update();
  await expect(page.locator(`#client-${CODEX}`).getByRole("img", { name: "Unknown", exact: true })).toBeVisible();
  await page.screenshot({path: "/tmp/cxx-native-activity-web.png", fullPage: true});
});
