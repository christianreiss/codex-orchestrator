import { expect, test, type Route } from "@playwright/test";
import { fixture, installFixtures, user } from "./admin-fixtures";
import { installOwnerUpdates } from "./owner-stream";

test("account changes give search a fresh snapshot while older requests finish", async ({ page }) => {
  let actor: "first" | "second" | null = "first";
  await installFixtures(page, (path) => {
    if (path === "/admin/auth/status") return {
      ...fixture(path), authenticated: actor !== null, enforced: true,
      user: actor ? { ...user, id: actor === "first" ? 1 : 2, name: actor } : null,
    };
    if (path === "/admin/auth/logout") { actor = null; return {}; }
    if (path === "/admin/auth/login/method") return { methods: ["password"] };
    if (path === "/admin/auth/login") { actor = "second"; return {}; }
    return undefined;
  });

  let firstRead: Route | undefined;
  await page.route("**/admin/users", async (route) => {
    if (actor === "first") { firstRead = route; return; }
    return route.fulfill({ json: { users: [{ id: 2, username: "second-search-user" }] } });
  });
  await page.goto("/admin/dashboard");
  await page.getByRole("button", { name: "Account menu for first" }).waitFor();
  await page.keyboard.press("Control+k");
  await expect.poll(() => Boolean(firstRead)).toBe(true);
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Account menu for first" }).click();
  await page.getByRole("menuitem", { name: "Sign out" }).click();
  await page.getByLabel("Username").fill("second");
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByLabel("Password", { exact: true }).fill("fixture");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByRole("button", { name: "Account menu for second" }).waitFor();

  const received = page.waitForResponse(response => response.url().endsWith("/admin/users"));
  await firstRead!.fulfill({ json: { users: [{ id: 1, username: "first-search-user" }] } });
  await received;
  await page.keyboard.press("Control+k");
  await expect(page.getByRole("option", { name: "second-search-user" })).toBeVisible();
  await expect(page.getByRole("option", { name: "first-search-user" })).toHaveCount(0);
});

test("a role change updates controls in an open console", async ({ page }) => {
  let canManage = true;
  await installFixtures(page, path => path === "/admin/auth/status" ? {
    ...fixture(path), capabilities: canManage ? ["admin.read", "users.read", "users.manage"] : ["admin.read", "users.read"],
  } : undefined);
  const publish = await installOwnerUpdates(page);
  await page.goto("/admin/people");
  const create = page.getByRole("button", { name: /add (?:person|user)/i });
  await expect(create).toBeEnabled();
  canManage = false;
  await publish("user.updated", { user: { id: user.id } });
  await expect(create).toHaveCount(0);
});

test("a failed sign-out keeps the operator in place with a retry, and a lost acknowledgement reconciles the session", async ({ page }) => {
  let signedIn = true;
  await installFixtures(page, path => path === "/admin/auth/status" ? {
    ...fixture(path), authenticated: signedIn, enforced: true, user: signedIn ? user : null,
  } : undefined);
  let attempts = 0;
  await page.route("**/admin/auth/logout", route => {
    if (++attempts === 2) signedIn = false;
    return route.abort("failed");
  });
  await page.goto("/admin/dashboard");
  const account = page.getByRole("button", { name: /Account menu for/ });
  await account.click();
  await page.getByRole("menuitem", { name: "Sign out" }).click();
  await expect(page.getByText("Could not confirm sign-out")).toBeVisible();
  await expect(page).toHaveURL(/\/admin\/dashboard$/);
  await account.click();
  await page.getByRole("menuitem", { name: "Sign out" }).click();
  await expect(page.getByLabel("Username")).toBeVisible();
  expect(attempts).toBe(2);
});
