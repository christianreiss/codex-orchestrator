import { expect, test, type Page } from "@playwright/test";
import { installFixtures } from "./admin-fixtures";

// The card menu is the board's non-drag path (ACC-1): moving, editing, force
// releasing and archiving a card must work from it with pointer and keyboard.

const BOARD = "/admin/projects/fleet-console/board";

/** Serve the fixture board and record every move the console posts. */
async function serve(page: Page) {
  const moves: { path: string; body: unknown }[] = [];
  await installFixtures(page, (path, body) => {
    // The card editor shows the card's changelog; an empty one is enough here.
    if (path === "/admin/projects/fleet-console/changelog") return { project: "fleet-console", entries: [], next_before_id: null };
    if (!path.endsWith("/move")) return undefined;
    moves.push({ path, body });
    return { project: "fleet-console", card: { id: "card-1" }, advisories: [] };
  });
  return moves;
}

/** Page errors are how a menu that throws at open shows itself: no items, no visible failure. */
function collectPageErrors(page: Page) {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  return errors;
}

const cardArticle = (page: Page, title: string) =>
  page.getByRole("article").filter({ has: page.getByRole("heading", { name: title, exact: true }) });

test("card actions menu lists move targets and card actions, and moves the card", async ({ page }) => {
  const errors = collectPageErrors(page);
  const moves = await serve(page);
  await page.goto(BOARD);

  await cardArticle(page, "Refresh runner image").getByRole("button", { name: "Card actions" }).click();
  const menu = page.getByRole("menu");
  await expect(menu).toBeVisible();
  await expect(menu.getByText("Move to", { exact: true })).toBeVisible();
  // Every other column is a target; the card's own column is not.
  await expect(menu.getByRole("menuitem", { name: "Coding", exact: true })).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: "Backlog", exact: true })).toHaveCount(0);
  await expect(menu.getByRole("menuitem", { name: "Edit", exact: true })).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: "Archive card…", exact: true })).toBeVisible();
  // Not held, so there is nothing to force release.
  await expect(menu.getByRole("menuitem", { name: "Force release", exact: true })).toHaveCount(0);

  await menu.getByRole("menuitem", { name: "Coding", exact: true }).click();
  await expect.poll(() => moves.length).toBe(1);
  expect(moves[0]).toEqual({ path: `${BOARD}/cards/card-1/move`, body: { column: "col-coding" } });
  expect(errors).toEqual([]);
});

test("card actions menu works from the keyboard on a held card", async ({ page }) => {
  const errors = collectPageErrors(page);
  await serve(page);
  await page.goto(BOARD);

  const trigger = cardArticle(page, "Capture baseline").getByRole("button", { name: "Card actions" });
  await trigger.focus();
  await page.keyboard.press("Enter");
  const menu = page.getByRole("menu");
  await expect(menu).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: "Backlog", exact: true })).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: "Force release", exact: true })).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await expect(trigger).toBeFocused();

  // Reopen and choose Edit with the arrow keys: focus starts on the first
  // target, the next item is Edit, and Enter opens the card editor.
  await page.keyboard.press("Enter");
  await expect(page.getByRole("menuitem", { name: "Backlog", exact: true })).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(page.getByRole("menuitem", { name: "Edit", exact: true })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.getByRole("dialog").getByLabel("Title", { exact: true })).toHaveValue("Capture baseline");
  expect(errors).toEqual([]);
});
