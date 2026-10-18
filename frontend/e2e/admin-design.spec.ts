import { expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
const routes: { source: string; path: string }[] = JSON.parse(readFileSync("e2e/design-routes.json", "utf8"));
import { installFixtures } from "./admin-fixtures";

const sizes = [{ width: 320, height: 844 }, { width: 390, height: 844 }, { width: 768, height: 1024 }, { width: 1440, height: 900 }, { width: 1920, height: 1080 }];
const variants = ["/admin/library?type=commands", "/admin/library?type=output-styles", "/admin/library?type=memories", "/admin/library/subagents/design-fixture", "/admin/library/commands/design-fixture", "/admin/library/output-styles/design-fixture", "/admin/agents?view=graph", "/admin/agent-messaging?view=addresses", "/admin/agent-messaging?view=groups", "/admin/agent-messaging?view=conferences", "/admin/agent-messaging?view=deliveries"];

function pages(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => entry.isDirectory() ? pages(join(dir, entry.name)) : entry.name === "+page.svelte" ? [join(dir, entry.name)] : []);
}

test("coverage inventory includes every route entry", () => {
  expect(routes.map((r) => r.source).sort()).toEqual(pages("src/routes").sort());
});

test.beforeEach(async ({ page }) => {
  await installFixtures(page, (path) => {
    if (path === "/admin/theme") return { theme: "system" };
    if (path === "/admin/skills/design-fixture") return { slug: "design-fixture", display_name: "Design fixture with a deliberately long readable title", manifest: "# Document title\n\n## Details\n\nReadable body", description: "Editable test document", sha256: "fixture", managed: false };
    if (/\/admin\/claude\/(subagents?|commands?|output-styles?)\/design-fixture$/.test(path)) return { slug: "design-fixture", body: "# Document title\n\nBody", description: "Test description", frontmatter: {}, sha256: "fixture" };
    return undefined;
  });
});

for (const colorScheme of ["light", "dark"] as const) {
  for (const size of sizes) {
    test(`all pages reflow ${colorScheme} ${size.width}`, async ({ page }, testInfo) => {
      test.setTimeout(240_000);
      await page.setViewportSize(size);
      await page.emulateMedia({ colorScheme, reducedMotion: "reduce" });
      await page.addInitScript((theme) => localStorage.setItem("codex.theme", theme), colorScheme);
      for (const path of [...routes.map((r) => r.path), ...variants]) {
        await test.step(path, async () => {
          await page.goto(path);
          await expect.soft(page.locator("h1")).toHaveCount(1, { timeout: 10_000 });
          await expect.soft(page.locator("h1")).toBeVisible();
          await expect.soft(page.locator("h1")).not.toHaveText("");
          await expect.soft.poll(() => page.evaluate(() => {
            const main = document.querySelector("main");
            return main ? main.scrollWidth - main.clientWidth : 0;
          }), { message: `${path}: page scrolls horizontally`, timeout: 3000 }).toBeLessThanOrEqual(2);
          if (colorScheme === "dark") await expect.soft(page.locator("html")).toHaveClass(/dark/);
          else await expect.soft(page.locator("html")).not.toHaveClass(/dark/);
          if ([320, 1440].includes(size.width) && ["/admin/dashboard", "/admin/projects/fleet-console/reports"].includes(path)) {
            await page.screenshot({ path: testInfo.outputPath(`${path.split("/").at(-1)}-${colorScheme}-${size.width}.png`), fullPage: true });
          }
          const title = await page.locator("h1").innerText();
          await expect.soft(page).toHaveTitle(new RegExp(title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
          if (size.width === 320) {
            const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
            expect.soft(results.violations, `${path}: ${JSON.stringify(results.violations.map((v) => ({ id: v.id, nodes: v.nodes.map((n) => n.target) })))}`).toEqual([]);
          }
        });
      }
    });
  }
}

test("all manual articles render within the viewport", async ({ page }) => {
  test.setTimeout(180_000);
  await page.setViewportSize(sizes[0]);
  const manifest = JSON.parse(readFileSync("../public/admin/manual/manifest.json", "utf8"));
  const articles = Array.isArray(manifest) ? manifest : manifest.articles;
  for (const article of articles) {
    await page.goto(`/admin/manual/${article.slug}`);
    await expect.soft(page.locator("article .md-prose")).not.toBeEmpty();
    expect(await page.locator("main").evaluate((el) => el.scrollWidth - el.clientWidth), article.slug).toBeLessThanOrEqual(2);
    await expect(page.locator("h1")).toHaveCount(1);
    const result = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
    expect.soft(result.violations.map(v => ({ id: v.id, nodes: v.nodes.map(n => n.target) })), article.slug).toEqual([]);
  }
});

test("draft survives rejection and navigation cancel, then clears only after save", async ({ page }) => {
  await page.goto("/admin/library/skills/design-fixture");
  const body = page.getByRole("textbox", { name: "Skill manifest" });
  await body.fill("# My retained draft");
  await page.route("**/admin/skills/store", route => route.fulfill({ status: 422, contentType: "application/json", body: JSON.stringify({ status: "error", message: "Description is required" }) }));
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText("The server rejected the change.", { exact: false })).toBeVisible();
  await expect(body).toHaveValue("# My retained draft");
  page.once("dialog", dialog => dialog.dismiss());
  await page.getByRole("link", { name: "Back", exact: true }).click();
  await expect(body).toHaveValue("# My retained draft");
  await page.unroute("**/admin/skills/store");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText("Saved. Confirmed by the server.", { exact: true })).toBeVisible();
  await page.getByRole("link", { name: "Back", exact: true }).click();
  await expect(page).toHaveURL(/\/admin\/library$/);
});

test("coarse pointer controls stay usable on phones and hybrid desktops", async ({ browser }) => {
  for (const width of [390, 1440]) {
    const context = await browser.newContext({ hasTouch: true, viewport: { width, height: 900 } });
    const page = await context.newPage();
    await installFixtures(page);
    await page.goto("/admin/hosts");
    const add = page.getByRole("button", { name: "Add host", exact: true });
    await expect(add).toBeVisible();
    const bounds = await add.boundingBox();
    expect(bounds!.height).toBeGreaterThanOrEqual(44);
    expect(bounds!.width).toBeGreaterThanOrEqual(44);
    await context.close();
  }
});

test("list context survives a detail roundtrip and Back", async ({ page }) => {
  await page.goto("/admin/projects");
  const search = page.getByRole("textbox", { name: "Search projects" });
  await search.fill("fleet");
  await page.getByRole("link", { name: "Fleet console", exact: true }).click();
  await expect(page).toHaveURL(/\/board$/);
  await page.goBack();
  await expect(search).toHaveValue("fleet");
  await search.fill("no-result-fixture");
  await page.getByRole("button", { name: "Clear filters", exact: true }).click();
  await expect(search).toHaveValue("");
});

test("long standalone setup remains scrollable with text enlargement", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 600 });
  await page.goto("/admin/setup");
  await page.addStyleTag({ content: "html { font-size: 200% !important; } p { line-height: 1.5 !important; letter-spacing: .12em !important; word-spacing: .16em !important; }" });
  const main = page.locator("main");
  await expect(page.locator("h1")).toBeVisible();
  await main.evaluate(el => { el.scrollTop = el.scrollHeight; });
  expect(await main.evaluate(el => el.scrollTop)).toBeGreaterThan(0);
  expect(await main.evaluate(el => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(2);
});

test("loading, empty and failed requests remain distinct", async ({ page }) => {
  let release: () => void = () => {};
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route("**/admin/projects", async route => {
    if (!route.request().headers().accept?.includes("application/json")) return route.continue();
    await gate;
    return route.fulfill({ contentType: "application/json", body: JSON.stringify({ projects: [] }) });
  });
  await page.goto("/admin/projects");
  await expect(page.getByRole("status", { name: "Loading", exact: true })).toBeVisible();
  await expect(page.getByText("No projects yet", { exact: true })).toHaveCount(0);
  release();
  await expect(page.getByText("No projects yet", { exact: true })).toBeVisible();
  await page.unroute("**/admin/projects");
  await page.route("**/admin/projects", route => {
    if (!route.request().headers().accept?.includes("application/json")) return route.continue();
    return route.fulfill({ status: 403, contentType: "application/json", body: JSON.stringify({ status: "error", message: "Project access denied" }) });
  });
  await page.reload();
  await expect(page.getByText("Project access denied", { exact: true })).toBeVisible();
  await expect(page.getByText("No projects yet", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Retry", exact: true })).toBeVisible();
});

test("transport failure does not claim a rejected or saved draft", async ({ page }) => {
  await page.goto("/admin/library/skills/design-fixture");
  await page.getByRole("textbox", { name: "Skill manifest" }).fill("Uncertain save fixture");
  await page.route("**/admin/skills/store", route => route.abort("failed"));
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText("Save not confirmed.", { exact: false })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Skill manifest" })).toHaveValue("Uncertain save fixture");
  await expect(page.getByText("Saved. Confirmed by the server.", { exact: true })).toHaveCount(0);
});


test("conversation details open with the keyboard", async ({ page }) => {
  await page.goto("/admin/agent-messaging");
  const open = page.getByRole("button", { name: /console.*review/ });
  await open.focus();
  await open.press("Enter");
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.getByRole("button", { name: "Open delivery log", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(open).toBeFocused();
});


test("project validation waits for blur and closing keeps an unconfirmed draft", async ({ page }) => {
  await page.goto("/admin/projects");
  await page.getByRole("button", { name: "New project", exact: true }).click();
  const dialog = page.getByRole("dialog");
  const slug = dialog.getByLabel("Slug", { exact: false });
  await slug.fill("Invalid slug");
  await expect(dialog.getByRole("alert")).toHaveCount(0);
  await slug.press("Tab");
  await expect(dialog.getByRole("alert")).toContainText("kebab-case");
  await slug.fill("retained-project");
  page.once("dialog", prompt => prompt.dismiss());
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  await expect(slug).toHaveValue("retained-project");
  page.once("dialog", prompt => prompt.accept());
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  await expect(dialog).toHaveCount(0);
});
