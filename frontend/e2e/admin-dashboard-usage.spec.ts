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
  ];
  accounts[0].plan = { name: 'Pro', source: 'chatgpt_usage', observed_at: now, stale: false };
  accounts[1].plan = { name: 'Max 20×', source: 'claude_login', observed_at: now, stale: true };
  accounts[2].plan = { name: 'SuperGrok Heavy', source: 'grok_settings', observed_at: now, stale: false };
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
    else if (path === "/admin/engines/state") data = { engines: ["codex", "claude", "grok"].map(engine => ({ engine, enabled: !(options.off && engine === "codex") })) };
    else if (path === "/admin/accounts") {
      if (options.wait) await options.wait;
      if (options.fail) return route.fulfill({ status: 503, json: { status: "error", error: { message: "Account service unavailable" } } });
      data = { accounts };
    }
    await route.fulfill({ json: { status: "ok", data } });
  });
}

test("three providers share card and meter geometry in light/dark desktop, tablet and mobile layouts", async ({ page }, info) => {
  test.setTimeout(90_000);
  await fixtures(page, providers());
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  for (const [width, columns, scheme] of [[1440, 3, "light"], [1440, 3, "dark"], [1000, 2, "light"], [390, 1, "light"], [390, 1, "dark"]] as const) {
    await page.setViewportSize({ width, height: 1000 });
    await page.emulateMedia({ colorScheme: scheme });
    await page.goto("/admin/dashboard");
    const cards = page.locator("a[aria-labelledby^='usage-account-']");
    await expect(cards).toHaveCount(3);
    await expect(cards.nth(0).getByTestId('provider-plan')).toContainText('Pro');
    await expect(cards.nth(1).getByTestId('provider-plan')).toContainText('Max 20×');
    await expect(cards.nth(1).getByTestId('provider-plan')).toContainText('Login metadata');
    await expect(cards.nth(1).getByTestId('provider-plan')).toContainText('Last known plan');
    await expect(cards.nth(2).getByTestId('provider-plan')).toContainText('SuperGrok Heavy');
    await expect(cards.nth(0).getByRole("meter")).toHaveCount(1);
    await expect(cards.nth(0)).not.toContainText("Short window");
    await expect(cards.nth(1).getByRole("meter", { name: "5-hour window" })).toHaveAttribute("aria-valuenow", "0");
    await expect(cards.nth(1)).toContainText("Last known reading");
    await expect(cards.nth(2).getByRole("meter", { name: "Weekly usage" })).toHaveAttribute("aria-valuenow", "87");
    const geometry = await cards.evaluateAll(nodes => nodes.map(node => {
      const bounds = node.getBoundingClientRect();
      const style = getComputedStyle(node);
      const meter = node.querySelector('[role="meter"]')!;
      return { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height,
        padding: style.padding, radius: style.borderRadius, meterHeight: meter.getBoundingClientRect().height,
        footerTop: node.lastElementChild!.getBoundingClientRect().y };
    }));
    expect(new Set(geometry.map(g => g.padding)).size).toBe(1);
    expect(new Set(geometry.map(g => g.radius)).size).toBe(1);
    expect(new Set(geometry.map(g => g.meterHeight)).size).toBe(1);
    expect(geometry.filter(g => Math.abs(g.y - geometry[0].y) < 1)).toHaveLength(columns);
    if (columns === 3) {
      expect(new Set(geometry.map(g => g.height)).size).toBe(1);
      expect(new Set(geometry.map(g => g.footerTop)).size).toBe(1);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const findings = await new AxeBuilder({ page }).include("a[aria-labelledby^='usage-account-']").analyze();
    expect(findings.violations.filter(v => ["serious", "critical"].includes(v.impact ?? ""))).toEqual([]);
    await cards.first().locator("..").screenshot({ path: info.outputPath(`providers-${width}-${scheme}.png`) });
  }
  expect(errors).toEqual([]);
});

test("ChatGPT renders a supplied five-hour zero reading and retains account navigation", async ({ page }) => {
  const accounts = providers();
  Object.assign(accounts[0].usage, { short_used_percent: 0, short_limit_seconds: 18000, short_resets_at: reset });
  await fixtures(page, accounts);
  await page.goto("/admin/dashboard");
  const card = page.getByRole("link", { name: "ChatGPT", exact: true });
  await expect(card.getByRole("meter", { name: "5-hour window" })).toHaveAttribute("aria-valuenow", "0");
  await expect(card.getByRole("meter")).toHaveCount(2);
  await expect(card.locator(`time[datetime='${reset}']`)).toBeVisible();
  await card.focus();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/admin\/accounts$/);
});

test("unknown, unavailable and login-required accounts never show zero quota", async ({ page }) => {
  const accounts = providers();
  accounts[0].usage = { ...account(2, "codex", "ChatGPT").usage, fetched_at: null };
  accounts[1].usage = { ...accounts[1].usage, supported: false };
  accounts[2].usage = { ...accounts[2].usage, fetched_at: null, checked_at: now, current_window: null };
  accounts[2].refresh_state = "login_required";
  delete accounts[0].plan; // older-server compatibility
  accounts[1].plan = { name: null, source: 'claude_login', observed_at: null, stale: true };
  await fixtures(page, accounts, { off: true });
  await page.goto("/admin/dashboard");
  const cards = page.locator("a[aria-labelledby^='usage-account-']");
  await expect(cards).toHaveCount(3);
  await expect(cards.getByRole("meter")).toHaveCount(0);
  await expect(cards.nth(0)).toContainText("Waiting for usage data");
  await expect(cards.nth(0).getByTestId('provider-plan')).toContainText('Plan unavailable');
  await expect(cards.nth(1).getByTestId('provider-plan')).toContainText('Plan unavailable');
  await expect(cards.nth(0)).toContainText("Disabled fleet-wide");
  await expect(cards.nth(1)).toContainText("Subscription quota unavailable");
  await expect(cards.nth(2)).toContainText("Usage unavailable");
  await expect(cards.nth(2)).toContainText("Subscription login needs renewal");
});

test("loading uses three placeholders and an account error cannot silently switch to legacy cards", async ({ page }) => {
  let release!: () => void;
  const wait = new Promise<void>(resolve => { release = resolve; });
  await fixtures(page, providers(), { wait, fail: true });
  await page.goto("/admin/dashboard");
  await expect(page.locator("[aria-label^='Loading '][aria-busy='true']")).toHaveCount(3);
  release();
  await expect(page.getByText("Could not load provider accounts", { exact: true })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole("button", { name: "Retry accounts" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "ChatGPT usage", exact: true })).toHaveCount(0);
});
