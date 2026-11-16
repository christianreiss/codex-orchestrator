import { expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { fixture, installFixtures } from "./admin-fixtures";

const LONG = "a-long-project-name-that-must-remain-readable-on-touch-and-keyboard";
async function shell(page: import("@playwright/test").Page) {
  await installFixtures(page, (path) => {
    if (path === "/admin/feedback/summary") return { open: 1234, in_progress: 0, blocked: 0 };
    if (path === "/admin/hosts/insecure") return { hosts: [], fleet_window: { open: true, until: new Date(Date.now() + 600000).toISOString() } };
    if (path === "/admin/theme") return { theme: "auto" };
    if (path.startsWith(`/admin/projects/${LONG}`)) return fixture(path.replace(LONG, "fleet-console"));
    return undefined;
  });
}

for (const width of [320, 390, 768, 1440]) for (const theme of ["light", "dark"] as const) {
  test(`shell ${width} ${theme}: readable current location with all indicators`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 1000 });
    await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
    await shell(page);
    await page.goto(`/admin/projects/${LONG}/board`);
    const header = page.locator("header").filter({ has: page.getByRole("navigation", { name: "Breadcrumb" }) });
    await expect(header.getByRole("link", { name: "1234 unhandled reports" })).toBeVisible();
    const crumbs = header.getByRole("navigation", { name: "Breadcrumb" });
    await expect(crumbs).toContainText("Board");
    // Labels must wrap rather than be clipped inside an overflowing element.
    for (const li of await crumbs.locator("li").all()) expect(await li.evaluate(n => n.scrollWidth - n.clientWidth)).toBeLessThanOrEqual(1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
    const result = await new AxeBuilder({ page }).include("header").include("aside").analyze();
    expect(result.violations).toEqual([]);
    await page.screenshot({ path: info.outputPath(`shell-${width}-${theme}.png`), fullPage: true });
  });
}

test("compact sidebar explains icons on keyboard focus and expanded labels reflow at 200%", async ({ page }, info) => {
  await page.setViewportSize({ width: 800, height: 1000 });
  await shell(page); await page.goto("/admin/dashboard");
  const agents = page.getByRole("navigation", { name: "Primary navigation", exact: true }).getByRole("link", { name: "Agents", exact: true });
  await page.getByRole("navigation", { name: "Primary navigation", exact: true }).getByRole("link", { name: "Overview", exact: true }).focus();
  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
  await expect(agents).toBeFocused();
  await expect(page.getByRole("tooltip").filter({ hasText: "Agents ·" })).toBeVisible();
  await page.screenshot({ path: info.outputPath("rail-keyboard-tooltip.png"), fullPage: true });
  await page.keyboard.press("Escape");
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.evaluate(() => document.documentElement.style.fontSize = "200%");
  const nav = page.getByRole("navigation", { name: "Primary navigation", exact: true });
  for (const link of await nav.getByRole("link").all()) {
    const label = link.locator("span").last();
    expect(await label.evaluate(n => n.scrollWidth - n.clientWidth)).toBeLessThanOrEqual(1);
  }
  await page.screenshot({ path: info.outputPath("sidebar-text-200-percent.png"), fullPage: true });
});

test("appearance selection is announced and a failed save remains visible after dismissing its toast", async ({ page }) => {
  await shell(page); await page.goto("/admin/dashboard");
  await page.getByRole("button", { name: "Appearance", exact: true }).click();
  await expect(page.getByRole("menuitemradio", { name: "System", exact: true })).toBeChecked();
  await page.keyboard.press("Escape");
  let fail = true;
  await page.route("**/admin/theme", route => route.fulfill({ status: route.request().method() === "POST" && fail ? 503 : 200, contentType: "application/json", body: JSON.stringify(route.request().method() === "POST" && fail ? { message: "Fixture save unavailable" } : { theme: "light" }) }));
  await page.getByRole("button", { name: "Appearance", exact: true }).click();
  await page.getByRole("menuitemradio", { name: "Light", exact: true }).click();
  for (const close of await page.getByRole("button", { name: "Close toast", exact: true }).all()) await close.click();
  await expect(page.locator("header").getByRole("alert")).toContainText("Could not save appearance");
  fail = false;
  await page.getByRole("button", { name: "Retry appearance" }).click();
  await expect(page.locator("header").getByRole("alert")).toHaveCount(0);
  await page.getByRole("button", { name: "Appearance", exact: true }).click();
  await expect(page.getByRole("menuitemradio", { name: "Light", exact: true })).toBeChecked();
});


test("ordinary mobile headers stay compact and Skip to content shows focus", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 844 });
  await installFixtures(page);
  await page.goto("/admin/dashboard");
  const header = page.locator("header").filter({ has: page.getByRole("navigation", { name: "Breadcrumb" }) });
  expect((await header.boundingBox())!.height).toBeLessThanOrEqual(60);
  await page.getByRole("link", { name: "Skip to content" }).focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("main")).toBeFocused();
  expect(await page.locator("main").evaluate(n => getComputedStyle(n).boxShadow)).not.toBe("none");
});
