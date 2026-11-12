import { expect, test, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import type { ProviderAccount } from "../src/lib/api/accounts";

const now = new Date().toISOString();
const reset = new Date(Date.now() + 86400_000).toISOString();
function account(id: number, engine: ProviderAccount["engine"], label: string, changes: Partial<ProviderAccount["usage"]> = {}): ProviderAccount {
  return { id, engine, label, state: "enabled", verification_state: "verified", verification_reason: null,
    verification_checked_at: now, generation: 1, sessions: [], usage: {
      supported: true, stale: false, fetched_at: now, short_used_percent: null, short_resets_at: null,
      weekly_used_percent: null, weekly_resets_at: null, ...changes,
    } };
}
function providers() {
  const accounts = [
    account(2, "codex", "ChatGPT", { weekly_used_percent: 15, weekly_limit_seconds: 604800 }),
    account(1, "claude", "Claude", { short_used_percent: 0, short_limit_seconds: 18000, weekly_used_percent: 24, weekly_limit_seconds: 604800, stale: true }),
    account(7, "grok", "Grok account", { current_window: { used_percent: 87, period: "weekly", starts_at: null, resets_at: reset, shared: true } }),
    account(8, "kimi", "Kimi account", { windows: [{ kind: "five_hour", used_percent: 0, resets_at: reset }, { kind: "weekly", used_percent: 12, resets_at: reset }, { kind: "month_total", used_percent: 24, resets_at: reset }, { kind: "month_code", used_percent: 18, resets_at: reset }] }),
  ];
  accounts[0].plan = { name: 'Pro', source: 'chatgpt_usage', observed_at: now, stale: false };
  accounts[1].plan = { name: 'Max 20×', source: 'claude_login', observed_at: now, stale: true };
  accounts[2].plan = { name: 'SuperGrok Heavy', source: 'grok_settings', observed_at: now, stale: false };
  accounts[3].plan = { name: 'Kimi subscription', source: 'kimi_userinfo', observed_at: now, stale: false };
  return accounts;
}
async function fixtures(page: Page, accounts: ProviderAccount[], options: { wait?: Promise<void>; fail?: boolean; off?: boolean } = {}) {
  await page.route("**/admin/**", async route => {
    if (!["fetch", "xhr"].includes(route.request().resourceType())) return route.continue();
    const path = new URL(route.request().url()).pathname;
    let data: unknown = {};
    if (path === "/admin/auth/status") data = { authenticated: true, enforced: true, user: { id: 1, name: "Operator", username: "operator", access_level: "owner" }, roles: ["owner"], capabilities: ["settings.read", "auth.metadata.read"] };
    else if (path === "/admin/setup/status") data = { setup_complete: true, next_actions: [], checks: [], wizard: { completed_at: now } };
    else if (path === "/admin/ws/info") data = { enabled: false };
    else if (path === "/admin/theme") data = { theme: "auto" };
    else if (path === "/admin/overview") data = { totals: { hosts: 3 }, last_refresh: now, versions: {},
      version_distribution: { codex: [], claude: [], grok: [], engine_counts: { codex: 1, claude: 1, grok: 1 }, install: { both: 0, codex_only: 1, claude_only: 1, neither: 1 } } };
    else if (path === "/admin/runner") data = { runner: { configured: false, ready: false, detail: "Not configured" } };
    else if (path === "/admin/engines/state") data = { engines: ["codex", "claude", "grok", "kimi"].map(engine => ({ engine, enabled: !(options.off && engine === "codex") })) };
    else if (path === "/admin/accounts") {
      if (options.wait) await options.wait;
      if (options.fail) return route.fulfill({ status: 503, json: { status: "error", error: { message: "Account service unavailable" } } });
      data = { accounts };
    }
    await route.fulfill({ json: { status: "ok", data } });
  });
}

const USAGE = "Provider accounts and their quota usage";

test("four providers share one usage table in light/dark desktop, tablet and mobile layouts", async ({ page }, info) => {
  test.setTimeout(90_000);
  await fixtures(page, providers());
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  for (const [width, scheme] of [[1440, "light"], [1440, "dark"], [1000, "light"], [390, "light"], [390, "dark"]] as const) {
    await page.setViewportSize({ width, height: 1000 });
    await page.emulateMedia({ colorScheme: scheme });
    await page.goto("/admin/dashboard");
    const table = page.getByRole("table", { name: USAGE });
    const rows = table.locator("tbody tr");
    await expect(rows).toHaveCount(4);
    await expect(rows.nth(0).getByTestId("provider-plan")).toContainText("Pro");
    await expect(rows.nth(1).getByTestId("provider-plan")).toContainText("Max 20×");
    await expect(rows.nth(1).getByTestId("provider-plan")).toContainText("(last known)");
    await expect(rows.nth(2).getByTestId("provider-plan")).toContainText("SuperGrok Heavy");
    await expect(rows.nth(0).getByRole("meter")).toHaveCount(1);
    await expect(rows.nth(0)).not.toContainText("Short window");
    await expect(rows.nth(1).getByRole("meter", { name: "5-hour window" })).toHaveAttribute("aria-valuenow", "0");
    await expect(rows.nth(1)).not.toContainText("Last known reading");
    await expect(rows.nth(2).getByRole("meter", { name: "Weekly usage" })).toHaveAttribute("aria-valuenow", "87");
    await expect(rows.nth(2).getByTestId("reset-in")).toContainText("in 1 day");
    await expect(table.getByRole("columnheader", { name: "Reset in" })).toBeVisible();
    await expect(rows.nth(3).getByRole("meter")).toHaveCount(4);
    await expect(rows.nth(3).getByRole("meter", { name: "5-hour window" })).toHaveAttribute("aria-valuenow", "0");
    await expect(rows.nth(3).getByRole("meter", { name: "Monthly code" })).toHaveAttribute("aria-valuenow", "18");
    // One compact table: every meter has the same height and the page never scrolls sideways.
    const heights = await table.getByRole("meter").evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect().height));
    expect(new Set(heights).size).toBe(1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const findings = await new AxeBuilder({ page }).include("section#usage").analyze();
    expect(findings.violations.filter(v => ["serious", "critical"].includes(v.impact ?? ""))).toEqual([]);
    await page.locator("section#usage").screenshot({ path: info.outputPath(`providers-${width}-${scheme}.png`) });
  }
  expect(errors).toEqual([]);
});

test("ChatGPT renders a supplied five-hour zero reading and retains account navigation", async ({ page }) => {
  const accounts = providers();
  Object.assign(accounts[0].usage, { short_used_percent: 0, short_limit_seconds: 18000, short_resets_at: reset });
  await fixtures(page, accounts);
  await page.goto("/admin/dashboard");
  const row = page.getByRole("row", { name: /ChatGPT/ });
  await expect(row.getByRole("meter", { name: "5-hour window" })).toHaveAttribute("aria-valuenow", "0");
  await expect(row.getByRole("meter")).toHaveCount(2);
  await expect(row.getByTestId("reset-in")).toContainText("5-hour window:in 1 day");
  await expect(row.getByTestId("reset-in")).toContainText("Weekly window:Unknown");
  await row.getByRole("link", { name: "ChatGPT" }).focus();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/admin\/accounts$/);
});

test("a Grok window without a reset does not invent a day count", async ({ page }) => {
  const accounts = providers();
  accounts[2].usage.current_window = { used_percent: 10, period: "weekly", starts_at: null, resets_at: null, shared: false };
  await fixtures(page, accounts);
  await page.goto("/admin/dashboard");
  const row = page.getByRole("row", { name: /Grok account/ });
  await expect(row.getByRole("meter", { name: "Weekly usage" })).toHaveAttribute("aria-valuenow", "10");
  await expect(row.getByTestId("reset-in")).toContainText("Unknown");
  await expect(row).not.toContainText("in 0 days");
});

test("a sub-day Grok reset stays in hours", async ({ page }) => {
  const accounts = providers();
  const soon = new Date(Date.now() + 3 * 3_600_000).toISOString();
  accounts[2].usage.current_window = { used_percent: 10, period: "weekly", starts_at: null, resets_at: soon, shared: true };
  await fixtures(page, accounts);
  await page.goto("/admin/dashboard");
  const row = page.getByRole("row", { name: /Grok account/ });
  await expect(row.locator(`time[datetime='${soon}']`)).toContainText("in 3 hours");
});

test("unknown, unavailable and login-required accounts never show zero quota", async ({ page }) => {
  const accounts = providers();
  accounts[0].usage = { ...account(2, "codex", "ChatGPT").usage, fetched_at: null };
  accounts[1].usage = { ...accounts[1].usage, supported: false };
  accounts[2].usage = { ...accounts[2].usage, fetched_at: null, checked_at: now, current_window: null };
  accounts[2].refresh_state = "login_required";
  delete accounts[0].plan; // older-server compatibility
  accounts[1].plan = { name: null, source: 'claude_login', observed_at: null, stale: true };
  accounts[3].usage = { ...accounts[3].usage, windows: [], fetched_at: null, checked_at: null };
  await fixtures(page, accounts, { off: true });
  await page.goto("/admin/dashboard");
  const table = page.getByRole("table", { name: USAGE });
  const rows = table.locator("tbody tr");
  await expect(rows).toHaveCount(4);
  await expect(table.getByRole("meter")).toHaveCount(0);
  await expect(rows.nth(0)).toContainText("Waiting for usage data");
  await expect(rows.nth(0).getByTestId("provider-plan")).toContainText("Plan unavailable");
  await expect(rows.nth(1).getByTestId("provider-plan")).toContainText("Plan unavailable");
  await expect(rows.nth(0)).toContainText("Disabled fleet-wide");
  await expect(rows.nth(1)).toContainText("Subscription quota unavailable");
  await expect(rows.nth(2)).toContainText("Usage unavailable");
  await expect(rows.nth(2)).toContainText("Login needed");
  await expect(rows.nth(3)).toContainText("Waiting for usage data");
});

test("loading shows a placeholder and an account error cannot silently switch to another source", async ({ page }) => {
  let release!: () => void;
  const wait = new Promise<void>(resolve => { release = resolve; });
  await fixtures(page, providers(), { wait, fail: true });
  await page.goto("/admin/dashboard");
  await expect(page.locator("section#usage").getByRole("status", { name: "Loading" })).toBeVisible();
  release();
  const usage = page.locator("section#usage");
  await expect(usage.getByText("Could not load provider accounts", { exact: false })).toBeVisible({ timeout: 20_000 });
  await expect(usage.getByRole("button", { name: "Retry" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "ChatGPT usage", exact: true })).toHaveCount(0);
});

test("a today marker places each bar against its quota period and never guesses", async ({ page }, info) => {
  const accounts = providers();
  const day = 86400_000;
  Object.assign(accounts[0].usage, { weekly_resets_at: new Date(Date.now() + 3.5 * day).toISOString() });
  accounts[2].usage.current_window = { used_percent: 87, period: "weekly", starts_at: new Date(Date.now() - day).toISOString(), resets_at: new Date(Date.now() + 3 * day).toISOString(), shared: true };
  await fixtures(page, accounts);
  await page.goto("/admin/dashboard");
  const markerLeft = async (name: RegExp) =>
    parseFloat(await page.getByRole("row", { name }).getByTestId("elapsed-marker").evaluate(node => (node as HTMLElement).style.left));
  expect(await markerLeft(/ChatGPT/)).toBeCloseTo(50, 0);
  expect(await markerLeft(/Grok account/)).toBeCloseTo(25, 0);
  await expect(page.getByRole("row", { name: /ChatGPT/ }).getByTestId("elapsed-marker")).toHaveAttribute("title", "50% of the period elapsed");
  await expect(page.getByRole("row", { name: /ChatGPT/ }).getByRole("meter")).toHaveAttribute("aria-valuetext", "15% used, 50% of the period elapsed");
  // Claude reports no reset time: its bars keep their plain reading and carry no marker.
  const claude = page.getByRole("row", { name: /Claude/ });
  await expect(claude.getByTestId("elapsed-marker")).toHaveCount(0);
  await expect(claude.getByRole("meter", { name: "Weekly window" })).toHaveAttribute("aria-valuetext", "24% used");
  const findings = await new AxeBuilder({ page }).include("section#usage").analyze();
  expect(findings.violations.filter(v => ["serious", "critical"].includes(v.impact ?? ""))).toEqual([]);
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.locator("section#usage").screenshot({ path: info.outputPath(`marker-${scheme}.png`) });
  }
});

test("a passed reset removes the marker instead of pinning it at the end", async ({ page }) => {
  const accounts = providers();
  Object.assign(accounts[0].usage, { weekly_resets_at: new Date(Date.now() - 60_000).toISOString() });
  await fixtures(page, accounts);
  await page.goto("/admin/dashboard");
  await expect(page.getByRole("row", { name: /ChatGPT/ }).getByRole("meter")).toBeVisible();
  await expect(page.getByRole("row", { name: /ChatGPT/ }).getByTestId("elapsed-marker")).toHaveCount(0);
});
