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
