import AxeBuilder from "@axe-core/playwright";
import { writeFile } from "node:fs/promises";
import { test, expect, type Page } from "@playwright/test";
import { installFixtures } from "./admin-fixtures";
const empty = {
  categories: {},
  hosts: [],
  projects: [],
  tools: [],
  sensitive: [],
  global: false,
};
async function fixture(page: Page, enabled = false) {
  await installFixtures(page);
  let policy = {
    enabled,
    providers: { chatgpt: enabled, claude: enabled, grok: enabled },
    ceiling: empty,
  };
  await page.route("**/admin/connectors/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    const json = (data: unknown) =>
      route.fulfill({ json: { status: "ok", data } });
    if (path === "/admin/connectors/config") {
      if (route.request().method() === "PUT")
        policy = route.request().postDataJSON();
      return json({
        policy,
        can_manage: true,
        issuer: "https://fleet.example",
        mcp_url: "https://fleet.example/connectors/mcp",
        ready: true,
        hosts: [{ id: 1, name: "host01.example" }],
        projects: ["alpha"],
        catalog: [],
      });
    }
    if (path === "/admin/connectors/connections")
      return json({ connections: [] });
    if (path.startsWith("/admin/connectors/consent/"))
      return json({
        client: { name: "Claude", provider: "claude" },
        csrf: "token",
      });
    if (path === "/admin/connectors/preview")
      return json({ scope: empty, operations: [] });
    return json({});
  });
}
for (const colorScheme of ["light", "dark"] as const) test(`default-off guide explains actual installation, has editable policy and mobile reflow (${colorScheme})`, async ({
  page,
}, testInfo) => {
  await page.emulateMedia({ colorScheme });
  await page.addInitScript((theme) => localStorage.setItem("mode-watcher-mode", theme), colorScheme);
  await fixture(page);
  await page.goto("/admin/connectors");
  await expect(
    page.getByRole("heading", { name: "Connectors", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Connector access is off.", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("https://fleet.example/connectors/mcp", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Edit policy" }).click();
  await page.getByLabel("Enable connector access", { exact: false }).check();
  await page.getByRole("button", { name: "Save policy" }).click();
  await expect(
    page.getByText("Connector access is on.", { exact: true }),
  ).toBeVisible();
  const toast = page.locator('[data-sonner-toast][data-type="success"]');
  await expect(toast).toContainText("Connector policy saved");
  await expect(page.locator("[data-sonner-toaster]")).toHaveAttribute("data-sonner-theme", colorScheme);
  await expect(toast).toHaveCSS("opacity", "1");
  console.log("Connector success toast", colorScheme, await toast.evaluate((element) => ({
    foreground: getComputedStyle(element).color,
    background: getComputedStyle(element).backgroundColor,
  })));
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("connectors-mobile.png"), fullPage: true });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.screenshot({
    path: testInfo.outputPath("connectors-desktop.png"),
    fullPage: true,
  });
  await expect(toast).toBeVisible();
  const a11y = await new AxeBuilder({ page }).analyze();
  await writeFile(testInfo.outputPath("connectors-a11y.json"), JSON.stringify(a11y));
  expect(a11y.violations).toEqual([]);
});
test("consent requires an effective permission review", async ({ page }) => {
  await fixture(page);
  await page.goto("/admin/connectors?request=example");
  await expect(
    page.getByRole("button", { name: "Authorize connection" }),
  ).toBeDisabled();
  await page
    .getByRole("button", { name: "Review effective permissions" })
    .click();
  await expect(
    page.getByText("No tools permitted by the current policy."),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Authorize connection" }),
  ).toBeDisabled();
});

test("a late preview never authorizes permissions the user removed", async ({
  page,
}) => {
  await fixture(page, true);
  let release!: () => void;
  const hold = new Promise<void>((r) => (release = r));
  await page.route("**/admin/connectors/preview", async (route) => {
    const scope = route.request().postDataJSON();
    await hold;
    await route.fulfill({
      json: { status: "ok", data: { scope, operations: ["hosts_list"] } },
    });
  });
  await page.goto("/admin/connectors?request=example");
  await page
    .getByRole("combobox", { name: "hosts access", exact: true })
    .selectOption("ro");
  await page
    .getByRole("button", { name: "Review effective permissions" })
    .click();
  await page
    .getByRole("combobox", { name: "hosts access", exact: true })
    .selectOption("off");
  release();
  await expect(
    page.getByRole("button", { name: "Review effective permissions" }),
  ).toBeEnabled();
  await expect(
    page.getByText("Effective access:", { exact: false }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Authorize connection" }),
  ).toBeDisabled();
  await page.screenshot({
    path: "/tmp/connectors-consent.png",
    fullPage: true,
  });
});

test("manual client IDs stay associated with their original provider and callback", async ({
  page,
}) => {
  await fixture(page);
  await page.route("**/admin/connectors/config", (route) =>
    route.fulfill({
      json: {
        status: "ok",
        data: {
          policy: {
            enabled: true,
            providers: { chatgpt: true, claude: true, grok: true },
            ceiling: empty,
          },
          can_manage: true,
          issuer: "https://fleet.example",
          mcp_url: "https://fleet.example/connectors/mcp",
          ready: true,
          hosts: [],
          projects: [],
          catalog: [],
        },
      },
    }),
  );
  await page.route("**/admin/connectors/clients", (route) =>
    route.fulfill({
      json: { status: "ok", data: { client_id: "example-client" } },
    }),
  );
  await page.goto("/admin/connectors");
  await page.getByText("Manual OAuth client setup", { exact: true }).click();
  await page
    .getByLabel("Callback URL", { exact: true })
    .fill("https://client.example/callback");
  await page
    .getByRole("button", { name: "Create client ID", exact: true })
    .click();
  await expect(page.getByText("example-client", { exact: true })).toBeVisible();
  await page
    .getByLabel("Callback URL", { exact: true })
    .fill("https://client.example/other");
  await expect(page.getByText("example-client", { exact: true })).toHaveCount(
    0,
  );
});

test("policy saving protects the submitted draft and keeps failures beside controls", async ({
  page,
}) => {
  await fixture(page);
  let release!: () => void;
  const hold = new Promise<void>((r) => (release = r));
  await page.route("**/admin/connectors/config", async (route) => {
    if (route.request().method() !== "PUT") return route.fallback();
    await hold;
    return route.fulfill({
      status: 503,
      json: { status: "error", message: "Storage unavailable" },
    });
  });
  await page.goto("/admin/connectors");
  await page.getByRole("button", { name: "Edit policy" }).click();
  const toggle = page.getByLabel("Enable connector access", { exact: false });
  await toggle.check();
  await page.getByRole("button", { name: "Save policy" }).click();
  await expect(toggle).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "Cancel", exact: true }),
  ).toBeDisabled();
  release();
  await expect(
    page.getByRole("alert").filter({ hasText: "Policy save failed:" }),
  ).toBeVisible();
  await expect(toggle).toBeChecked();
  await expect(toggle).toBeEnabled();
});

test("authorization freezes the reviewed selection until failure or redirect", async ({
  page,
}) => {
  await fixture(page, true);
  let release!: () => void;
  const hold = new Promise<void>((r) => (release = r));
  await page.route("**/admin/connectors/consent/example", async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    await hold;
    await route.fulfill({
      status: 503,
      json: { status: "error", message: "Try again" },
    });
  });
  await page.goto("/admin/connectors?request=example");
  await page
    .getByRole("combobox", { name: "hosts access", exact: true })
    .selectOption("ro");
  await page
    .getByRole("button", { name: "Review effective permissions" })
    .click();
  await expect(
    page.getByRole("button", { name: "Authorize connection", exact: true }),
  ).toBeEnabled();
  await page
    .getByRole("button", { name: "Authorize connection", exact: true })
    .click();
  await expect(
    page.getByRole("combobox", { name: "hosts access", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "Review effective permissions" }),
  ).toBeDisabled();
  await expect(
    page.getByText("Authorizing reviewed permissions…", { exact: true }),
  ).toBeVisible();
  release();
  await expect(
    page.getByRole("alert").filter({ hasText: "Authorization failed:" }),
  ).toBeVisible();
  await expect(
    page.getByRole("combobox", { name: "hosts access", exact: true }),
  ).toBeEnabled();
});

test("navigation preserves an unsaved policy when discard is declined", async ({
  page,
}) => {
  await fixture(page);
  await page.goto("/admin/connectors");
  await page.getByRole("button", { name: "Edit policy" }).click();
  await page.getByLabel("Enable connector access", { exact: false }).check();
  let prompted = false;
  page.on("dialog", async (dialog) => {
    prompted = true;
    await dialog.dismiss();
  });
  await page
    .getByRole("link", { name: "Overview", exact: true })
    .first()
    .click();
  await expect.poll(() => prompted).toBe(true);
  await expect(page).toHaveURL(/connectors$/);
  await expect(
    page.getByLabel("Enable connector access", { exact: false }),
  ).toBeChecked();
});
