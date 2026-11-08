import { expect, test } from "@playwright/test";
import { installFixtures } from "./admin-fixtures";

test.beforeEach(async ({ page }) => { await installFixtures(page); });

test("unknown project coordination state cannot be changed", async ({ page }) => {
  await page.route("**/admin/projects/state", route => route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ message: "State temporarily unavailable" }) }));
  await page.goto("/admin/projects");
  await expect(page.getByText("Project coordination state unavailable:", { exact: false })).toBeVisible();
  await expect(page.getByRole("switch", { name: "Project coordination", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Retry coordination state" })).toBeVisible();
});

test("a delayed card response retains a newer title", async ({ page }) => {
  let release: () => void = () => {};
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route("**/admin/projects/fleet-console/board/cards", async route => {
    await gate;
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ card: { id: "new-card" } }) });
  });
  await page.goto("/admin/projects/fleet-console/board");
  const title = page.getByRole("textbox", { name: "New card title", exact: true });
  await title.fill("First card");
  await page.getByRole("button", { name: "Add card", exact: true }).click();
  await title.fill("Next card draft");
  release();
  await expect(page.getByText("Card created", { exact: true })).toBeVisible();
  await expect(title).toHaveValue("Next card draft");
});

test("reset without a token explains recovery before password entry", async ({ page }) => {
  await page.goto("/admin/password/reset?token=%20");
  await expect(page.getByText("This reset link is missing its token.", { exact: false })).toBeVisible();
  await expect(page.getByLabel("New password", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Return to sign in" })).toBeVisible();
});

test("a failed background setup check preserves a project draft", async ({ page }) => {
  let release: () => void = () => {};
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route("**/admin/setup/status", async route => {
    await gate;
    await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ message: "Probe failed" }) });
  });
  await page.goto("/admin/projects/fleet-console/board");
  const title = page.getByRole("textbox", { name: "New card title", exact: true });
  await title.fill("Retained while setup is unreachable");
  release();
  await expect(page.getByText("Setup status unavailable:", { exact: false })).toBeVisible();
  await expect(title).toHaveValue("Retained while setup is unreachable");
});

test("failed transfer audit is not presented as empty history", async ({ page }) => {
  let attempts = 0;
  let recovered = false;
  await page.route("**/admin/transfers/*/events", route => {
    attempts += 1;
    return route.fulfill({ status: recovered ? 200 : 503, contentType: "application/json", body: JSON.stringify(recovered ? { events: [] } : { message: "Audit unavailable" }) });
  });
  await page.route("**/admin/transfers", route => {
    if (!route.request().headers().accept?.includes("application/json")) return route.continue();
    return route.fulfill({ contentType: "application/json", body: JSON.stringify({ transfers: [{ id: "audit-fixture", name: "build-linux-amd64.tar.gz", status: "live", size_bytes: 1024, download_count: 0, expires_at: "2026-12-01T00:00:00Z", uploaded_by: "Fixture agent", mime_type: "application/gzip" }] }) });
  });
  await page.goto("/admin/transfers");
  await page.getByRole("button", { name: "build-linux-amd64.tar.gz", exact: true }).click();
  await expect(page.getByRole("button", { name: "Retry audit trail", exact: true })).toBeVisible();
  await expect(page.getByText("Nothing recorded yet.", { exact: true })).toHaveCount(0);
  const failedAttempts = attempts;
  recovered = true;
  await page.getByRole("button", { name: "Retry audit trail", exact: true }).click();
  await expect(page.getByText("Nothing recorded yet.", { exact: true })).toBeVisible();
  expect(attempts).toBe(failedAttempts + 1);
});
