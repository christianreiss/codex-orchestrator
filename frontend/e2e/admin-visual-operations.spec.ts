import { expect, test } from "@playwright/test";
import { fixture, installFixtures } from "./admin-fixtures";

const longHost = "production-cluster-long-name-123456789012345678901234567890.region-with-long-name.example.test";

for (const width of [320, 390, 1440]) {
  test(`host and account filters retain their labels and touch areas at ${width}px`, async ({ browser, baseURL }) => {
    const context = await browser.newContext({ baseURL, viewport: { width, height: 900 }, hasTouch: true });
    const page = await context.newPage();
    await installFixtures(page);
    for (const [path, name] of [["/admin/hosts", "Show hosts"], ["/admin/accounts", "Filter by engine"]]) {
      await page.goto(path);
      const group = page.getByRole("group", { name, exact: true });
      await expect(group).toBeVisible();
      await expect.poll(() => group.evaluate((element) => {
        const boundary = element.getBoundingClientRect();
        return [...element.querySelectorAll("button")].every((button) => {
          const area = button.getBoundingClientRect();
          return area.height >= 44 && area.width >= 44 &&
            area.top >= boundary.top - 1 && area.bottom <= boundary.bottom + 1 &&
            area.left >= boundary.left - 1 && area.right <= boundary.right + 1 &&
            button.scrollWidth <= button.clientWidth + 1;
        });
      })).toBe(true);
    }
    await context.close();
  });
}

test("a filtered hosts list offers a complete reset without losing sort or unrelated URL state", async ({ page }) => {
  await installFixtures(page);
  await page.goto("/admin/hosts?q=nonexistent-fixture&status=online&flag=vip&filter=secure&sort=attention&dir=desc&context=keep");
  await expect(page.getByText("No matches", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Clear filters", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Search hosts", exact: true })).toHaveValue("");
  await expect(page.getByRole("link", { name: "console.example.test", exact: true })).toBeVisible();
  await expect.poll(() => {
    const url = new URL(page.url());
    return ["q", "status", "flag", "filter"].some((key) => url.searchParams.has(key));
  }).toBe(false);
  const url = new URL(page.url());
  expect(url.searchParams.get("sort")).toBe("attention");
  expect(url.searchParams.get("dir")).toBe("desc");
  expect(url.searchParams.get("context")).toBe("keep");
});

test("long host identities remain visually readable on a narrow screen", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 900 });
  await installFixtures(page, (path) => {
    if (path !== "/admin/hosts") return undefined;
    const data = fixture(path) as { hosts: Array<{ fqdn: string }> };
    return { ...data, hosts: data.hosts.map((host) => ({ ...host, fqdn: longHost })) };
  });
  await page.goto("/admin/hosts");
  const identity = page.getByRole("link", { name: longHost, exact: true }).filter({ visible: true });
  await expect(identity).toBeVisible();
  expect(await identity.evaluate((element) => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);
  expect((await identity.boundingBox())!.height).toBeGreaterThan(44);
});

test("account totals distinguish unavailable data from a confirmed empty pool", async ({ page }) => {
  await installFixtures(page);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  await page.route("**/admin/accounts", async (route) => {
    if (!route.request().headers().accept?.includes("application/json")) return route.continue();
    await gate;
    return route.fulfill({ status: 503, json: { status: "error", message: "Account backend unavailable" } });
  });
  await page.goto("/admin/accounts");
  await expect(page.getByRole("status", { name: "Loading", exact: true })).toBeVisible();
  await expect(page.locator("main dl")).toHaveCount(0);
  await page.getByRole("textbox", { name: "Search accounts", exact: true }).fill("unavailable");
  await expect(page.getByRole("search")).not.toContainText("0 of 0");
  release();
  await expect(page.getByText("Account backend unavailable", { exact: true })).toBeVisible();
  await expect(page.locator("main dl")).toHaveCount(0);
  await expect(page.getByRole("search")).not.toContainText("0 of 0");
  await page.getByRole("textbox", { name: "Search accounts", exact: true }).fill("");
  await page.unroute("**/admin/accounts");
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(page.getByText("No accounts", { exact: true })).toBeVisible();
  await expect(page.locator("main dl dt").first()).toHaveText("accounts");
  await expect(page.locator("main dl dd").first()).toHaveText("0");
});

test("failed account refresh retains and labels the last successful counts", async ({ page }) => {
  await installFixtures(page, (path) => path === "/admin/accounts" ? { accounts: [{
    id: 1, engine: "codex", label: "Retained account", state: "enabled", verification_state: "verified",
    verification_checked_at: "2026-10-27T10:00:00Z", generation: 1, refresh_state: "idle", usage: { supported: false }, sessions: [],
  }] } : path === "/admin/accounts/1/verify" ? { verification_state: "verified" } : undefined);
  await page.goto("/admin/accounts");
  await expect(page.getByRole("row", { name: /Retained account/ })).toBeVisible();
  await page.route("**/admin/accounts", (route) => {
    if (!route.request().headers().accept?.includes("application/json")) return route.continue();
    return route.fulfill({ status: 503, json: { status: "error", message: "Account refresh unavailable" } });
  });
  await page.getByRole("button", { name: "Actions for Retained account", exact: true }).click();
  await page.getByRole("menuitem", { name: "Verify", exact: true }).click();
  await expect(page.getByText("Account counts reflect the last successful load.", { exact: true })).toBeVisible();
  await expect(page.locator("main dl dd").first()).toHaveText("1");
  await expect(page.getByRole("row", { name: /Retained account/ })).toBeVisible();
});
