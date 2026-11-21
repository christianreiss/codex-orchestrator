import { expect, test } from "@playwright/test";
import { installFixtures } from "./admin-fixtures";

test("a bookmarked new host opens registration and preserves host detail in history", async ({ page }) => {
  await installFixtures(page);
  await page.goto("/admin/hosts/1");
  const host = page.getByRole("heading", { name: "console.example.test", exact: true });
  await expect(host).toBeVisible();

  await page.goto("/admin/hosts/new");
  const registration = page.getByRole("dialog", { name: "New host" });
  await expect(registration).toBeVisible();
  await expect(page).toHaveURL(/\/admin\/hosts\?add=1$/);
  await page.goBack();
  await expect(host).toBeVisible();
  await expect(page).toHaveURL(/\/admin\/hosts\/1$/);
  await page.goForward();
  await expect(registration).toBeVisible();
  await page.reload();
  await expect(registration).toBeVisible();
});

for (const path of ["/admin/agent-portal", "/admin/cli-auth/verify", "/admin/unknown-bookmark"]) {
  test(`a direct visit to ${path} offers recovery in one document`, async ({ page }) => {
    await installFixtures(page);
    let documents = 0;
    page.on("request", request => {
      if (request.resourceType() === "document" && new URL(request.url()).pathname === path) documents++;
    });

    await page.goto(path, { waitUntil: "commit" });
    await expect(page.getByRole("heading", { name: "Page not found", exact: true })).toBeVisible();
    await expect(page.getByText("Page not found", { exact: true })).toHaveCount(1);
    await expect(page.getByRole("button", { name: "Retry" })).toHaveCount(0);
    await page.getByRole("link", { name: "Return to Overview" }).click();
    await expect(page).toHaveURL(/\/admin\/dashboard$/);
    expect(documents).toBe(1);
  });
}


test("a temporary page load failure can be retried at the same address", async ({ page }) => {
  await installFixtures(page);
  // Fail the page module while leaving the SvelteKit root layout and error boundary available.
  const pageChunk = /\/_app\/immutable\/nodes\/(?![01]\.)\d+\.[^/]+\.js$/;
  await page.route(pageChunk, route => route.fulfill({ status: 503, headers: { "Cache-Control": "no-store" }, body: "Temporarily unavailable" }));
  await page.goto("/admin/hosts/1");
  await expect(page.getByRole("heading", { name: "Page unavailable" })).toBeVisible();
  await page.unroute(pageChunk);
  await page.getByRole("button", { name: "Retry" }).click();
  await expect(page.getByRole("heading", { name: "console.example.test" })).toBeVisible();
  await expect(page).toHaveURL(/\/admin\/hosts\/1$/);
});
