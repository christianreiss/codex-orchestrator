import { expect, test, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

/** The signed-out screens share one frame: login, password reset, CLI approval, setup. */
async function signedOut(page: Page) {
  await page.route("**/admin/**", async (route) => {
    if (!route.request().headers().accept?.includes("application/json")) return route.continue();
    const path = new URL(route.request().url()).pathname;
    let data: unknown = {};
    if (path === "/admin/auth/status") data = { authenticated: false, enforced: true, user: null, roles: [], capabilities: [] };
    else if (path === "/admin/auth/login/method") data = { methods: ["password"] };
    else if (path === "/admin/ws/info") data = { enabled: false };
    await route.fulfill({ json: { status: "ok", data } });
  });
}

async function expectNoSeriousAxeFindings(page: Page) {
  const results = await new AxeBuilder({ page }).analyze();
  expect(results.violations.filter((violation) => ["critical", "serious"].includes(violation.impact ?? ""))).toEqual([]);
}

test("the front door forwards to the overview, or to sign-in when signed out", async ({ page }) => {
  await signedOut(page);
  await page.goto("/admin");
  await expect(page).toHaveURL(/\/admin\/login$/);
  await expect(page.getByRole("heading", { name: "Sign in", level: 1 })).toBeVisible();
  await expect(page.getByText("Redirecting…")).toHaveCount(0);
});

test("sign-in walks username, then password, with the reset path one click away", async ({ page }) => {
  await signedOut(page);
  await page.goto("/admin/login");
  await expect(page.getByRole("heading", { name: "Sign in", level: 1 })).toBeVisible();
  await page.getByLabel("Username").fill("operator");
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByLabel("Password")).toBeVisible();
  await expect(page.getByRole("button", { name: "Sign in", exact: true })).toBeVisible();
  await expectNoSeriousAxeFindings(page);
  await page.getByRole("button", { name: "Forgot password?" }).click();
  await expect(page.getByRole("heading", { name: "Reset password", level: 1 })).toBeVisible();
  await expect(page.getByRole("button", { name: "Send reset link" })).toBeVisible();
  await page.getByRole("button", { name: "Back to sign in" }).click();
  await expect(page.getByRole("heading", { name: "Sign in", level: 1 })).toBeVisible();
});

test("password reset and CLI approval use the same frame at phone width", async ({ page }) => {
  await signedOut(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/admin/password/reset?token=abc");
  await expect(page.getByRole("heading", { name: "Choose a new password", level: 1 })).toBeVisible();
  await expect(page.getByLabel("New password", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await expectNoSeriousAxeFindings(page);

  await page.goto("/admin/cli-auth/verify");
  await expect(page.getByRole("heading", { name: "Approve CLI session", level: 1 })).toBeVisible();
  await expect(page.getByLabel("Device code")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await expectNoSeriousAxeFindings(page);
});

for (const theme of ["light", "dark", "system"] as const) {
  for (const width of [320, 390, 768, 1440, 1920]) {
    test(`authentication frame reflows ${theme} ${width}`, async ({ page }, testInfo) => {
      await signedOut(page);
      await page.setViewportSize({ width, height: width === 768 ? 1024 : width === 1920 ? 1080 : 900 });
      await page.emulateMedia({ colorScheme: theme === "light" ? "light" : "dark", reducedMotion: "reduce" });
      await page.addInitScript((value) => localStorage.setItem("codex.theme", value), theme);
      for (const path of ["/admin/login", "/admin/password/reset?token=fixture", "/admin/cli-auth/verify"]) {
        await page.goto(path);
        await expect(page.locator("main h1")).toHaveCount(1);
        await expect(page.getByLabel("Codex Orchestrator", { exact: true })).toHaveCount(1);
        expect(await page.locator("main").evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
        if (width === 320) {
          const axe = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
          expect(axe.violations).toEqual([]);
        }
        if ([390, 1440].includes(width) && theme !== "system") {
          await page.screenshot({ path: testInfo.outputPath(`${path.split("/").at(-1)?.split("?")[0]}-${theme}-${width}.png`), fullPage: true });
        }
      }
    });
  }
}

test("CLI confirmation preserves long host identity and keyboard actions at 320px", async ({ page }) => {
  await signedOut(page);
  await page.setViewportSize({ width: 320, height: 844 });
  await page.route("**/cli/auth/**", async route => route.fulfill({ json: { status: "ok", data: {
    fqdn: "a-very-long-hostname-for-an-operator-to-identify.example.infrastructure.internal",
    ip: "2001:db8:ffff:ffff:ffff:ffff:ffff:ffff", secure: false,
    created_at: "2026-10-25T12:00:00Z", expires_at: "2026-10-25T12:30:00Z",
  } } }));
  await page.goto("/admin/cli-auth/verify");
  await page.getByLabel("Device code").fill("ABCD-1234");
  await page.getByLabel("Device code").press("Enter");
  await expect(page.getByText("Hostname", { exact: true })).toBeVisible();
  expect(await page.locator("main").evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
  await page.getByRole("button", { name: "Deny", exact: true }).focus();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "Approve", exact: true })).toBeFocused();
  await expect(page.getByRole("button", { name: "Approve", exact: true })).toHaveClass(/bg-primary/);
  const axe = await new AxeBuilder({ page }).analyze();
  expect(axe.violations).toEqual([]);
});
