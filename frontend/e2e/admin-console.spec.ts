import { expect, test, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

const user = {
  id: 1,
  username: "operator",
  name: "Console Operator",
  access_level: "owner",
  roles: ["owner"],
};

function fixture(pathname: string): Record<string, unknown> {
  switch (pathname) {
    case "/admin/auth/status":
      return { authenticated: true, enforced: true, user, roles: ["owner"] };
    case "/admin/setup/status":
      return { setup_complete: true, critical_complete: true, checks: [], next_actions: [] };
    case "/admin/ws/info":
      return { enabled: false };
    case "/admin/theme":
      return { theme: "auto" };
    case "/admin/overview":
      return {
        totals: { hosts: 2 },
        last_refresh: "2026-08-01T08:00:00Z",
        versions: { cdx_version_available: "1.0.0", claude_version_available: "2.0.0" },
        version_distribution: { codex: [], claude: [], install: { both: 1, codex_only: 1, claude_only: 0, neither: 0 } },
      };
    case "/admin/insecure-approvals/pending":
      return { requests: [] };
    case "/admin/projects/state":
      return { enabled: true };
    case "/admin/projects":
      return {
        projects: [{ slug: "fleet-console", title: "Fleet console", description: "Admin redesign", updated_at: "2026-08-01T08:00:00Z", latest_seq: 4 }],
      };
    case "/admin/skills":
      return { skills: [{ slug: "fleet-ops", display_name: "Fleet operations", description: "Operator runbook", status: "ok" }] };
    case "/admin/hosts":
      return { hosts: [] };
    case "/admin/users":
      return { users: [] };
    default:
      return { status: "ok" };
  }
}

async function installFixtures(page: Page): Promise<void> {
  await page.route("**/admin/**", async (route) => {
    const request = route.request();
    if (!request.headers().accept?.includes("application/json")) return route.continue();
    const pathname = new URL(request.url()).pathname;
    return route.fulfill({ contentType: "application/json", body: JSON.stringify(fixture(pathname)) });
  });
}

test.beforeEach(async ({ page }) => {
  await installFixtures(page);
});

test("desktop shell exposes direct task navigation and the command palette", async ({ page }) => {
  for (const width of [1440, 1920]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/admin/dashboard");
    await expect(page.getByRole("heading", { name: "Overview" })).toBeVisible();
  }

  const primary = page.getByRole("navigation", { name: "Primary navigation" });
  await expect(primary.getByRole("link", { name: "Engines" })).toBeVisible();
  await expect(primary.getByRole("link", { name: "Policies" })).toBeVisible();
  await expect(primary.getByRole("link", { name: "Agent Messaging" })).toBeVisible();
  await expect(primary.getByRole("link", { name: "Fleet Instructions" })).toBeVisible();
  await expect(primary.getByRole("link", { name: "Admin Users" })).toBeVisible();

  await page.keyboard.press("Control+K");
  await expect(page.getByPlaceholder("Type a command or search hosts, projects, skills, users…")).toBeVisible();
  await expect(page.getByText("Agent Portal", { exact: true })).toBeVisible();
});

test("operator tables use the full workspace and the mobile menu retains all routes", async ({ page }) => {
  await page.goto("/admin/projects");
  await expect(page.getByRole("heading", { name: "Projects" })).toBeVisible();
  await expect(page.getByRole("table")).toBeVisible();
  await expect(page.getByRole("link", { name: "Fleet console" })).toBeVisible();

  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await page.getByRole("button", { name: "Open navigation menu" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("link", { name: /Output Styles/ })).toBeVisible();
  await expect(dialog.getByRole("link", { name: /Agent Portal/ })).toBeVisible();
});

test("neutral configuration template has no serious Axe findings", async ({ page }) => {
  await page.goto("/admin/account/theme");
  await expect(page.getByRole("heading", { name: "Appearance" })).toBeVisible();
  await expect(page.getByText("System", { exact: true })).toBeVisible();
  await expect(page.getByText("Light", { exact: true })).toBeVisible();
  await expect(page.getByText("Dark", { exact: true })).toBeVisible();

  const results = await new AxeBuilder({ page }).analyze();
  expect(results.violations.filter((violation) => ["critical", "serious"].includes(violation.impact ?? ""))).toEqual([]);
});
