import { expect, test, type Page } from "@playwright/test";

const reset = "2026-10-01T12:00:00Z";
function account(id: number, engine: "claude" | "codex" | "grok", label: string, percent: number | null) {
  return { id, engine, label, state: "enabled", verification_state: "verified", verification_reason: null, verification_checked_at: reset, generation: 1, refresh_state: "idle",
    usage: { supported: true, fetched_at: engine === "grok" ? null : reset, checked_at: reset, stale: engine === "grok", current_window: null, short_used_percent: percent, short_resets_at: engine === "grok" ? null : reset, weekly_used_percent: percent, weekly_resets_at: engine === "grok" ? null : reset }, sessions: [] };
}
async function fixtures(page: Page, canManage = true, extra: ReturnType<typeof account>[] = []) {
  const accounts = [account(1, "claude", "Claude Alpha", 20), account(2, "claude", "Claude Beta", 80), account(3, "claude", "Claude Gamma", 20), ...extra];
  const writes: Array<{ method: string; path: string; body: unknown }> = [];
  await page.route("**/admin/**", async (route) => {
    const request = route.request();
    if (!["fetch", "xhr"].includes(request.resourceType())) { await route.continue(); return; }
    const path = new URL(request.url()).pathname;
    const method = request.method();
    let body: unknown = {};
    if (path === "/admin/auth/status") body = { authenticated: true, enforced: true, user: { id: 1, name: "Operator", username: "operator", access_level: "owner" }, roles: ["owner"], capabilities: canManage ? ["auth.manage", "auth.metadata.read"] : ["auth.metadata.read"] };
    else if (path === "/admin/setup/status") body = { setup_complete: true, next_actions: [], checks: [], critical_complete: true, wizard: { completed_at: reset } };
    else if (path === "/admin/ws/info") body = { enabled: false };
    else if (path === "/admin/accounts" && method === "GET") body = { accounts };
    else if (path.startsWith("/admin/accounts") && method !== "GET") {
      const payload = request.postData() ? request.postDataJSON() : {};
      writes.push({ method, path, body: payload });
      const id = Number(path.split("/")[3]);
      const target = accounts.find((a) => a.id === id);
      if (method === "PATCH" && target) Object.assign(target, payload);
      if (method === "DELETE") accounts.splice(accounts.findIndex((a) => a.id === id), 1);
      if (method === "POST" && path === "/admin/accounts") accounts.push(account(4, payload.engine, payload.label, 0));
      body = { status: "ok", verification_state: "verified", account_id: id || 4 };
    }
    await route.fulfill({ json: { status: "ok", data: body } });
  });
  return writes;
}

const rowOf = (page: Page, name: string | RegExp) => page.getByRole("row", { name });
async function choose(page: Page, row: ReturnType<typeof rowOf>, label: string, item: string) {
  await row.getByRole("button", { name: `Actions for ${label}` }).click();
  await page.getByRole("menuitem", { name: item, exact: true }).click();
}

test("manages a Claude-only pool and shows each quota separately", async ({ page }) => {
  const writes = await fixtures(page);
  await page.goto("/admin/accounts");
  await expect(rowOf(page, /Claude Alpha/)).toBeVisible();
  await expect(rowOf(page, /Claude Beta/)).toBeVisible();
  await expect(rowOf(page, /Claude Gamma/)).toBeVisible();
  await expect(page.getByText("80%", { exact: true })).toHaveCount(2);
  await choose(page, rowOf(page, /Claude Alpha/), "Claude Alpha", "Pause");
  await expect(rowOf(page, /Claude Alpha/)).toContainText("Paused");
  await choose(page, rowOf(page, /Claude Alpha/), "Claude Alpha", "Resume");
  await choose(page, rowOf(page, /Claude Alpha/), "Claude Alpha", "Rename");
  await page.getByRole("dialog").getByRole("textbox", { name: "Account name" }).fill("Claude Primary");
  await page.getByRole("dialog").getByRole("button", { name: "Save", exact: true }).click();
  await expect(rowOf(page, /Claude Primary/)).toBeVisible();
  await choose(page, rowOf(page, /Claude Primary/), "Claude Primary", "Verify");
  await page.getByRole("button", { name: "Add account", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("textbox", { name: "Account name" }).fill("Claude Fourth");
  await dialog.getByRole("radio", { name: "Claude", exact: true }).click();
  await dialog.locator("textarea").fill('{"claudeAiOauth":{"accessToken":"test"}}');
  await dialog.getByRole("button", { name: "Upload credentials" }).click();
  await expect(rowOf(page, /Claude Fourth/)).toBeVisible();
  await choose(page, rowOf(page, /Claude Fourth/), "Claude Fourth", "Replace credentials");
  await page.getByRole("dialog").locator("textarea").fill('{"claudeAiOauth":{"accessToken":"replacement"}}');
  await page.getByRole("dialog").getByRole("button", { name: "Upload credentials" }).click();
  await choose(page, rowOf(page, /Claude Fourth/), "Claude Fourth", "Remove");
  await page.getByRole("dialog").getByRole("button", { name: "Remove", exact: true }).click();
  await expect(rowOf(page, /Claude Fourth/)).toHaveCount(0);
  expect(writes.map((w) => `${w.method} ${w.path}`)).toEqual(["PATCH /admin/accounts/1", "PATCH /admin/accounts/1", "PATCH /admin/accounts/1", "POST /admin/accounts/1/verify", "POST /admin/accounts", "POST /admin/accounts/4/credentials", "DELETE /admin/accounts/4"]);
});

test("read-only operators can inspect quotas without management actions", async ({ page }) => {
  const writes = await fixtures(page, false);
  await page.goto("/admin/accounts");
  await expect(rowOf(page, /Claude Alpha/)).toBeVisible();
  await expect(page.getByText("80%", { exact: true })).toHaveCount(2);
  await expect(page.getByRole("button", { name: "Add account" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^Actions for/ })).toHaveCount(0);
  expect(writes).toEqual([]);
});

test("the engine filter is always visible, scopes the list and keeps engine-specific empty states", async ({ page }) => {
  await fixtures(page, false, [account(7, "grok", "Grok Primary", null)]);
  await page.goto("/admin/accounts");
  await expect(rowOf(page, /Claude Alpha/)).toBeVisible();
  await expect(rowOf(page, /Grok Primary/)).toBeVisible();
  await page.getByRole("button", { name: "ChatGPT", exact: true }).click();
  await expect(page.getByText("No ChatGPT accounts", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Claude", exact: true }).click();
  await expect(rowOf(page, /Claude Alpha/)).toBeVisible();
  await expect(rowOf(page, /Grok Primary/)).toHaveCount(0);
  await page.getByRole("button", { name: "Grok", exact: true }).click();
  await expect(rowOf(page, /Grok Primary/)).toBeVisible();
  await expect(rowOf(page, /Claude Alpha/)).toHaveCount(0);
  await page.getByRole("button", { name: "All", exact: true }).click();
  await page.getByRole("textbox", { name: "Search accounts" }).fill("beta");
  await expect(rowOf(page, /Claude Beta/)).toBeVisible();
  await expect(rowOf(page, /Claude Alpha/)).toHaveCount(0);
  await page.getByRole("textbox", { name: "Search accounts" }).fill("zzz");
  await expect(page.getByText("No matches", { exact: true })).toBeVisible();
});

test("accounts that need attention are listed first and counted", async ({ page }) => {
  const broken = { ...account(9, "codex", "ChatGPT Team", 10), refresh_state: "login_required" };
  await fixtures(page, true, [broken]);
  await page.goto("/admin/accounts");
  await expect(page.getByRole("row").nth(1)).toContainText("ChatGPT Team");
  await expect(page.getByRole("row").nth(1)).toContainText("Login needs renewal");
  await expect(page.getByText("need attention")).toBeVisible();
});

test("Grok subscription accounts show unavailable quota and upload full OIDC credentials", async ({ page }) => {
  const grok = { ...account(5, "grok", "Grok Primary", null), refresh_state: "login_required" };
  const writes = await fixtures(page, true, [grok]);
  await page.goto("/admin/accounts");
  const row = rowOf(page, /Grok Primary/);
  await expect(row).toContainText("Usage unavailable");
  await expect(row).toContainText("cgx login");
  await expect(row.getByRole("meter")).toHaveCount(0);
  await choose(page, row, "Grok Primary", "Replace credentials");
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("Subscription login credentials include refresh material");
  await expect(dialog.getByText("OpenAI API key", { exact: true })).toHaveCount(0);
  const payload = JSON.stringify({ "https://auth.x.ai::b1a00492-073a-47ea-816f-4c329264a828": {
    auth_mode: "oidc", key: "fake-access", refresh_token: "fake-refresh", oidc_issuer: "https://auth.x.ai",
    oidc_client_id: "b1a00492-073a-47ea-816f-4c329264a828", expires_at: reset, user_id: "fake-user" } });
  await dialog.locator("textarea").fill(payload);
  await dialog.getByRole("button", { name: "Upload credentials" }).click();
  await expect(dialog).toHaveCount(0);
  expect(writes).toEqual([{ method: "POST", path: "/admin/accounts/5/credentials", body: { payload } }]);
});

for (const mobile of [false, true]) {
  test(`quota overrides preserve failed saves and PayG suppresses controls (${mobile ? "mobile" : "desktop"})`, async ({ page }) => {
    if (mobile) await page.setViewportSize({ width: 390, height: 844 });
    await page.emulateMedia({ colorScheme: mobile ? "dark" : "light" });
    await fixtures(page);
    const defaults = { unlimited: false, short_warn_percent: 85, long_warn_percent: 85, short_auto_resume: true, long_auto_resume: false };
    let override: typeof defaults | null = null, fail = true;
    await page.route("**/admin/accounts/1/quota-policy", async route => {
      if (route.request().method() === "PUT") {
        if (fail) { fail = false; await route.fulfill({ status: 503, json: { status: "error", message: "Policy save unavailable" } }); return; }
        override = route.request().postDataJSON().policy;
      }
      await route.fulfill({ json: { status: "ok", data: { defaults, override, effective: override ?? defaults } } });
    });
    await page.goto("/admin/accounts");
    await choose(page, rowOf(page, /Claude Alpha/), "Claude Alpha", "Quota policy");
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByRole("switch", { name: "Use engine defaults" })).toBeChecked();
    await dialog.getByRole("switch", { name: "Use engine defaults" }).click();
    await dialog.getByRole("switch", { name: "PayG / unlimited" }).click();
    await expect(dialog.getByRole("switch", { name: "Warn agents" }).first()).toBeDisabled();
    await dialog.getByRole("button", { name: "Save quota policy" }).click();
    await expect(dialog.getByRole("alert")).toContainText("Policy save unavailable");
    await expect(dialog.getByRole("switch", { name: "PayG / unlimited" })).toBeChecked();
    await dialog.getByRole("button", { name: "Save quota policy" }).click();
    await expect(dialog.getByRole("status")).toContainText("Quota policy saved");
    expect(override).toMatchObject({ unlimited: true });
    await dialog.getByRole("switch", { name: "Use engine defaults" }).click();
    await dialog.getByRole("button", { name: "Save quota policy" }).click();
    await expect.poll(() => override).toBeNull();
    await expect(dialog.getByRole("switch", { name: "PayG / unlimited" })).not.toBeChecked();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    const { default: AxeBuilder } = await import("@axe-core/playwright");
    const axe = await new AxeBuilder({ page }).include('[role="dialog"]').analyze();
    expect(axe.violations).toEqual([]);
  });
}

for (const engine of ["codex", "claude", "grok"] as const) {
  for (const theme of ["light", "dark"] as const) {
    test(`provider credential layout ${engine} ${theme}`, async ({ page }, testInfo) => {
      await fixtures(page);
      await page.setViewportSize({ width: theme === "dark" ? 320 : 1440, height: 900 });
      await page.addInitScript(value => localStorage.setItem("codex.theme", value), theme);
      await page.route("**/admin/auth/seed-command", async route => {
        const selected = route.request().postDataJSON().engine;
        await route.fulfill({ json: { status: "ok", data: { command: `echo fixture-${selected}`, expires_at: "2026-10-26T12:00:00Z" } } });
      });
      await page.goto("/admin/accounts");
      await page.getByRole("button", { name: "Add account", exact: true }).click();
      const dialog = page.getByRole("dialog");
      const label = engine === "codex" ? "Codex" : engine === "claude" ? "Claude" : "Grok";
      await dialog.getByRole("radio", { name: label, exact: true }).click();
      if (engine === "codex") await dialog.getByText("ChatGPT session", { exact: true }).click();
      await expect(dialog.getByLabel("Or choose a credentials file")).toBeVisible();
      await dialog.getByLabel("Or choose a credentials file").focus();
      await expect(dialog.getByLabel("Or choose a credentials file")).toBeFocused();
      expect(await dialog.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
      const { default: AxeBuilder } = await import("@axe-core/playwright");
      expect((await new AxeBuilder({ page }).include('[role="dialog"]').analyze()).violations).toEqual([]);
      await dialog.evaluate(el => { el.scrollTop = 0; });
      await page.screenshot({ path: testInfo.outputPath(`provider-${engine}-${theme}.png`), fullPage: true });
      await dialog.getByRole("tab", { name: "One-time command" }).click();
      await expect(dialog.getByRole("radiogroup", { name: "Engine", exact: true })).toHaveCount(1);
      await dialog.getByRole("button", { name: "Generate", exact: true }).click();
      await expect(dialog.locator("#seed-cmd-output")).toHaveText(`echo fixture-${engine}`);
      await dialog.getByRole("radio", { name: engine === "grok" ? "Claude" : "Grok", exact: true }).click();
      await expect(dialog.locator("#seed-cmd-output")).toHaveCount(0);
    });
  }
}
