import { expect, test } from "@playwright/test";
import { installFixtures } from "./admin-fixtures";

const setupSteps = ["infrastructure", "owner", "engines", "auth", "defaults", "policy", "modules", "collaboration", "host"];

for (const colorScheme of ["light", "dark"] as const) {
  test(`account tab labels and selected panel remain reachable at 320px in ${colorScheme}`, async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 320, height: 844 }, hasTouch: true, colorScheme });
    const page = await context.newPage();
    await installFixtures(page, path => path === "/admin/theme" ? { theme: colorScheme } : undefined);
    await page.goto("/admin/account#devices");
    const tablist = page.getByRole("tablist", { name: "Account settings" });
    const scroller = tablist.locator("..");

    async function expectSelectedVisible() {
      await expect.poll(async () => {
        const selected = await tablist.getByRole("tab", { selected: true }).boundingBox();
        const viewport = await scroller.boundingBox();
        // Scroll offsets round to whole pixels in Firefox; text still has to
        // fit its control below, with at most one pixel at the outer edge.
        return Boolean(selected && viewport && selected.x >= viewport.x - 1 && selected.x + selected.width <= viewport.x + viewport.width + 1);
      }).toBe(true);
    }

    await expect(tablist.getByRole("tab", { name: "Devices", exact: true })).toHaveAttribute("aria-selected", "true");
    await page.evaluate(() => document.fonts.ready);
    await expectSelectedVisible();
    await page.setViewportSize({ width: 390, height: 844 });
    await expectSelectedVisible();
    await page.setViewportSize({ width: 320, height: 844 });
    await expectSelectedVisible();
    for (const label of ["Profile", "Security", "Appearance", "Devices"]) {
      const tab = tablist.getByRole("tab", { name: label, exact: true });
      await tab.click();
      const bounds = await tab.evaluate(element => {
        const control = element.getBoundingClientRect();
        const range = document.createRange();
        range.selectNodeContents(element);
        const text = range.getBoundingClientRect();
        return { fits: text.left >= control.left && text.right <= control.right, height: control.height };
      });
      expect(bounds.fits, `${label} fits its own tab without overlapping its neighbours`).toBe(true);
      expect(bounds.height).toBeGreaterThanOrEqual(44);
      await expectSelectedVisible();
    }
    await tablist.getByRole("tab", { name: "Profile", exact: true }).focus();
    await page.keyboard.press("End");
    await expect(tablist.getByRole("tab", { name: "Devices", exact: true })).toBeFocused();
    await expect(tablist.getByRole("tab", { name: "Devices", exact: true })).toHaveAttribute("aria-selected", "true");
    await expectSelectedVisible();
    expect(await page.locator("main").evaluate(element => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(2);
    await context.close();
  });
}

test("completed setup steps stay inside their local rail at phone widths", async ({ browser }) => {
  test.setTimeout(60_000);
  for (const width of [320, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 844 }, hasTouch: true });
    const page = await context.newPage();
    await installFixtures(page, path => path === "/admin/setup/status" ? {
      setup_complete: true, critical_complete: true, owner_created: true,
      checks: [{ id: "runner", label: "Authentication runner", ok: true, critical: true, detail: "Runner reachable" }],
      configured_engines: ["codex", "claude", "grok"], default_engines: ["codex", "claude", "grok"],
      canonical_auth: { codex: false, claude: false, grok: false }, hosts: { total: 0, synced: 0 },
      public_base_url: "https://console.example.test", warnings: [], next_actions: [],
      wizard: { completed_at: null, dismissed_at: null, last_step: "host", engines: ["codex", "claude", "grok"] },
    } : undefined);
    for (const step of setupSteps) {
      await page.goto(`/admin/setup?step=${step}`);
      const rail = page.getByRole("navigation", { name: "Setup steps" });
      await expect(rail.locator('[aria-current="step"]')).toHaveCount(1);
      expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth), `${step} at ${width}px`).toBeLessThanOrEqual(2);
      expect(await rail.evaluate(element => element.scrollWidth)).toBeGreaterThan(await rail.evaluate(element => element.clientWidth));
    }
    const lastStep = page.getByRole("navigation", { name: "Setup steps" }).getByRole("button", { name: "First host", exact: true });
    await lastStep.focus();
    // Firefox rounds scroll offsets to whole pixels while preserving fractional
    // layout bounds; allow at most one CSS pixel at the control's outer edge.
    await expect.poll(async () => lastStep.evaluate(element => {
      const control = element.getBoundingClientRect();
      const rail = element.closest("nav")!.getBoundingClientRect();
      return Math.max(rail.left - control.left, control.right - rail.right, rail.top - control.top, control.bottom - rail.bottom);
    })).toBeLessThanOrEqual(1);
    const labelInsideRail = await lastStep.evaluate(element => {
      const range = document.createRange();
      range.selectNodeContents(element);
      const label = range.getBoundingClientRect();
      const rail = element.closest("nav")!.getBoundingClientRect();
      return label.left >= rail.left && label.right <= rail.right && label.top >= rail.top && label.bottom <= rail.bottom;
    });
    expect(labelInsideRail).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(2);
    await context.close();
  }
});

test("a direct manual article precedes optional browsing on phones", async ({ page }) => {
  await installFixtures(page);
  await page.setViewportSize({ width: 320, height: 844 });
  await page.goto("/admin/manual/accounts");
  const article = page.locator("article .md-prose");
  await expect(article).not.toBeEmpty();
  expect((await article.boundingBox())!.y).toBeLessThan(600);
  const navigation = page.getByRole("complementary", { name: "Manual navigation" });
  const disclosure = navigation.locator("summary");
  await expect(disclosure).toHaveText("Browse manual");
  await expect(navigation.getByRole("link", { name: "Manual home", exact: true })).not.toBeVisible();
  await disclosure.focus();
  await page.keyboard.press("Enter");
  await expect(navigation.getByRole("link", { name: "Manual home", exact: true })).toBeVisible();
  await expect(navigation.getByRole("searchbox", { name: "Search the manual" })).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(navigation.getByRole("searchbox", { name: "Search the manual" })).not.toBeVisible();
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(disclosure).not.toBeVisible();
  await expect(navigation.getByRole("searchbox", { name: "Search the manual" })).toBeVisible();
});
