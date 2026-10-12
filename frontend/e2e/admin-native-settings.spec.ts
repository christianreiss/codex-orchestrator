import { expect, test, type Page } from "@playwright/test";

type Engine = "codex" | "claude" | "grok";
type Config = { status: "ok" | "missing"; revision: string | null; sha256?: string; settings: Record<string, unknown>; content?: string };
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
  await page.routeWebSocket("**/native-settings-ws", ws => { emit = data => ws.send(data); });
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
        if (shared.fail === engine) return json({ status: "error", message: "native_settings.removed_option is deprecated" }, 422);
        if (shared.race) { shared.race = false; current.revision = "99"; }
        return json({ settings: body.settings, content: `${engine} validated configuration`, sha256: "b".repeat(64) });
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

test("native JSON validates, previews and saves each engine without losing separate settings", async ({ page }) => {
  const shared = state(); await fixture(page, shared); await page.goto("/admin/engines");
  for (const engine of ["codex", "claude", "grok"] as Engine[]) {
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
  await page.reload(); await expect(page.locator("#codex-native-settings textarea")).toHaveValue("{}");
});

test("dirty drafts survive remote changes, validation failure and a store revision race", async ({ page }) => {
  const shared = state(); const refresh = await fixture(page, shared); await page.goto("/admin/engines");
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
  await fixture(page, shared); await page.goto("/admin/engines");
  const card = page.locator("#grok-native-settings");
  await expect(card).toContainText("No fleet configuration saved yet"); await card.getByRole("textbox").fill('{"ui":{"timestamps":true}}');
  await card.getByRole("button", { name: "Save native settings" }).click();
  await expect.poll(() => shared.writes.length).toBe(1); expect(shared.writes[0].body.expected_revision).toBeNull();
});

test("Claude form preserves richer hooks and native settings while saving a changed field", async ({ page }) => {
  const shared = state(); await fixture(page, shared); await page.goto("/admin/engines");
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
  const shared = state(); await fixture(page, shared, false); await page.goto("/admin/engines");
  for (const engine of ["codex", "claude", "grok"]) {
    const card = page.locator(`#${engine}-native-settings`);
    await expect(card.getByRole("textbox")).toHaveAttribute("readonly", "");
    await expect(card.getByRole("button", { name: "Save native settings" })).toBeDisabled();
  }
  await expect(page.locator("#claude-client").getByRole("button", { name: "Save changes", exact: true })).toBeDisabled();
  expect(shared.writes).toEqual([]);
});
