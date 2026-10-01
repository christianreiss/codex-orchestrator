import { expect, test, type Page } from "@playwright/test";

const reset = "2026-10-01T12:00:00Z";
function account(id: number, engine: "claude" | "codex", label: string, percent: number) {
  return { id, engine, label, state: "enabled", verification_state: "verified", verification_reason: null, verification_checked_at: reset, generation: 1,
    usage: { fetched_at: reset, stale: false, short_used_percent: percent, short_resets_at: reset, weekly_used_percent: percent, weekly_resets_at: reset }, sessions: [] };
}
async function fixtures(page: Page, canManage = true) {
  const accounts = [account(1, "claude", "Claude Alpha", 20), account(2, "claude", "Claude Beta", 80), account(3, "claude", "Claude Gamma", 20)];
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

test("manages a Claude-only pool and shows each quota separately", async ({ page }) => {
  const writes = await fixtures(page);
  await page.goto("/admin/accounts");
  await expect(page.getByRole("heading", { name: "No ChatGPT accounts" })).toBeVisible();
  await page.getByRole("button", { name: "Claude", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Claude Alpha" })).toBeVisible();
  await expect(page.getByText("80%", { exact: true })).toHaveCount(2);
  const first = page.locator("section").filter({ hasText: "Account #1" });
  await first.getByRole("button", { name: "Pause", exact: true }).click();
  await expect(first.getByRole("button", { name: "Resume", exact: true })).toBeVisible();
  await first.getByRole("button", { name: "Resume", exact: true }).click();
  await first.getByRole("button", { name: "Rename" }).click();
  await first.getByRole("textbox", { name: "Account name" }).fill("Claude Primary");
  await first.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Claude Primary" })).toBeVisible();
  await page.locator("section").filter({ has: page.getByRole("heading", { name: "Claude Primary" }) }).getByRole("button", { name: "Verify", exact: true }).click();
  await page.getByRole("button", { name: "Add account", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("textbox", { name: "Account name" }).fill("Claude Fourth");
  await dialog.locator("textarea").fill('{"claudeAiOauth":{"accessToken":"test"}}');
  await dialog.getByRole("button", { name: "Upload credentials" }).click();
  await expect(page.getByRole("heading", { name: "Claude Fourth" })).toBeVisible();
  const fourth = page.locator("section").filter({ has: page.getByRole("heading", { name: "Claude Fourth" }) });
  await fourth.getByRole("button", { name: "Replace credentials" }).click();
  await page.getByRole("dialog").locator("textarea").fill('{"claudeAiOauth":{"accessToken":"replacement"}}');
  await page.getByRole("dialog").getByRole("button", { name: "Upload credentials" }).click();
  page.once("dialog", (dialog) => dialog.accept());
  await fourth.getByRole("button", { name: "Remove", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Claude Fourth" })).toHaveCount(0);
  expect(writes.map((w) => `${w.method} ${w.path}`)).toEqual(["PATCH /admin/accounts/1", "PATCH /admin/accounts/1", "PATCH /admin/accounts/1", "POST /admin/accounts/1/verify", "POST /admin/accounts", "POST /admin/accounts/4/credentials", "DELETE /admin/accounts/4"]);
});

test("read-only operators can inspect quotas without management actions", async ({ page }) => {
  const writes = await fixtures(page, false);
  await page.goto("/admin/accounts");
  await page.getByRole("button", { name: "Claude", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Claude Alpha" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Add account" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Replace credentials" })).toHaveCount(0);
  expect(writes).toEqual([]);
});
