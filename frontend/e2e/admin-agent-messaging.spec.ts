import { expect, test, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

const CODEX = "11111111-1111-4111-8111-111111111111";
const CLAUDE = "22222222-2222-4222-8222-222222222222";
const GROK = "33333333-3333-4333-8333-333333333333";
const SERVER = "agent:00000000-0000-4000-8000-000000000001";
function peer(id: string, engine: string) {
  const now = new Date().toISOString();
  return { id, address_id: id, address: `agent:${id}`, alias: `${engine}-review`, engine, host_id: 1, fqdn: `${engine}.example`, username: "operator", cwd: "/srv/fleet", enabled: true, continuity: "native", presence: "listening", readiness: "ready", adapter_protocol: "native", adapter_capabilities: {}, binding_generation: 1, current_session_id: id, receive_heartbeat_at: now, last_seen_at: now, created_at: now, joined_at: now, queue_depth: 0, host_secure: true, host_status: "active", host_engines: [engine], eligible: true, ineligible_reason: null };
}
async function fixtures(page: Page, manage = true) {
  const now = new Date().toISOString();
  const peers = [peer(CODEX, "codex"), peer(CLAUDE, "claude"), peer(GROK, "grok")];
  const groups = [{ id: "release", slug: "release", title: "Release review", description: "A scoped release audience", topic: "group:release", member_count: 2, created_at: now, updated_at: now }, { id: "security", slug: "security", title: "Security", description: "Only security subscribers", topic: "group:security", member_count: 1, created_at: now, updated_at: now }];
  const state = { messages: [] as Array<Record<string, unknown>>, enabled: true, dropPublish: 0, failGroups: false, bodies: [] as Array<{path: string; body: Record<string, unknown>}>, calls: [] as string[], errors: [] as string[], groups };
  page.on("pageerror", (error) => state.errors.push(error.message));
  await page.route("**/admin/**", async (route) => {
    const request = route.request();
    if (!request.headers().accept?.includes("application/json")) return route.continue();
    const path = new URL(request.url()).pathname;
    state.calls.push(`${request.method()} ${path}`);
    const json = (data: unknown, status = 200) => route.fulfill({ status, json: data });
    if (path === "/admin/auth/status") return json({ authenticated: true, enforced: true, user: { id: 1, username: "operator", roles: ["owner"] }, capabilities: ["admin.read", "agent_messaging.read", ...(manage ? ["agent_messaging.manage", "agent_portal.read", "agent_portal.manage"] : [])] });
    if (path === "/admin/setup/status") return json({ setup_complete: true, critical_complete: true, checks: [], next_actions: [], wizard: { completed_at: now, dismissed_at: null } });
    if (path === "/admin/ws/info") return json({ enabled: false });
    if (path === "/admin/agent-messaging/state") return json({ enabled: state.enabled, addresses: 3, live_addresses: 3, relays: 1, open_conversations: 0, messages: { queued: 0, leased: 0, accepted: 0, dead: 0, ambiguous: 0 }, directions: [], delivery: "ordered_at_least_once" });
    if (path === "/admin/agent-messaging/addresses") return json({ addresses: peers });
    if (path === "/admin/agent-messaging/conversations") return json({ conversations: [] });
    if (path === "/admin/agent-messaging/messages") return json({ messages: state.messages });
    if (path.endsWith('/fresh-start')) {
      state.bodies.push({path,body:request.postDataJSON()});
      state.messages[0] = {...state.messages[0],status:'queued',execution_version:2,last_error_code:null};
      return json({grant:{message_id:CODEX}});
    }
    if (path === "/admin/agent-messaging/groups") {
      if (request.method() === "POST") {
        const body = request.postDataJSON(); state.bodies.push({ path, body });
        const group = { ...groups[0], ...body, id: body.slug, topic: `group:${body.slug}`, member_count: 0 };
        groups.push(group);
        return json({ created: true, group });
      }
      return state.failGroups ? json({ message: "Groups unavailable" }, 503) : json({ groups });
    }
    if (path.startsWith("/admin/agent-messaging/groups/")) {
      const slug = path.split("/").at(-1);
      const group = groups.find((item) => item.slug === slug);
      return json({ group, members: slug === "release" ? peers.slice(0, 2) : slug === "security" ? peers.slice(2) : [] });
    }
    if (path === "/admin/agent-messaging/subscriptions") return json({ subscriptions: [{ topic: "group:release", subscriber_address_id: CODEX, subscriber_address: `agent:${CODEX}`, subscriber_engine: "codex", created_at: now }, { topic: "group:release", subscriber_address_id: CLAUDE, subscriber_address: `agent:${CLAUDE}`, subscriber_engine: "claude", created_at: now }, { topic: `agent:${CODEX}`, subscriber_address_id: GROK, subscriber_address: `agent:${GROK}`, subscriber_engine: "grok", created_at: now }, { topic: SERVER, subscriber_address_id: GROK, subscriber_address: `agent:${GROK}`, subscriber_engine: "grok", created_at: now }] });
    if (path === "/admin/agent-messaging/publish") {
      const body = request.postDataJSON(); state.bodies.push({ path, body });
      if (state.dropPublish-- > 0) return route.abort("failed");
      return json({ publication_id: "44444444-4444-4444-8444-444444444444", topic: body.topic, created: state.bodies.filter((item) => item.body.client_message_id === body.client_message_id).length === 1, recipient_count: body.topic === SERVER ? 1 : 2, deliveries: body.topic === SERVER ? [{ address_id: GROK, message_id: "server-message" }] : [{ address_id: CODEX, message_id: "codex-message" }, { address_id: CLAUDE, message_id: "claude-message" }], skipped: [{ address_id: "55555555-5555-4555-8555-555555555555", reason: "engine_disabled" }] });
    }
    return json({});
  });
  return state;
}
async function open(page: Page) {
  await page.goto("/admin/agent-messaging?view=groups&group=release");
  await expect(page.getByRole("heading", { name: "Groups & subscriptions", exact: true })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("region", { name: "Group subscribers" })).toContainText("codex-review");
}

test("groups expose opt-in audiences and individual follows on desktop and mobile", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 }); const state = await fixtures(page); await open(page);
  const members = page.getByRole("region", { name: "Group subscribers" });
  await expect(members).toContainText("claude-review"); await expect(members).not.toContainText("grok-review");
  const directory = page.getByRole("region", { name: "Subscription directory", exact: true });
  await expect(directory).toContainText("grok-review follows codex-review");
  await expect(directory).toContainText("Server updates");
  await expect(page.getByRole("link", { name: "Message one agent in Active Clients" })).toHaveAttribute("href", "/admin/clients");
  await page.getByLabel("Find subscriptions").fill("grok"); await expect(directory).not.toContainText("claude-review");
  const axe = await new AxeBuilder({ page }).analyze();
  expect(axe.violations.filter((violation) => ["serious", "critical"].includes(violation.impact ?? ""))).toEqual([]);
  await page.screenshot({ path: "/tmp/agent-messaging-groups-desktop.png", fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.getByRole("button", { name: "Security 1 subscriber", exact: false }).click();
  await expect(page).toHaveURL(/group=security/); await expect(members).toContainText("grok-review");
  await page.screenshot({ path: "/tmp/agent-messaging-groups-mobile.png", fullPage: true });
  expect(state.errors).toEqual([]);
});

test("publication retries reuse the receipt ID and expose each scoped recipient", async ({ page }) => {
  const state = await fixtures(page); state.dropPublish = 1; await open(page);
  await page.getByLabel("Message to subscribers").fill("Release ready for review");
  await page.getByRole("button", { name: "Publish to subscribers", exact: true }).click();
  await expect(page.getByRole("button", { name: "Retry publication" })).toBeVisible();
  await expect(page.getByLabel("Message to subscribers")).toHaveValue("Release ready for review");
  await page.getByRole("button", { name: "Retry publication" }).click();
  await expect(page.getByRole("status", { name: "Publication receipt" })).toContainText("2 recipients queued · Existing publication");
  expect(state.bodies[0].body.client_message_id).toBe(state.bodies[1].body.client_message_id);
  expect(state.bodies[0].body.topic).toBe("group:release");
  await page.getByText("Recipient receipts", { exact: true }).click();
  const receipt = page.getByRole("status", { name: "Publication receipt" });
  await expect(receipt).toContainText("codex-review · queued · codex-message");
  await expect(receipt).toContainText("claude-review · queued · claude-message");
  await expect(receipt).not.toContainText("grok-review");
  await expect(receipt).toContainText("skipped: engine_disabled");
  expect(state.calls.some((call) => call.includes("/reveal"))).toBe(false);
});

test("editing a failed publication creates a new ID and Server followers are explicit", async ({ page }) => {
  const state = await fixtures(page); state.dropPublish = 1; await open(page);
  await page.getByLabel("Message to subscribers").fill("First draft");
  await page.getByRole("button", { name: "Publish to subscribers", exact: true }).click();
  await expect(page.getByRole("button", { name: "Retry publication" })).toBeVisible();
  await page.getByLabel("Publication audience").selectOption("server");
  await page.getByLabel("Message to subscribers").fill("Server feed update");
  await page.getByRole("button", { name: "Publish to subscribers", exact: true }).click();
  await expect(page.getByRole("status", { name: "Publication receipt" })).toContainText("1 recipient queued");
  expect(state.bodies[1].body.client_message_id).not.toBe(state.bodies[0].body.client_message_id);
  expect(state.bodies[1].body.topic).toBe(SERVER);
});

test("creating a group never enrolls agents and preserves a shareable group link", async ({ page }) => {
  const state = await fixtures(page); await open(page);
  await page.getByRole("button", { name: "New group", exact: true }).click();
  await page.getByLabel("Group slug", { exact: true }).fill("incident-review");
  await page.getByLabel("Group title", { exact: true }).fill("Incident review");
  await page.getByRole("button", { name: "Create group", exact: true }).click();
  await expect(page).toHaveURL(/group=incident-review/);
  await expect(page.getByRole("region", { name: "Group subscribers" })).toContainText("No subscribers yet");
  expect(state.bodies).toEqual([{ path: "/admin/agent-messaging/groups", body: { slug: "incident-review", title: "Incident review" } }]);
});

test("read grants gate writes while subscriptions remain visible", async ({ page }) => {
  const readState = await fixtures(page, false); await open(page);
  await expect(page.getByRole("button", { name: "New group", exact: true })).toHaveCount(0);
  await expect(page.getByLabel("Message to subscribers")).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Message one agent in Active Clients" })).toHaveCount(0);
  expect(readState.bodies).toEqual([]);
});

test("disabled messaging retains group inspection and the unsent draft", async ({ page }) => {
  const state = await fixtures(page); state.enabled = false; await open(page);
  await page.getByLabel("Message to subscribers").fill("Keep this until messaging is enabled");
  await expect(page.getByRole("button", { name: "Publish to subscribers", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "New group", exact: true })).toBeDisabled();
  expect(state.bodies).toEqual([]);
});

test("direction receipts include every engine and Server while groups keep focus", async ({ page }) => {
  await fixtures(page);
  await page.route("**/admin/agent-messaging/state", (route) => route.fulfill({ json: {
    enabled: true, addresses: 3, live_addresses: 3, relays: 1, open_conversations: 0,
    messages: { queued: 0, leased: 0, accepted: 0, dead: 0, ambiguous: 0 },
    directions: ["codex", "claude", "grok"].flatMap(source_engine => ["codex", "claude", "grok"].map(target_engine => ({ source_engine, target_engine, total: 2, completed: 1, pending: 1, dead: 0, ambiguous: 0 }))),
    server_directions: ["codex", "claude", "grok"].flatMap(engine => [{ source_engine: "server", target_engine: engine, total: 2, completed: 2, pending: 0, dead: 0, ambiguous: 0 }, { source_engine: engine, target_engine: "server", total: 3, completed: 3, pending: 0, dead: 0, ambiguous: 0 }]),
  } }));
  await open(page);
  await expect(page.getByText("server → codex", { exact: true })).not.toBeVisible();
  await page.locator("summary").filter({ hasText: "Direction matrix" }).click();
  for (const engine of ["codex", "claude", "grok"]) {
    await expect(page.getByText(`server → ${engine}`, { exact: true })).toBeVisible();
    await expect(page.getByText(`${engine} → server`, { exact: true })).toBeVisible();
    for (const target of ["codex", "claude", "grok"]) await expect(page.getByText(`${engine} → ${target}`, { exact: true })).toBeVisible();
  }
});

test("a failed audience refresh blocks publication and keeps the draft until recovery", async ({ page }) => {
  const state = await fixtures(page); await open(page);
  await page.getByLabel("Message to subscribers").fill("Retain this scoped draft");
  state.failGroups = true;
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(page.getByRole("button", { name: "Retry groups", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Publish to subscribers", exact: true })).toBeDisabled();
  await expect(page.getByLabel("Message to subscribers")).toHaveValue("Retain this scoped draft");
  state.failGroups = false;
  await page.getByRole("button", { name: "Retry groups", exact: true }).click();
  await expect(page.getByRole("button", { name: "Publish to subscribers", exact: true })).toBeEnabled();
  expect(state.bodies).toEqual([]);
});

test("publication limits count UTF-8 bytes and accept the documented boundary", async ({ page }) => {
  const state = await fixtures(page); await open(page);
  await page.getByLabel("Message to subscribers").fill("💬".repeat(7681));
  await expect(page.getByText("Message exceeds the publication limit.", { exact: false })).toBeVisible();
  await expect(page.getByRole("button", { name: "Publish to subscribers", exact: true })).toBeDisabled();
  expect(state.bodies).toEqual([]);
  await page.getByLabel("Message to subscribers").fill("💬".repeat(7680));
  await expect(page.getByRole("button", { name: "Publish to subscribers", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "Publish to subscribers", exact: true }).click();
  await expect(page.getByRole("status", { name: "Publication receipt" })).toBeVisible();
  expect(Buffer.byteLength(String(state.bodies[0].body.content), "utf8")).toBe(30 * 1024);
});

test('ordinary missing transcripts require one explicit approval, while wakes and read-only users cannot approve',async({page})=>{
  const state=await fixtures(page),now=new Date().toISOString();
  const message={id:CODEX,conversation_id:CLAUDE,sequence:1,kind:'request',work_kind:'request',status:'dead',execution_version:1,task_result_status:null,last_error_code:'native_transcript_missing',content_bytes:5,attempts:1,created_at:now,sender:peer(CLAUDE,'claude'),target:peer(GROK,'grok')};
  state.messages=[message,{...message,id:GROK,kind:'schedule',work_kind:'schedule'}];
  await page.goto('/admin/agent-messaging?view=deliveries');
  await expect(page.getByRole('button',{name:'Approve one fresh start'})).toHaveCount(1);
  page.once('dialog',dialog=>dialog.accept('Operator requests replacement for this work'));
  await page.getByRole('button',{name:'Approve one fresh start'}).click();
  await expect(page.getByRole('button',{name:'Approve one fresh start'})).toHaveCount(0);
  expect(state.bodies.at(-1)?.body).toEqual({version:1,reason:'Operator requests replacement for this work'});
  await page.setViewportSize({width:390,height:844});
  const readOnly=await fixtures(page,false);readOnly.messages=[message];
  await page.goto('/admin/agent-messaging?view=deliveries');
  await expect(page.getByRole('button',{name:'Approve one fresh start'})).toHaveCount(0);
  await expect(page.getByText('Task: unknown · agent report')).toBeVisible();
});
