import { ownerStream } from "./owner-stream";
import { expect, test, type Page } from "@playwright/test";

type Engine = "codex" | "claude" | "grok";
type Config = { status: "ok" | "missing"; revision: string | null; sha256?: string; settings: Record<string, unknown>; content?: string; validation_error?: { code: "validation_failed"; message: string; param?: string } };
const LABEL: Record<Engine, string> = { codex: "Codex", claude: "Claude", grok: "Grok" };
/** /engines shows one engine per tab; the tab lives in the URL and survives a reload. */
async function selectEngine(page: Page, engine: Engine) {
  const tab = page.getByRole("tab", { name: LABEL[engine] });
  await expect(tab).toBeVisible();
  if ((await tab.getAttribute("aria-selected")) !== "true") await tab.click();
  await expect(tab).toHaveAttribute("aria-selected", "true");
}
/**
 * Native config, profiles and client settings sit in a collapsed Advanced block per engine.
 * Opens each listed engine's block and leaves the first one's tab selected.
 */
async function openAdvanced(page: Page, engines: Engine[] = ["codex"]) {
  for (const engine of [...engines.slice(1), engines[0]!]) {
    await selectEngine(page, engine);
    const trigger = page.locator(`#${engine}-advanced`);
    await expect(trigger).toBeVisible();
    if ((await trigger.getAttribute("aria-expanded")) !== "true") await trigger.click();
  }
}
function state() {
  const configs = Object.fromEntries((["codex", "claude", "grok"] as Engine[]).map(engine => [engine, {
    status: "ok", revision: "1", sha256: "a".repeat(64), settings: {
      model: `${engine}-current`, native_settings: { language: "en" },
      ...(engine === "claude" ? { effortLevel: "high", statusLine: { type: "command", command: "old", padding: 2 }, hooks: { Stop: [{ hooks: [{ type: "http", url: "https://example.test/hook" }] }] } } : {}),
    },
  }])) as Record<Engine, Config>;
  return { configs, writes: [] as { engine: Engine; body: Record<string, unknown> }[], renders: [] as Engine[], fail: "", race: false };
}
async function fixture(page: Page, shared: ReturnType<typeof state>, manage = true) {
  let emit: ((data: string) => void) | undefined;
  await page.routeWebSocket("**/native-settings-ws", ws => { ownerStream(ws); emit = data => ws.send(data); });
  await page.route("**/admin/**", async route => {
    const req = route.request();
    if (!req.headers().accept?.includes("application/json")) return route.continue();
    const path = new URL(req.url()).pathname;
    const json = (body: unknown, status = 200) => route.fulfill({ status, json: body });
    if (path === "/admin/auth/status") return json({ authenticated: true, enforced: true, user: { id: 1, username: "owner", roles: [manage ? "owner" : "viewer"] }, capabilities: ["admin.read", "settings.read", "content.read", ...(manage ? ["content.manage", "settings.manage"] : [])] });
    if (path === "/admin/setup/status") return json({ setup_complete: true, critical_complete: true, checks: [], next_actions: [], wizard: { completed_at: "2026-10-12T10:00:00Z" } });
    if (path === "/admin/ws/info") return json({ enabled: true, url: new URL("/native-settings-ws", req.url()).href.replace(/^http/, "ws") });
    if (path === "/admin/chatty/status") return json({ visible: false, engines: [] });
    if (path.startsWith("/admin/model-defaults/")) return json({ model: "current", reasoning_effort: null, catalog: [] });
    const match = path.match(/^\/admin\/(?:(claude|grok)\/)?config(?:\/(render|store))?$/);
    if (match) {
      const engine = (match[1] ?? "codex") as Engine;
      const current = shared.configs[engine];
      if (!match[2]) return json(current);
      const body = req.postDataJSON();
      if (match[2] === "render") {
        shared.renders.push(engine);
        if ((body.settings.native_settings ?? {}).unknown_saved_option !== undefined) return json({ status: "error", message: "native_settings.unknown_saved_option is unsupported" }, 422);
        if (shared.fail === engine) return json({ status: "error", message: "native_settings.removed_option is deprecated" }, 422);
        if (shared.race) { shared.race = false; current.revision = "99"; }
        return json({ settings: body.settings, content: `${engine} validated configuration`, sha256: "b".repeat(64), profiles: (body.settings.profiles ?? []).map((p: { name: string }) => ({ name: p.name, content: `profile ${p.name}`, sha256: "c".repeat(64) })) });
      }
      if (body.expected_revision !== current.revision) return json({ status: "error", message: "Configuration changed; reload before saving" }, 409);
      shared.writes.push({ engine, body });
      shared.configs[engine] = { status: "ok", revision: String(Number(current.revision ?? 0) + 1), sha256: "b".repeat(64), settings: body.settings, content: `${engine} saved configuration` };
      return json({ ...shared.configs[engine], change: "updated" });
    }
    return json({});
  });
  return async () => {
    await expect.poll(() => Boolean(emit)).toBe(true);
    emit!(JSON.stringify({ type: "settings.changed", payload: {}, ts: new Date().toISOString() }));
  };
}

test("Codex compaction defaults off and saves the toggle without losing concurrent tuning or profiles", async ({ page }) => {
  const shared = state(); await fixture(page, shared); await page.goto("/admin/engines"); await openAdvanced(page);
  const toggle = page.getByRole("switch", { name: "Async compaction", exact: true });
  await expect(toggle).not.toBeChecked(); await expect(toggle).toBeEnabled();
  shared.configs.codex.settings.model = "newer-model";
  shared.configs.codex.settings.profiles = [{ name: "off", native_settings: { features: { async_compaction: false } } }];
  shared.configs.codex.settings.native_settings = { language: "en", features: { hooks: false, async_compaction: { enabled: false, model_async_compact_threshold_percent: 73 } } };
  shared.configs.codex.revision = "3";
  await toggle.click();
  await expect.poll(() => shared.writes.at(-1)?.body).toMatchObject({ expected_revision: "3", settings: {
    model: "newer-model", native_settings: { features: { hooks: false, async_compaction: { enabled: true, model_async_compact_threshold_percent: 73 } } },
    profiles: [{ name: "off", native_settings: { features: { async_compaction: false } } }],
  } });
  await expect(toggle).toBeChecked();
  await expect(page.locator("#codex-native-settings textarea")).toHaveValue(/"enabled": true/);
  await page.reload(); await openAdvanced(page); await expect(toggle).toBeChecked();
  await toggle.click(); await expect(toggle).not.toBeChecked();
  await expect.poll(() => shared.configs.codex.settings.native_settings).toMatchObject({ features: { async_compaction: { enabled: false, model_async_compact_threshold_percent: 73 } } });
});

test("Codex compaction retains its state after validation and revision failures", async ({ page }) => {
  const shared = state(); await fixture(page, shared); await page.goto("/admin/engines"); await openAdvanced(page);
  const row = page.locator("#codex-async-compaction"), toggle = row.getByRole("switch");
  await expect(toggle).toBeEnabled();
  shared.fail = "codex"; await toggle.click();
  await expect(row).toContainText("removed_option is deprecated"); await expect(toggle).not.toBeChecked();
  expect(shared.writes).toEqual([]);
  shared.fail = ""; shared.race = true; await toggle.click();
  await expect(row).toContainText("Configuration changed; reload before saving"); await expect(toggle).not.toBeChecked();
  expect(shared.writes).toEqual([]);
});

test("Codex compaction is read-only without content.manage", async ({ page }) => {
  const shared = state(); await fixture(page, shared, false); await page.goto("/admin/engines"); await openAdvanced(page);
  const toggle = page.getByRole("switch", { name: "Async compaction", exact: true });
  await expect(toggle).not.toBeChecked(); await expect(toggle).toBeDisabled(); expect(shared.writes).toEqual([]);
});

test("the command palette finds Async compaction and opens its collapsed section, from another tab too", async ({ page }) => {
  const shared = state(); await fixture(page, shared); await page.goto("/admin/engines?engine=claude");
  await selectEngine(page, "claude");
  for (const term of ["compaction", "kompakt"]) {
    await page.keyboard.press("ControlOrMeta+k");
    await page.getByRole("combobox", { name: "Search fleet and commands" }).fill(term);
    await page.getByLabel("Navigation", { exact: true }).getByRole("option", { name: /Codex async compaction/ }).click();
    await expect(page).toHaveURL(/\/engines\?engine=codex#codex-async-compaction$/);
    await expect(page.getByRole("tab", { name: "Codex" })).toHaveAttribute("aria-selected", "true");
    await expect(page.locator("#codex-advanced")).toHaveAttribute("aria-expanded", "true");
    await expect(page.getByRole("switch", { name: "Async compaction", exact: true })).toBeInViewport();
    // Leave the section so the second term starts from a different tab again.
    await selectEngine(page, "claude");
  }
});

test("native JSON validates, previews and saves each engine without losing separate settings", async ({ page }) => {
  const shared = state(); await fixture(page, shared); await page.goto("/admin/engines"); await openAdvanced(page, ["codex", "claude", "grok"]);
  for (const engine of ["codex", "claude", "grok"] as Engine[]) {
    await selectEngine(page, engine);
    const card = page.locator(`#${engine}-native-settings`), editor = card.getByRole("textbox");
    await expect(editor).toHaveValue(/"language": "en"/);
    await editor.fill("[]"); await expect(card).toContainText("must be a JSON object"); await expect(card.getByRole("button", { name: "Save native settings" })).toBeDisabled();
    await editor.fill('{"language":"de"}');
    await card.getByRole("button", { name: "Validate and preview" }).click(); await expect(card).toContainText(`${engine} validated configuration`);
    shared.configs[engine].settings.model = `${engine}-newer`;
    shared.configs[engine].revision = "2";
    await card.getByRole("button", { name: "Save native settings" }).click();
    await expect.poll(() => shared.writes.at(-1)).toMatchObject({ engine, body: { settings: { native_settings: { language: "de" } } } });
    await expect(card.getByRole("button", { name: "Save native settings" })).toBeDisabled();
    expect(shared.writes.at(-1)?.body.expected_revision).toBe("2");
    expect(shared.configs[engine].settings).toMatchObject({ model: `${engine}-newer`, native_settings: { language: "de" } });
    await editor.fill("{}"); await card.getByRole("button", { name: "Save native settings" }).click();
    await expect.poll(() => shared.configs[engine].settings.native_settings).toEqual({});
  }
  await page.reload(); await openAdvanced(page, ["codex"]); await expect(page.locator("#codex-native-settings textarea")).toHaveValue("{}");
});

test("Claude nested namespaces stay opt-in and can be previewed, changed and removed", async ({ page }) => {
  const shared = state(); await fixture(page, shared); await page.goto("/admin/engines"); await openAdvanced(page, ["claude"]);
  const card = page.locator("#claude-native-settings"), editor = card.getByRole("textbox");
  await expect(card).toContainText("It defaults to false");
  await expect(card).toContainText("escape the sandbox");
  await expect(card).toContainText("Desktop-only sshHostCommands");
  await expect(card.getByRole("link", { name: "Claude 2.1.312 settings" })).toBeVisible();
  expect(shared.configs.claude.settings.native_settings).not.toHaveProperty("sandbox");
  for (const allowNestedUserNamespaces of [false, true]) {
    const native = { sandbox: { enabled: true, allowNestedUserNamespaces }, env: { LOCAL_SIBLING: "kept" } };
    await editor.fill(JSON.stringify(native));
    await card.getByRole("button", { name: "Validate and preview" }).click();
    await expect(card).toContainText("claude validated configuration");
    await card.getByRole("button", { name: "Save native settings" }).click();
    await expect.poll(() => shared.configs.claude.settings.native_settings).toEqual(native);
    await expect(card.getByRole("button", { name: "Save native settings" })).toBeDisabled();
  }
  await editor.fill(JSON.stringify({ sandbox: { enabled: true }, env: { LOCAL_SIBLING: "kept" } }));
  await card.getByRole("button", { name: "Save native settings" }).click();
  await expect.poll(() => shared.configs.claude.settings.native_settings).toEqual({ sandbox: { enabled: true }, env: { LOCAL_SIBLING: "kept" } });
  await page.reload(); await openAdvanced(page, ["claude"]);
  await expect(editor).not.toHaveValue(/allowNestedUserNamespaces/);
});

test("dirty drafts survive remote changes, validation failure and a store revision race", async ({ page }) => {
  const shared = state(); const refresh = await fixture(page, shared); await page.goto("/admin/engines"); await openAdvanced(page);
  const card = page.locator("#codex-native-settings"), editor = card.getByRole("textbox");
  await expect(editor).toHaveValue(/"en"/); await editor.fill('{"language":"de"}');
  shared.fail = "codex"; await card.getByRole("button", { name: "Save native settings" }).click();
  await expect(card).toContainText("removed_option is deprecated"); expect(shared.writes).toEqual([]); await expect(editor).toHaveValue('{"language":"de"}');
  shared.fail = ""; shared.race = true; await card.getByRole("button", { name: "Save native settings" }).click();
  await expect(card).toContainText("Configuration changed; reload before saving"); expect(shared.writes).toEqual([]);
  shared.configs.codex.settings.native_settings = { language: "fr" }; await refresh();
  await expect(card).toContainText("Native settings changed elsewhere"); await expect(editor).toHaveValue('{"language":"de"}');
  await expect(card.getByRole("button", { name: "Save native settings" })).toBeDisabled();
  await card.getByRole("button", { name: "Discard draft and reload" }).click(); await expect(editor).toHaveValue(/"fr"/);
});

test("missing config creation sends an explicit null revision", async ({ page }) => {
  const shared = state(); shared.configs.grok = { status: "missing", revision: null, settings: {} };
  await fixture(page, shared); await page.goto("/admin/engines"); await openAdvanced(page, ["grok"]);
  const card = page.locator("#grok-native-settings");
  await expect(card).toContainText("No fleet configuration saved yet"); await card.getByRole("textbox").fill('{"ui":{"timestamps":true}}');
  await card.getByRole("button", { name: "Save native settings" }).click();
  await expect.poll(() => shared.writes.length).toBe(1); expect(shared.writes[0].body.expected_revision).toBeNull();
});

test("Claude form preserves richer hooks and native settings while saving a changed field", async ({ page }) => {
  const shared = state(); await fixture(page, shared); await page.goto("/admin/engines"); await openAdvanced(page, ["claude"]);
  const form = page.locator("#claude-client");
  await expect(form).toContainText("These hooks contain additional types or options");
  await form.getByLabel("Command", { exact: true }).fill("new-status");
  shared.configs.claude.settings.model = "newer-model";
  shared.configs.claude.settings.native_settings = { language: "fr" };
  shared.configs.claude.revision = "3";
  await form.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect.poll(() => shared.writes.length).toBe(1);
  expect(shared.configs.claude.settings).toMatchObject({ model: "newer-model", native_settings: { language: "fr" }, statusLine: { command: "new-status", padding: 2 }, hooks: { Stop: [{ hooks: [{ type: "http", url: "https://example.test/hook" }] }] } });
  expect(shared.writes[0].body.expected_revision).toBe("3");
});

test("read-only operators can view native settings but cannot edit or save", async ({ page }) => {
  const shared = state(); await fixture(page, shared, false); await page.goto("/admin/engines"); await openAdvanced(page, ["codex", "claude", "grok"]);
  for (const engine of ["codex", "claude", "grok"] as Engine[]) {
    await selectEngine(page, engine);
    const card = page.locator(`#${engine}-native-settings`);
    await expect(card.getByRole("textbox")).toHaveAttribute("readonly", "");
    await expect(card.getByRole("button", { name: "Save native settings" })).toBeDisabled();
  }
  await selectEngine(page, "claude");
  await expect(page.locator("#claude-client").getByRole("button", { name: "Save changes", exact: true })).toBeDisabled();
  expect(shared.writes).toEqual([]);
});


test("Codex profiles create, preview and remove sidecars separately from root settings", async ({ page }) => {
  const shared = state(); await fixture(page, shared); await page.goto("/admin/engines"); await openAdvanced(page);
  const card = page.locator("#codex-profile-settings"), editor = card.getByRole("textbox");
  await expect(editor).toHaveValue("[]");
  await editor.fill('[{"name":"review","model":"gpt-6.1-sol","model_reasoning_effort":"high","native_settings":{"service_tier":"priority"}}]');
  await card.getByRole("button", { name: "Validate and preview" }).click();
  await expect(card).toContainText("review.config.toml");
  await card.getByRole("button", { name: "Save profiles", exact: true }).click();
  await expect.poll(() => shared.configs.codex.settings.profiles).toMatchObject([{ name: "review", model: "gpt-6.1-sol", native_settings: { service_tier: "priority" } }]);
  expect(shared.configs.codex.settings.native_settings).toEqual({ language: "en" });
  await editor.fill("[]");
  await card.getByRole("button", { name: "Save profiles", exact: true }).click();
  await expect.poll(() => shared.configs.codex.settings.profiles).toEqual([]);
});

test("Grok 1.0.70 native defaults preserve false values, argument arrays and removal", async ({ page }) => {
  const shared = state(); shared.configs.grok.settings.native_settings = {};
  await fixture(page, shared); await page.goto("/admin/engines"); await openAdvanced(page, ["grok"]);
  const card = page.locator("#grok-native-settings"), editor = card.getByRole("textbox");
  await expect(card.getByRole("link", { name: "Grok 1.0.70 settings" })).toBeVisible();
  const value = { keys: { vim: "off" }, features: { worktree_inherits_main_approvals: false }, hooks: { Stop: [{ hooks: [{ type: "command", command: "echo", args: ["login", "--background"] }] }] }, ui: { notifications: { program_status: { children: false } } } };
  await editor.fill(JSON.stringify(value));
  await card.getByRole("button", { name: "Validate and preview" }).click();
  await expect(card).toContainText("grok validated configuration");
  await card.getByRole("button", { name: "Save native settings" }).click();
  await expect.poll(() => shared.configs.grok.settings.native_settings).toEqual(value);
  await page.reload(); await openAdvanced(page, ["grok"]);
  await expect(editor).toHaveValue(/"children": false/);
  await editor.fill("{}"); await card.getByRole("button", { name: "Save native settings" }).click();
  await expect.poll(() => shared.configs.grok.settings.native_settings).toEqual({});
});

for (const engine of ["codex", "claude", "grok"] as Engine[]) test(`${engine} invalid saved native settings remain editable and recover without dropping values`, async ({ page }) => {
  const shared = state();
  const native = { unknown_saved_option: "preserve this authored value" };
  shared.configs[engine].settings.native_settings = native;
  shared.configs[engine].validation_error = { code: "validation_failed", message: "native_settings.unknown_saved_option is unsupported", param: "native_settings.unknown_saved_option" };
  await fixture(page, shared); await page.goto(`/admin/engines?engine=${engine}`); await selectEngine(page, engine);
  await expect(page.getByText("Saved configuration needs correction.", { exact: false })).toBeVisible();
  await page.getByRole("button", { name: "Review native settings" }).click();
  const card = page.locator(`#${engine}-native-settings`), editor = card.getByRole("textbox");
  await expect(editor).toHaveValue(JSON.stringify(native, null, 2));
  await expect(card).toContainText("Saved configuration is invalid");
  await card.getByRole("button", { name: "Validate and preview" }).click();
  await expect(card.getByRole("alert")).toContainText("unknown_saved_option is unsupported");
  await expect(editor).toHaveValue(JSON.stringify(native, null, 2));
  expect(shared.writes).toEqual([]);
  await editor.fill("{}");
  await card.getByRole("button", { name: "Save native settings" }).click();
  await expect.poll(() => shared.writes.at(-1)?.body).toMatchObject({ expected_revision: "1", sha256: "a".repeat(64), settings: { native_settings: {}, model: `${engine}-current` } });
  await expect(card).not.toContainText("Saved configuration is invalid");
  await expect(page.getByRole("button", { name: "Review native settings" })).toHaveCount(0);
  await page.reload(); await openAdvanced(page, [engine]); await expect(editor).toHaveValue("{}");
});

test("malformed saved native JSON remains visible without becoming an edited draft", async ({ page }) => {
  const shared = state(); shared.configs.codex.settings.native_settings = [];
  shared.configs.codex.validation_error = { code: "validation_failed", message: "native_settings must be an object", param: "native_settings" };
  await fixture(page, shared); await page.goto("/admin/engines");
  await page.getByRole("button", { name: "Review native settings" }).click();
  const card = page.locator("#codex-native-settings"), editor = card.getByRole("textbox");
  await expect(editor).toHaveValue("[]");
  await expect(card.getByRole("button", { name: "Reload native settings" })).toBeVisible();
  await expect(card.getByRole("button", { name: "Validate and preview" })).toBeDisabled();
  await editor.fill("{}"); await card.getByRole("button", { name: "Save native settings" }).click();
  await expect.poll(() => shared.writes).toHaveLength(1);
  await expect(card).not.toContainText("Saved configuration is invalid");
  await expect(card.getByRole("button", { name: "Save native settings" })).toBeDisabled();
  await expect(editor).toHaveValue("{}");
});
