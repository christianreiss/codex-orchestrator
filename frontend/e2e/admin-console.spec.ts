import { expect, test, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import type { ModelDefaultsValue } from "../src/lib/api/types";
import { CAPABILITIES } from "../src/lib/auth/capabilities";

import { user, RENDERED_AGENTS_CONTENT, BUILDER_STATE, SECURITY_LEVELS_STANDARD, SECURITY_CATALOG, PROVENANCE_DOC, PROVENANCE_ENTRIES, BUILDER_CATALOG, CANONICAL_DESTINATIONS, fixture, FixtureOverride, installFixtures } from "./admin-fixtures";

async function expectNoSeriousAxeFindings(page: Page): Promise<void> {
  const results = await new AxeBuilder({ page }).analyze();
  expect(
    results.violations.filter((violation) => ["critical", "serious"].includes(violation.impact ?? "")),
  ).toEqual([]);
}

test.beforeEach(async ({ page }) => {
  await installFixtures(page);
});

test("working secrets are shared across engines without a scope selector", async ({ page }) => {
  let saved: Record<string, unknown> | undefined;
  const secret = { id: 1, slug: "fixture-token", name: "Fixture token", description: "Test service",
    source_host_id: null, source_engine: "codex", tags: [], created_at: "2026-10-08T00:00:00Z",
    updated_at: "2026-10-08T00:00:00Z", last_rotated_at: null, deleted_at: null };
  await installFixtures(page, (path, body) => {
    if (path === "/admin/secrets/state") return { enabled: true, count: 1, updated_at: null };
    if (path === "/admin/secrets") {
      if (body) { saved = body as Record<string, unknown>; return { secret: { ...secret, ...saved } }; }
      return { secrets: [secret] };
    }
    return undefined;
  });
  await page.goto("/admin/access#secrets");
  await expect(page.getByText("fixture-token", { exact: true })).toBeVisible();
  await expect(page.getByRole("columnheader", { name: "Scope", exact: true })).toHaveCount(0);
  await expect(page.getByText("Operator", { exact: true }).last()).toBeVisible();
  await page.getByRole("button", { name: "New secret", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByLabel("Visible to")).toHaveCount(0);
  await dialog.getByLabel("Slug", { exact: true }).fill("new-fixture");
  await dialog.getByLabel("Name", { exact: true }).fill("Shared fixture");
  await dialog.getByLabel("Value", { exact: true }).fill("test-only-value");
  await dialog.getByRole("button", { name: "Create secret", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(saved).toMatchObject({ slug: "new-fixture", name: "Shared fixture", value: "test-only-value" });
  expect(saved).not.toHaveProperty("engine");
});

function quickDefaults(): Record<"codex" | "claude" | "grok", ModelDefaultsValue> {
  return {
    grok: {
      engine: "grok", model: "grok-4.6", reasoning_effort: "high", context_window: 256_000,
      catalog: [
        { model: "grok-4.6", persistent_efforts: ["low", "medium", "high", "xhigh"], default_effort: "high", context_windows: [256_000, 500_000], default_context_window: 256_000 },
        { model: "grok-4.5", persistent_efforts: ["low", "medium", "high"], default_effort: "high", context_windows: [256_000, 500_000], default_context_window: 256_000 },
      ],
    },
    codex: {
      engine: "codex", model: "gpt-6-astra", reasoning_effort: "ultra",
      catalog: [
        { model: "gpt-6-astra", persistent_efforts: ["low", "medium", "high", "xhigh", "max", "ultra"], default_effort: "medium" },
        { model: "gpt-6-luna", persistent_efforts: ["low", "medium", "high", "xhigh", "max"], default_effort: "medium" },
        { model: "gpt-5.6-sol", persistent_efforts: ["low", "medium", "high", "xhigh", "max", "ultra"], default_effort: "low" },
        { model: "gpt-5.3-codex-spark", persistent_efforts: ["low", "medium", "high", "xhigh"], default_effort: "high" },
      ],
    },
    claude: {
      engine: "claude", model: "claude-fable-5-1", reasoning_effort: "high",
      catalog: [
        { model: "claude-fable-5-1", persistent_efforts: ["low", "medium", "high", "xhigh"], default_effort: "high" },
        { model: "claude-opus-5-5", persistent_efforts: ["low", "medium", "high", "xhigh"], default_effort: "medium" },
        { model: "claude-sonnet-4-6", persistent_efforts: ["low", "medium", "high"], default_effort: "high" },
        { model: "claude-haiku-4-5-20251001", persistent_efforts: [], default_effort: null },
      ],
    },
  };
}

test("quick settings save model and catalog effort together for both engines and survive reload", async ({ page }) => {
  const defaults = quickDefaults();
  const writes: unknown[] = [];
  await installFixtures(page, (path, body) => {
    const engine = path.split("/").at(-1) as "codex" | "claude" | "grok";
    if (!path.startsWith("/admin/model-defaults/")) return;
    if (body) { writes.push({ engine, body }); Object.assign(defaults[engine], body); }
    return { ...defaults[engine] };
  });
  await page.goto("/admin/engines#defaults");
  const codex = page.getByRole("region", { name: "Codex", exact: true });
  const claude = page.getByRole("region", { name: "Claude", exact: true });
  await expect(codex.getByRole("radio", { name: "Ultra", exact: true })).toBeChecked({ timeout: 15_000 });
  await codex.getByRole("radio", { name: "GPT-6 Astra", exact: true }).locator("..").click();
  expect(writes).toEqual([]);
  await codex.getByRole("radio", { name: "GPT-6 Luna", exact: true }).locator("..").click();
  await expect(codex.getByRole("radio", { name: "Medium Default", exact: true })).toBeChecked();
  await expect(codex.getByRole("radio", { name: "Ultra", exact: true })).toHaveCount(0);
  await expect(codex.getByRole("status")).toHaveText("Saved");
  await codex.getByRole("radio", { name: "Max", exact: true }).locator("..").click();
  await expect(codex.getByRole("status")).toHaveText("Saved");
  await claude.getByRole("radio", { name: "Opus 5.5", exact: true }).locator("..").click();
  await expect(claude.getByRole("radio", { name: "Medium Default", exact: true })).toBeChecked();
  await expect(claude.getByRole("radio", { name: "Max", exact: true })).toHaveCount(0);
  await expect(claude.getByRole("status")).toHaveText("Saved");
  await claude.getByRole("radio", { name: "Sonnet 4.6", exact: true }).locator("..").click();
  await expect(claude.getByRole("radio", { name: "Extra high", exact: true })).toHaveCount(0);
  await expect(claude.getByRole("status")).toHaveText("Saved");
  await claude.getByRole("radio", { name: "Haiku 4.5", exact: true }).locator("..").click();
  await expect(claude.getByText("No effort setting", { exact: true })).toBeVisible();
  await expect(claude.getByRole("status")).toHaveText("Saved");
  expect(writes).toEqual([
    { engine: "codex", body: { model: "gpt-6-luna", reasoning_effort: "medium" } },
    { engine: "codex", body: { model: "gpt-6-luna", reasoning_effort: "max" } },
    { engine: "claude", body: { model: "claude-opus-5-5", reasoning_effort: "medium" } },
    { engine: "claude", body: { model: "claude-sonnet-4-6", reasoning_effort: "high" } },
    { engine: "claude", body: { model: "claude-haiku-4-5-20251001", reasoning_effort: null } },
  ]);
  await page.reload();
  await expect(codex.getByRole("radio", { name: "Max", exact: true })).toBeChecked();
  await expect(claude.getByRole("radio", { name: "Haiku 4.5", exact: true })).toBeChecked();
  await claude.getByRole("radio", { name: "Fable 5.1", exact: true }).locator("..").click();
  await expect(claude.getByRole("radio", { name: "High Default", exact: true })).toBeChecked();
});

test("quick settings save Grok context windows, retain them across model and effort changes, and survive reload", async ({ page }) => {
  const defaults = quickDefaults();
  const writes: unknown[] = [];
  await installFixtures(page, (path, body) => {
    if (path !== "/admin/model-defaults/grok") return;
    if (body) { writes.push(body); Object.assign(defaults.grok, body); }
    return { ...defaults.grok };
  });
  await page.goto("/admin/engines#defaults");
  const grok = page.getByRole("region", { name: "Grok", exact: true });
  const window256 = grok.getByRole("radio", { name: "256k tokens Default", exact: true });
  const window500 = grok.getByRole("radio", { name: "500k tokens", exact: true });
  await expect(window256).toBeChecked();
  for (const engine of ["Codex", "Claude"]) {
    await expect(page.getByRole("region", { name: engine, exact: true }).getByRole("group", { name: "Context window" })).toHaveCount(0);
  }
  await window256.locator("..").click();
  expect(writes).toEqual([]);
  await window256.focus();
  await page.keyboard.press("ArrowRight");
  await expect(window500).toBeChecked();
  await expect(grok.getByRole("status")).toHaveText("Saved");
  await expect(window500).toBeFocused();
  await grok.getByRole("radio", { name: "Low", exact: true }).locator("..").click();
  await expect(grok.getByRole("status")).toHaveText("Saved");
  await grok.getByRole("radio", { name: "Grok 4.5", exact: true }).locator("..").click();
  await expect(grok.getByRole("status")).toHaveText("Saved");
  await expect(window500).toBeChecked();
  expect(writes).toEqual([
    { model: "grok-4.6", reasoning_effort: "high", context_window: 500_000 },
    { model: "grok-4.6", reasoning_effort: "low", context_window: 500_000 },
    { model: "grok-4.5", reasoning_effort: "high", context_window: 500_000 },
  ]);
  await page.reload();
  await expect(window500).toBeChecked();
  await window256.locator("..").click();
  await expect(grok.getByRole("status")).toHaveText("Saved");
  await page.reload();
  await expect(window256).toBeChecked();
});

test("quick settings reconcile failed Grok window saves and follow live context updates", async ({ page }) => {
  const defaults = quickDefaults();
  let emit: ((data: string) => void) | undefined;
  let finishWrite: (() => void) | undefined;
  await page.routeWebSocket("**/context-ws", ws => { emit = data => ws.send(data); });
  await installFixtures(page, path => {
    if (path === "/admin/ws/info") return { enabled: true, url: "ws://127.0.0.1:4173/context-ws" };
    if (path === "/admin/model-defaults/grok") return { ...defaults.grok };
  });
  await page.route("**/admin/model-defaults/grok", async route => {
    if (route.request().method() !== "POST") return route.fallback();
    await new Promise<void>(resolve => { finishWrite = resolve; });
    return route.fulfill({ status: 409, json: { message: "Configuration changed elsewhere" } });
  });
  await page.goto("/admin/engines#defaults");
  const grok = page.getByRole("region", { name: "Grok", exact: true });
  const window500 = grok.getByRole("radio", { name: "500k tokens", exact: true });
  await window500.locator("..").click();
  await expect.poll(() => Boolean(finishWrite)).toBe(true);
  await expect(window500).toBeDisabled();
  await expect(grok.getByRole("radio", { name: "Low", exact: true })).toBeDisabled();
  await expect(page.getByRole("region", { name: "Codex", exact: true }).getByRole("radio").first()).toBeEnabled();
  finishWrite!();
  await expect(grok.getByRole("alert")).toContainText("Configuration changed elsewhere");
  await expect(grok.getByRole("radio", { name: "256k tokens Default", exact: true })).toBeChecked();
  await expect(window500).toBeEnabled();
  defaults.grok.context_window = 500_000;
  await expect.poll(() => Boolean(emit)).toBe(true);
  emit!(JSON.stringify({ type: "settings.changed", payload: {}, ts: new Date().toISOString() }));
  await expect(window500).toBeChecked();
});

test("quick settings isolate saving, follow live updates, and ignore stale reads during a write", async ({ page }) => {
  const defaults = quickDefaults();
  let emit: ((data: string) => void) | undefined;
  let finishWrite: (() => void) | undefined;
  let writes = 0;
  await page.routeWebSocket("**/quick-ws", (ws) => { emit = (data) => ws.send(data); });
  await installFixtures(page, (path) => {
    if (path === "/admin/ws/info") return { enabled: true, url: "ws://127.0.0.1:4173/quick-ws" };
    if (path.startsWith("/admin/model-defaults/")) return { ...defaults[path.split("/").at(-1) as "codex" | "claude" | "grok"] };
  });
  await page.route("**/admin/model-defaults/codex", async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    writes++;
    await new Promise<void>((resolve) => { finishWrite = resolve; });
    Object.assign(defaults.codex, route.request().postDataJSON());
    await route.fulfill({ json: defaults.codex });
  });
  await page.goto("/admin/engines#defaults");
  const codex = page.getByRole("region", { name: "Codex", exact: true });
  const claude = page.getByRole("region", { name: "Claude", exact: true });
  await expect.poll(() => Boolean(emit)).toBe(true);
  defaults.codex.reasoning_effort = "high";
  emit!(JSON.stringify({ type: "settings.changed", payload: {}, ts: new Date().toISOString() }));
  await expect(codex.getByRole("radio", { name: "High", exact: true })).toBeChecked();
  await codex.getByRole("radio", { name: "GPT-6 Luna", exact: true }).locator("..").click();
  await expect.poll(() => Boolean(finishWrite)).toBe(true);
  await expect(codex.getByRole("radio", { name: "Max", exact: true })).toBeDisabled();
  await expect(claude.getByRole("radio", { name: "Opus 5.5", exact: true })).toBeEnabled();
  const refreshed = page.waitForResponse((response) => response.url().endsWith("/admin/model-defaults/codex") && response.request().method() === "GET");
  emit!(JSON.stringify({ type: "settings.changed", payload: {}, ts: new Date().toISOString() }));
  await refreshed;
  await expect(codex.getByRole("radio", { name: "GPT-6 Luna", exact: true })).toBeChecked();
  await expect(codex.getByRole("status")).toHaveText("Saving…");
  finishWrite!();
  await expect(codex.getByRole("status")).toHaveText("Saved");
  await expect(codex.getByRole("radio", { name: "Medium Default", exact: true })).toBeChecked();
  expect(writes).toBe(1);
});

test("quick settings recover failed saves and keep controls locked until authoritative refresh succeeds", async ({ page }) => {
  const defaults = quickDefaults();
  let failed = false;
  let readsFail = true;
  await installFixtures(page, (path) => {
    if (path.startsWith("/admin/model-defaults/")) return { ...defaults[path.split("/").at(-1) as "codex" | "claude" | "grok"] };
  });
  await page.route("**/admin/model-defaults/codex", async (route) => {
    if (route.request().method() === "POST") {
      failed = true;
      return route.fulfill({ status: 409, json: { status: "error", message: "Configuration changed elsewhere" } });
    }
    if (failed && readsFail) return route.fulfill({ status: 503, json: { status: "error", message: "Temporarily unavailable" } });
    return route.fallback();
  });
  await page.goto("/admin/engines#defaults");
  const codex = page.getByRole("region", { name: "Codex", exact: true });
  await codex.getByRole("radio", { name: "GPT-6 Luna", exact: true }).locator("..").click();
  await expect(codex.getByRole("alert").filter({ hasText: "Could not save" })).toContainText("Configuration changed elsewhere");
  await expect(codex.getByRole("radio", { name: "GPT-6 Astra", exact: true })).toBeChecked();
  await expect(codex.getByRole("radio", { name: "GPT-6 Luna", exact: true })).toBeDisabled();
  await expect(codex.getByRole("button", { name: "Retry Codex defaults" })).toBeEnabled();
  defaults.codex.reasoning_effort = "low";
  readsFail = false;
  await codex.getByRole("button", { name: "Retry Codex defaults" }).click();
  await expect(codex.getByRole("radio", { name: "Low", exact: true })).toBeChecked();
  await expect(codex.getByRole("radio", { name: "GPT-6 Luna", exact: true })).toBeEnabled();
});

test("quick settings support keyboard selection, mobile layout, themes, and palette navigation", async ({ page }, info) => {
  const defaults = quickDefaults();
  await installFixtures(page, (path, body) => {
    if (!path.startsWith("/admin/model-defaults/")) return;
    const engine = path.split("/").at(-1) as "codex" | "claude" | "grok";
    if (body) Object.assign(defaults[engine], body);
    return { ...defaults[engine] };
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/admin/engines#defaults");
  const codex = page.getByRole("region", { name: "Codex", exact: true });
  await codex.getByRole("radio", { name: "GPT-6 Astra", exact: true }).focus();
  await page.keyboard.press("ArrowRight");
  await expect(codex.getByRole("radio", { name: "GPT-6 Luna", exact: true })).toBeChecked();
  await expect(codex.getByRole("status")).toHaveText("Saved");
  await expect(codex.getByRole("radio", { name: "GPT-6 Luna", exact: true })).toBeFocused();
  await page.keyboard.press("Tab");
  await page.keyboard.press("ArrowRight");
  await expect(codex.getByRole("radio", { name: "High", exact: true })).toBeChecked();
  await expect(codex.getByRole("status")).toHaveText("Saved");
  for (const theme of ["light", "dark"]) {
    await page.evaluate((theme) => document.documentElement.classList.toggle("dark", theme === "dark"), theme);
    for (const width of [1440, 390, 320]) {
      await page.setViewportSize({ width, height: 1000 });
      await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      await expectNoSeriousAxeFindings(page);
      if (width !== 320) await page.screenshot({ path: info.outputPath(`engines-defaults-${theme}-${width}.png`), fullPage: true });
    }
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.keyboard.press("Control+K");
  await page.getByRole("combobox", { name: "Search fleet and commands" }).fill("Engines");
  await expect(page.getByRole("option", { name: /Go to Engines/ })).toBeVisible();
});

test("every canonical destination deep-links into a bounded desktop workspace", async ({ page }) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(`${page.url()}: ${error.stack ?? error.message}`));

  for (const destination of CANONICAL_DESTINATIONS) {
    await page.goto(`/admin${destination.path}`);
    await expect(page.getByRole("heading", { name: destination.heading, level: 1, exact: true })).toBeVisible({
      timeout: 15_000,
    });
    await expect(page).toHaveTitle(`${destination.title} · Codex Orchestrator`);
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
      .toBe(true);
  }

  expect(pageErrors).toEqual([]);
});

test("desktop shell exposes direct task navigation and the command palette", async ({ page }) => {
  for (const width of [1440, 1920]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/admin/dashboard");
    await expect(page.getByRole("heading", { name: "Overview" })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText("Codex CLI update available", { exact: true })).toHaveCount(0);
    await expect(page.getByRole("navigation", { name: "Breadcrumb" }).getByText("Overview", { exact: true })).toBeVisible();
  }

  // The rail is nine flat hubs with no disclosure; every page is one tab away.
  const primary = page.getByRole("navigation", { name: "Primary navigation" });
  const hubs: Array<[string, string]> = [
    ["Overview", "/admin/dashboard"], ["Hosts", "/admin/hosts"], ["Agents", "/admin/agents"], ["Projects", "/admin/projects"],
    ["Coordination", "/admin/agent-messaging"], ["Activity", "/admin/activity"],
    ["Providers", "/admin/accounts"], ["Library", "/admin/library"], ["Access & Settings", "/admin/access"],
  ];
  for (const [name, href] of hubs) {
    await expect(primary.getByRole("link", { name, exact: true })).toHaveAttribute("href", href);
  }
  await expect(primary.getByRole("button")).toHaveCount(0);
  const hubPages: Array<[string, string, string[]]> = [
    ["Coordination", "/admin/agent-messaging", ["Messages", "Timed wake-ups", "Git merges", "Shared files"]],
    ["Activity", "/admin/activity", ["Activity", "Reports"]],
    ["Providers", "/admin/accounts", ["Accounts", "Engines"]],
    ["Access & Settings", "/admin/access", ["Access", "Settings"]],
  ];
  for (const [hub, path, pages] of hubPages) {
    await page.goto(path);
    const tabs = page.getByRole("navigation", { name: `${hub} pages` });
    for (const label of pages) await expect(tabs.getByRole("link", { name: label, exact: true })).toBeVisible();
  }
  await page.goto("/admin/quick-settings");
  await expect(page).toHaveURL(/\/admin\/engines#defaults$/);
  await expect(page.getByRole("heading", { name: "Engines", level: 1 })).toBeVisible();
  await expect(page.locator("#defaults")).toBeVisible();

  await page.keyboard.press("Control+K");
  await expect(page.getByRole("combobox", { name: "Search fleet and commands" })).toBeVisible();
  await page.getByRole("combobox", { name: "Search fleet and commands" }).fill("Agents");
  await page.getByRole("option", { name: /Go to Agents Running agents/ }).click();
  await expect(page).toHaveURL(/\/admin\/agents$/);
  await expect(page.getByRole("heading", { name: "Agents", exact: true, level: 1 })).toBeVisible();
  await page.keyboard.press("Control+K");
  await page.getByRole("combobox", { name: "Search fleet and commands" }).fill("password");
  await page.getByRole("option", { name: /Password & passkeys/ }).click();
  await expect(page).toHaveURL(/\/admin\/account#security$/);
  await page.keyboard.press("Control+K");
  await page.getByRole("combobox", { name: "Search fleet and commands" }).fill("Agent Portal");
  await expect(page.getByRole("option", { name: /Agent Portal/ })).toHaveCount(0);
});

test("dashboard renders while setup infrastructure checks are pending", async ({ page }) => {
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  let requests = 0;
  await page.route("**/admin/setup/status", async route => {
    requests++;
    await pending;
    await route.fulfill({ json: {
      ...fixture("/admin/setup/status"), owner_created: true, hosts: { total: 3, synced: 3 },
      wizard: { completed_at: null, dismissed_at: null, last_step: null, engines: null },
    } });
  });
  try {
    await page.goto("/admin/dashboard");
    await expect(page.getByRole("heading", { name: "Overview", level: 1 })).toBeVisible({ timeout: 3_000 });
    await expect.poll(() => requests).toBe(1);
    await page.getByRole("link", { name: "Hosts", exact: true }).first().click();
    await expect(page).toHaveURL(/\/admin\/hosts$/);
    await expect(page.getByRole("heading", { name: "Hosts", level: 1 })).toBeVisible();
    expect(requests).toBe(1);
  } finally {
    release();
  }
  await expect(page).toHaveURL(/\/admin\/hosts$/);
});

test("a first-run fleet still enters setup after the background check", async ({ page }) => {
  await installFixtures(page, path => path === "/admin/setup/status" ? {
    ...fixture(path), owner_created: true, hosts: { total: 0, synced: 0 },
    next_actions: [{ id: "first_host", complete: false, label: "Register the first host", href: "/admin/hosts" }],
    wizard: { completed_at: null, dismissed_at: null, last_step: null, engines: null },
  } : undefined);
  await page.goto("/admin/dashboard");
  await expect(page).toHaveURL(/\/admin\/setup$/);
  await expect(page.getByRole("heading", { name: "Set up Codex Orchestrator" })).toBeVisible();
});

test("an existing fleet skips automatic first-run setup without wizard history", async ({ page }) => {
  await installFixtures(page, path => path === "/admin/setup/status" ? {
    ...fixture(path), owner_created: true, hosts: { total: 3, synced: 3 },
    next_actions: [{ id: "auth_claude", complete: false, label: "Seed Claude", href: "/admin/setup?step=auth" }],
    wizard: { completed_at: null, dismissed_at: null, last_step: null, engines: null },
  } : undefined);
  await page.goto("/admin/dashboard");
  await expect(page.getByRole("heading", { name: "Overview", level: 1 })).toBeVisible();
  await expect(page).toHaveURL(/\/admin\/dashboard$/);
  await page.goto("/admin/setup");
  await expect(page).toHaveURL(/\/admin\/dashboard$/);
  await expect(page.getByRole("heading", { name: "Overview", level: 1 })).toBeVisible();
  // Explicit setup links still work for revisiting an optional step.
  await page.goto("/admin/setup?step=engines");
  await expect(page.getByRole("heading", { name: "Set up Codex Orchestrator" })).toBeVisible();
});

test("a completed fleet returns from a bare setup URL while a new fleet keeps its wizard", async ({ page }) => {
  let total = 130;
  await installFixtures(page, path => path === "/admin/setup/status" ? {
    ...fixture(path), owner_created: true, hosts: { total, synced: total },
    canonical_auth: { codex: true, claude: true, grok: true }, default_engines: ["codex"],
    wizard: { completed_at: total ? "2026-08-03T20:03:33Z" : null, dismissed_at: null, last_step: "host", engines: [] },
  } : undefined);
  await page.goto("/admin/setup");
  await expect(page).toHaveURL(/\/admin\/dashboard$/);
  await expect(page.getByRole("heading", { name: "Overview", level: 1 })).toBeVisible();
  total = 0;
  await page.goto("/admin/setup");
  await expect(page.getByRole("heading", { name: "Register your first host" })).toBeVisible();
  await expect(page).toHaveURL(/\/admin\/setup$/);
});

test("failed initial auth status preserves the route instead of opening setup", async ({ page }) => {
  await page.route("**/admin/auth/status", (route) => route.fulfill({ status: 503,
    contentType: "application/json", body: JSON.stringify({ status: "error", message: "Database unavailable" }) }));
  await page.goto("/admin/dashboard");
  await expect(page.getByRole("heading", { name: "API unreachable", exact: true })).toBeVisible();
  await expect(page).toHaveURL(/\/admin\/dashboard$/);
  await expect(page.getByRole("heading", { name: "Set up Codex Orchestrator" })).toHaveCount(0);
});

test("daily navigation keeps the rail flat and preserves access on desktop and mobile", async ({ page }, info) => {
  await page.goto("/admin/dashboard");
  const primary = page.getByRole("navigation", { name: "Primary navigation" });
  for (const name of ["Overview", "Agents", "Projects", "Hosts", "Coordination", "Activity", "Providers", "Library", "Access & Settings"]) {
    await expect(primary.getByRole("link", { name, exact: true })).toBeVisible();
  }
  await page.screenshot({ path: info.outputPath("workspace-desktop.png") });
  await primary.getByRole("link", { name: "Activity", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Activity", level: 1 })).toBeVisible();
  await expect(primary.getByRole("link", { name: "Activity", exact: true })).toHaveAttribute("aria-current", "page");
  await page.goto("/admin/activity?type=tools");
  await expect(primary.getByRole("link", { name: "Activity", exact: true })).toHaveAttribute("aria-current", "page");
  await page.goto("/admin/topology");
  await expect(primary.getByRole("link", { name: "Agents", exact: true })).toHaveAttribute("aria-current", "page");

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/admin/dashboard");
  const mobile = page.getByRole("navigation", { name: "Mobile primary navigation" });
  await expect(mobile.getByRole("link", { name: "Agents", exact: true })).toBeVisible();
  await expect(mobile.getByRole("link", { name: "Activity", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Open navigation menu" }).click();
  await page.screenshot({ path: info.outputPath("workspace-mobile-menu.png") });
  await page.getByRole("dialog").getByRole("link", { name: /^Activity/ }).click();
  await expect(page.getByRole("heading", { name: "Activity", level: 1 })).toBeVisible();
});

test("the Library type filter switches from Skills to Agent rules with a legacy host list", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.goto("/admin/library");
  await expect(page.getByRole("heading", { name: "Library", level: 1, exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Skills", exact: true })).toHaveAttribute("aria-current", "page");

  await page.getByRole("navigation", { name: "Library content type" }).getByRole("link", { name: "Agent rules" }).click();

  await expect(page).toHaveURL(/\/admin\/library\/agent-rules$/);
  await expect(page.getByRole("heading", { name: "Agent rules", level: 1, exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Preview effective draft" })).toBeEnabled();
  expect(pageErrors).toEqual([]);
});

test("rendered AGENTS preview is a document and copies its exact Markdown", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto("/admin/library/agent-rules");
  await expect(page.getByRole("heading", { name: "Agent rules", level: 1, exact: true })).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByRole("switch", { name: "Fleet identity (required)" })).toBeDisabled();
  await expect(page.getByRole("switch", { name: "Security and trust boundaries" })).toBeChecked();
  await page.getByRole("switch", { name: "Security and trust boundaries" }).click();
  await expect(page.getByRole("switch", { name: "Security and trust boundaries" })).not.toBeChecked();
  await page.getByRole("button", { name: "Preview effective draft" }).click();

  const dialog = page.getByRole("dialog", { name: "Effective AGENTS.md draft" });
  await expect(dialog).toBeVisible();
  const document = dialog.getByRole("article", { name: "Effective AGENTS.md draft document" });
  await expect(document.getByRole("heading", { name: "Fleet policy", level: 2 })).toBeVisible();
  await expect(document.getByText("Preserve unrelated changes.")).toBeVisible();
  await expect(document.getByRole("region", { name: "Rendered AGENTS.md content" })).toHaveAttribute(
    "tabindex",
    "0",
  );
  await expect(dialog.getByRole("textbox", { name: "Current rendered AGENTS.md preview" })).toHaveCount(0);
  await expectNoSeriousAxeFindings(page);

  await dialog.getByRole("button", { name: "Copy document" }).click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(RENDERED_AGENTS_CONTENT);
});

test("every setting updates the effective preview without a button press", async ({ page }) => {
  // The render answer embeds the settings it was asked about, so an assertion on
  // the preview text is an assertion that the change actually reached the server
  // and came back — not merely that something re-rendered.
  await installFixtures(page, (pathname, body) => {
    if (pathname !== "/admin/agents/render") return undefined;
    const sent = (body ?? {}) as {
      security_levels?: Record<string, number>;
      composition?: { enabled_modules?: string[]; custom_instructions?: string };
    };
    const autonomy = sent.security_levels?.autonomy ?? "?";
    const modules = sent.composition?.enabled_modules?.length ?? 0;
    const custom = sent.composition?.custom_instructions ?? "";
    return {
      ...fixture(pathname),
      content: `# Fleet policy\n\nautonomy=${autonomy} modules=${modules} custom=${custom}\n`,
    };
  });

  await page.goto("/admin/library/agent-rules");
  const preview = page.getByRole("region", { name: "Effective AGENTS.md preview content" });
  await expect(preview).toContainText("autonomy=3 modules=3", { timeout: 15_000 });

  // A posture slider — the setting that reached no preview at all before.
  await page.getByRole("slider", { name: "Working without asking level" }).focus();
  await page.keyboard.press("ArrowRight");
  await expect(preview).toContainText("autonomy=4", { timeout: 10_000 });

  // A module switch.
  await page.getByRole("switch", { name: "Security and trust boundaries" }).click();
  await expect(preview).toContainText("modules=2", { timeout: 10_000 });

  // And free text.
  await page.getByRole("textbox", { name: "Custom instructions" }).fill("no reactors");
  await expect(preview).toContainText("custom=no reactors", { timeout: 10_000 });

  await expect(page.getByRole("button", { name: "Refresh" })).toHaveCount(0);
});

test("the generation master switch reaches the effective preview without a button press", async ({ page }) => {
  // The mode never travels in the render request — the server reads it from
  // fleet settings — so the fixture holds it the same way, and the preview text
  // is evidence that the POST landed and a fresh render came back for it.
  let mode = "managed";
  await installFixtures(page, (pathname, body) => {
    if (pathname === "/admin/agents-generation-mode") {
      const sent = (body ?? {}) as { mode?: string };
      if (sent.mode) mode = sent.mode;
      return { status: "ok", mode, modes: ["managed", "manual", "off"] };
    }
    if (pathname === "/admin/agents") return { ...fixture(pathname), generation_mode: mode };
    if (pathname !== "/admin/agents/render") return undefined;
    const sent = (body ?? {}) as { composition?: { enabled_modules?: string[] } };
    // Standing in for the server, which composes the draft with no modules at
    // `off` and hands the rest of the document over unchanged.
    const modules = mode === "off" ? 0 : sent.composition?.enabled_modules?.length ?? 0;
    return { ...fixture(pathname), content: `# Fleet policy\n\nmode=${mode} modules=${modules}\n` };
  });

  await page.goto("/admin/library/agent-rules");
  const preview = page.getByRole("region", { name: "Effective AGENTS.md preview content" });
  await expect(preview).toContainText("mode=managed modules=3", { timeout: 15_000 });

  // Generation mode lives behind Advanced.
  await page.getByText("Document generation mode", { exact: true }).click();
  await page.getByRole("button", { name: "Disabled", exact: true }).click();
  await expect(preview).toContainText("mode=off modules=0", { timeout: 10_000 });
  // The selection is kept and visibly inert, not erased.
  await expect(page.getByRole("switch", { name: "Security and trust boundaries" })).toBeChecked();
  await expect(page.getByRole("switch", { name: "Security and trust boundaries" })).toBeDisabled();

  await page.getByRole("button", { name: "Generated", exact: true }).click();
  await expect(preview).toContainText("mode=managed modules=3", { timeout: 10_000 });
  await expect(page.getByRole("switch", { name: "Security and trust boundaries" })).toBeEnabled();

  // Manual swaps the editor for the raw document, seeded from what is served.
  await page.getByRole("button", { name: "Manual", exact: true }).click();
  const raw = page.getByRole("textbox", { name: "Hand-written Markdown document" });
  await expect(raw).toBeVisible();
  await expect(raw).toHaveValue("## Operating Contract (FAST)\n\nExecute and verify.\n");

  await expect(page.getByRole("button", { name: "Refresh" })).toHaveCount(0);
});

test("manual mode stores the bytes in the textarea, not the composed document", async ({ page }) => {
  // The dangerous direction of the switch: the builder is still holding a
  // composition, and Save must not write it over what the operator typed.
  let stored: unknown;
  await installFixtures(page, (pathname, body) => {
    if (pathname === "/admin/agents-generation-mode") return { status: "ok", mode: "manual", modes: ["managed", "manual", "off"] };
    if (pathname === "/admin/agents") return { ...fixture(pathname), generation_mode: "manual" };
    if (pathname !== "/admin/agents/store") return undefined;
    stored = body;
    return { status: "ok", version_id: 56, sha256: "f".repeat(64) };
  });

  await page.goto("/admin/library/agent-rules");
  const raw = page.getByRole("textbox", { name: "Hand-written Markdown document" });
  // Opens on the served base even though the stored version was built.
  await expect(raw).toHaveValue("## Operating Contract (FAST)\n\nExecute and verify.\n", { timeout: 15_000 });
  await expect(page.getByRole("switch", { name: "Security and trust boundaries" })).toHaveCount(0);

  await raw.fill("# House rules\n\nMine, by hand.\n");
  // The canonical pane is "what this editor stores", so it follows the textarea
  // rather than the composition the builder is still holding.
  await page.getByRole("button", { name: "Canonical base" }).click();
  await expect(page.getByRole("heading", { name: "Stored canonical base" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Generated AGENTS.md base content" })).toContainText("House rules");

  // `.first()`: the header Save precedes any posture or verbosity Save.
  await page.getByRole("button", { name: "Save" }).first().click();
  await expect.poll(() => stored).toEqual({ content: "# House rules\n\nMine, by hand.\n" });
});

test("a preview that cannot render says so once, in the pane, not once per keystroke", async ({ page }) => {
  // Every settings change mints a new query key, so a failing render fails again
  // for each one. As toasts that is a stream of them, and the place the operator
  // is looking would still show a stale document with nothing to explain it.
  let renders = 0;
  await installFixtures(page);
  await page.route("**/admin/agents/render", async (route) => {
    renders += 1;
    return route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "boom" }) });
  });

  // Toasts auto-dismiss, so asserting a count of zero after the fact merely
  // waits for them to disappear and always passes. Count them as they arrive.
  await page.addInitScript(() => {
    (window as unknown as { __toasts: number }).__toasts = 0;
    const watch = (): void => {
      new MutationObserver((records) => {
        for (const record of records) {
          for (const node of record.addedNodes) {
            if (!(node instanceof HTMLElement)) continue;
            if (node.matches("[data-sonner-toast]") || node.querySelector("[data-sonner-toast]")) {
              (window as unknown as { __toasts: number }).__toasts += 1;
            }
          }
        }
      }).observe(document.documentElement, { childList: true, subtree: true });
    };
    if (document.documentElement) watch();
    else document.addEventListener("DOMContentLoaded", watch);
  });

  await page.goto("/admin/library/agent-rules");
  const field = page.getByRole("textbox", { name: "Custom instructions" });
  await expect(field).toBeVisible({ timeout: 15_000 });
  for (const value of ["a", "ab", "abc", "abcd"]) await field.fill(value);

  await expect(page.getByText(/showing the last document that rendered/)).toHaveCount(1, { timeout: 10_000 });
  expect(await page.evaluate(() => (window as unknown as { __toasts: number }).__toasts)).toBe(0);
  // No retry storm either: a failed key is not retried three more times.
  expect(renders).toBeLessThanOrEqual(6);
});

test("a setting and the text it produces are visually linked, both ways", async ({ page }) => {
  await installFixtures(page, (pathname) =>
    pathname === "/admin/agents/render"
      ? {
          ...fixture(pathname),
          content: PROVENANCE_DOC,
          provenance: PROVENANCE_ENTRIES,
          axis_sections: { autonomy: ["hard_stops"], verification_waiver: ["hard_stops"] },
        }
      : undefined,
  );

  await page.goto("/admin/library/agent-rules");
  const preview = page.getByRole("region", { name: "Effective AGENTS.md preview content" });
  await expect(preview.getByRole("heading", { name: "Security and Trust Boundaries" })).toBeVisible({
    timeout: 15_000,
  });

  const active = preview.locator("[data-provenance-active]");
  await expect(active).toHaveCount(0);

  // Setting → text.
  await page.getByRole("group", { name: "Security and trust boundaries" }).hover();
  await expect(preview.locator('[data-provenance="module:security"][data-provenance-active]')).toHaveCount(2);
  await expect(preview.locator('[data-provenance="module:operating_contract"][data-provenance-active]')).toHaveCount(
    0,
  );
  // The separator between two modules belongs to neither of them.
  await expect(preview.locator("hr[data-provenance]")).toHaveCount(0);
  // Nothing is dimmed, and the title above the first block stays unattributed.
  await expect(preview.locator("h1[data-provenance]")).toHaveCount(0);
  await expectNoSeriousAxeFindings(page);

  // An axis names every section it reaches, and says how many.
  const axisRow = page.getByRole("group", { name: "Working without asking" });
  await expect(axisRow).toContainText("contributes to 1 block");
  await axisRow.hover();
  await expect(preview.locator('[data-provenance="policy:hard_stops"][data-provenance-active]')).toHaveCount(2);

  // Text → setting: a shared block outlines every axis feeding it, not one.
  await preview.getByRole("heading", { name: "Hard Stop Lines" }).hover();
  await expect(page.getByRole("group", { name: "Working without asking" })).toHaveClass(/ring-2/);
  await expect(page.getByRole("group", { name: "Skipping verification" })).toHaveClass(/ring-2/);
});

test("the Projects page carries the coordination switch in its header and the board switch in settings", async ({ page }) => {
  // The board shipped once with its API, its client functions and its tests all
  // present and NOTHING rendering the switch — so the only way to enable it was
  // SQL, while the MCP error told operators to use the console. Nothing caught
  // that, because every layer below the page was green.
  // The POST has to actually move the stored value, or the optimistic update
  // reverts on the refetch and the assertion below would pass for the wrong
  // reason — or flake.
  let boardOn = false;
  await installFixtures(page, (pathname, body) => {
    if (pathname !== "/admin/project-board/state") return undefined;
    const sent = (body ?? {}) as { enabled?: boolean };
    if (typeof sent.enabled === "boolean") boardOn = sent.enabled;
    return { enabled: boardOn, boards: 7, cards: 6, claimed: 1, updated_at: "2026-08-27T09:00:00Z" };
  });

  await page.goto("/admin/projects");
  await expect(page.getByLabel("Project coordination")).toBeChecked();

  // The board switch sits behind the gear, not above the project list.
  await page.getByRole("button", { name: "Project settings" }).click();
  const board = page.getByLabel("Project board");
  await expect(board).toBeVisible();
  await expect(board).not.toBeChecked();
  // Says what turning it off does NOT do, which is the surprising part.
  await expect(page.getByText(/Todos keep working either way/)).toBeVisible();

  await board.click();
  await expect(board).toBeChecked();
  await expect(page.getByText(/6 cards, 1 currently held/)).toBeVisible();
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
  await expect(dialog.getByRole("link", { name: /Library/ })).toBeVisible();
  for (const label of ["Messages", "Timed wake-ups", "Git merges", "Shared files"]) {
    await expect(dialog.getByRole("link", { name: new RegExp(label) })).toBeVisible();
  }
  await expect(dialog.getByRole("link", { name: /Agent Portal/ })).toHaveCount(0);
  await dialog.getByRole("link", { name: /Timed wake-ups/ }).click();
  await expect(page.getByRole("heading", { name: "Timed wake-ups", exact: true })).toBeVisible();
  await expect(dialog).toHaveCount(0);
});

test("hosts list leads with a one-line fleet strip and a compact table", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/admin/hosts");
  await expect(page.getByRole("heading", { name: "Hosts", level: 1 })).toBeVisible();
  await expect(page.getByText("need attention", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Add host", exact: true })).toBeVisible();

  const hostRow = page.getByRole("row").filter({ hasText: "console.example.test" });
  await expect(hostRow).toBeVisible();
  await expect(hostRow).toContainText("192.0.2.20 · #1");
  const desktopBox = await hostRow.boundingBox();
  expect(desktopBox).not.toBeNull();
  expect(desktopBox!.height).toBeLessThanOrEqual(64);
  await expectNoSeriousAxeFindings(page);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await expect(hostRow).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test("neutral configuration template has no serious Axe findings", async ({ page }) => {
  await page.goto("/admin/account#appearance");
  await expect(page.getByRole("heading", { name: "Appearance" })).toBeVisible();
  await expect(page.getByText("System", { exact: true })).toBeVisible();
  await expect(page.getByText("Light", { exact: true })).toBeVisible();
  await expect(page.getByText("Dark", { exact: true })).toBeVisible();

  await expectNoSeriousAxeFindings(page);
});

test("Claude client settings use one full-width operator workflow", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/admin/engines#claude-client");
  await expect(page.getByRole("heading", { name: "Engines", level: 1 })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Claude client settings", level: 3 })).toBeVisible();
  await expect(page.getByText("Fleet configuration", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Environment variables", level: 3 })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Permissions", level: 3 })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Hooks", level: 3 })).toBeVisible();
  await expect(page.getByRole("heading", { name: "settings.json preview", level: 3 })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "NAME" })).toHaveValue("OPERATIONS_MODE");
  await expect(page.getByText('"OPERATIONS_MODE": "managed"')).toBeVisible();
  await expect(page.getByRole("button", { name: "Save changes" })).toBeVisible();
  await expectNoSeriousAxeFindings(page);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await expect(page.getByRole("heading", { name: "Claude client settings", level: 3 })).toBeVisible();
  await expect(page.getByRole("button", { name: "Save changes" })).toBeVisible();
});

test("engine policy settings stay sequential and show the effective scaling tier", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/admin/engines#quota-enforcement");

  await expect(page.getByRole("heading", { name: "Usage limits", level: 2 })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Usage-based scaling", level: 2 })).toBeVisible();
  await expect(page.getByLabel("At %")).toHaveValue("75");
  await expect(page.locator("#scaling")).toContainText(/Current state:\s*active/);
  await expect(page.locator("#scaling")).toContainText(/Effective tier:\s*75%/);
  await expect(page.locator("#scaling")).toContainText(/Lane:\s*spark/);

  const quotaBox = await page.locator("#quotas").boundingBox();
  const scalingBox = await page.locator("#scaling").boundingBox();
  expect(quotaBox).not.toBeNull();
  expect(scalingBox).not.toBeNull();
  expect(scalingBox!.y).toBeGreaterThanOrEqual(quotaBox!.y + quotaBox!.height);
  expect(Math.abs(quotaBox!.x - scalingBox!.x)).toBeLessThanOrEqual(1);
  expect(Math.abs(quotaBox!.width - scalingBox!.width)).toBeLessThanOrEqual(1);
  await expectNoSeriousAxeFindings(page);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await expect(page.getByRole("heading", { name: "Usage-based scaling", level: 2 })).toBeVisible();
  await expect(page.getByRole("button", { name: "Save scaling" })).toBeVisible();
});

test("account is one page with profile, security, appearance and devices sections", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/admin/account");
  await expect(page.getByRole("heading", { name: "Account", level: 1 })).toBeVisible();
  const sections = page.locator("main").getByRole("heading", { level: 2 });
  await expect(sections).toHaveText(["Profile", "Security", "Appearance", "Android devices"]);
  for (const id of ["profile", "security", "appearance", "devices"]) await expect(page.locator(`section#${id}`)).toBeVisible();
  await expect(page.getByRole("form", { name: "Change password" })).toBeVisible();
  await expect(page.getByLabel("Current password")).toBeVisible();
  await expect(page.getByRole("table", { name: "Registered passkeys" })).toBeVisible();
  await expect(page.getByText("Operator laptop", { exact: true })).toBeVisible();
  await expect(page.getByText("Hardware key", { exact: true })).toBeVisible();
  await expect(page.getByRole("radio", { name: /System/ })).toBeVisible();
  await expectNoSeriousAxeFindings(page);

  // Retired sub-pages land on their section. Needs `routes/[...legacy]/+page.ts` to stop
  // reading `url.hash` in `load` (SvelteKit throws), which today breaks every retired URL.
  await page.goto("/admin/account/passkeys");
  await expect(page).toHaveURL(/\/admin\/account#security$/);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await expect(page.getByRole("heading", { name: "Security", level: 2 })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test("the user menu reaches each account section", async ({ page }) => {
  await page.goto("/admin/dashboard");
  await page.getByRole("button", { name: /Account menu for/ }).click();
  for (const name of ["Password & passkeys", "Appearance", "Android devices"]) {
    await expect(page.getByRole("menuitem", { name })).toBeVisible();
  }
  await page.getByRole("menuitem", { name: "Android devices" }).click();
  await expect(page).toHaveURL(/\/admin\/account#devices$/);
});

test("project detail and standalone approval keep their task-focused layouts", async ({ page }) => {
  await page.goto("/admin/authoring/agents");
  await expect(page).toHaveURL(/\/admin\/library\/agent-rules$/);
  await expect(page.getByRole("heading", { name: "Agent rules", level: 1 })).toBeVisible();

  // A project opens on its board; About and the roster live behind the header button.
  await page.goto("/admin/projects/fleet-console");
  await expect(page).toHaveURL(/\/admin\/projects\/fleet-console\/board$/);
  await expect(page.getByRole("heading", { name: "Fleet console", level: 1 })).toBeVisible();
  await page.getByRole("button", { name: "About", exact: true }).click();
  const about = page.getByRole("dialog");
  await expect(about.getByRole("heading", { name: "About", level: 2, exact: true })).toBeVisible();
  await expect(about.getByRole("heading", { name: "Roster", level: 2 })).toBeVisible();
  await expect(about.getByLabel("Title")).toHaveValue("Fleet console");
  await expect(about.getByRole("button", { name: "Save", exact: true }).first()).toBeDisabled();
  await expectNoSeriousAxeFindings(page);

  await page.goto("/admin/cli-auth/verify");
  await expect(page.getByRole("heading", { name: "Approve CLI session" })).toBeVisible();
  await expect(page.getByLabel("Device code")).toBeVisible();
  await expect(page.getByRole("button", { name: "Look up" })).toBeDisabled();
  await expectNoSeriousAxeFindings(page);
});

test("host detail orders problems, engines and access before a collapsed Advanced block", async ({ page }) => {
  await page.goto("/admin/hosts/1");
  await expect(page.getByRole("heading", { name: "console.example.test", level: 1 })).toBeVisible();
  await expect(page.getByRole("tab")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Get install command" })).toBeVisible();
  const headings = await page.locator("main").getByRole("heading", { level: 2 }).allTextContents();
  expect(headings.slice(0, 4)).toEqual(["Needs attention", "Engines", "Access", "Delete host"]);
  const advanced = page.getByTestId("host-advanced");
  await expect(advanced).not.toHaveAttribute("open", "");
  await advanced.locator(":scope > summary").click();
  for (const name of ["Network and IP", "Per-host exceptions", "Fleet behaviour and integrations"]) {
    await expect(page.getByRole("heading", { name, level: 3 })).toBeVisible();
  }
  await expect(page.getByText("Reverse DNS lookup", { exact: true })).toBeVisible();
  await expectNoSeriousAxeFindings(page);
});

test("project peer views keep records dense, readable, and inspectable", async ({ page }) => {
  // Todos became the board in migration 0026. The old URL is kept as a redirect
  // rather than a 404: it is in browser history and in muscle memory, and a
  // missing page reads as the work having disappeared.
  await page.goto("/admin/projects/fleet-console/todos");
  await expect(page).toHaveURL(/\/admin\/projects\/fleet-console\/board$/);
  await expect(page.getByRole("region", { name: "Backlog" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Refresh runner image", level: 4 })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Capture baseline", level: 4 })).toBeVisible();
  // A lane says which role it expects, and shows the holder of a claimed card —
  // the two things the board exists to make visible that a todo list could not.
  await expect(page.getByText("expects code", { exact: true })).toBeVisible();
  await expect(page.getByText(/code · chris on crane\.example/)).toBeVisible();
  await expect(page.getByText(/Claim reclaimed/)).toBeVisible();

  // Notes and files share one Documents list; the old URLs keep their filter.
  await page.goto("/admin/projects/fleet-console/notes");
  await expect(page).toHaveURL(/\/admin\/projects\/fleet-console\/documents\?kind=notes$/);
  await expect(page.getByRole("button", { name: "Rollout note", exact: true })).toBeVisible();

  await page.goto("/admin/projects/fleet-console/files");
  await expect(page).toHaveURL(/\/admin\/projects\/fleet-console\/documents\?kind=files$/);
  await expect(page.getByRole("table")).toBeVisible();
  await expect(page.getByText("docs/rollout.md", { exact: true })).toBeVisible();

  await page.goto("/admin/projects/fleet-console/feedback");
  await expect(page).toHaveURL(/\/admin\/projects\/fleet-console\/reports$/);
  await expect(page.getByText(/1 of 1 reports · 1 open/)).toBeVisible();
  await expect(page.getByRole("button", { name: /Runner label is stale/ })).toBeVisible();

  await page.goto("/admin/projects/fleet-console/activity");
  await page.getByRole("button", { name: /todo\.updated/ }).click();
  await expect(page.getByText("Entity:", { exact: true })).toBeVisible();
  await expectNoSeriousAxeFindings(page);
});

function controlAccount(id: number, engine: string, label: string, usage: Record<string, unknown>) {
  const now = new Date().toISOString();
  return {
    id, engine, label, state: "enabled", verification_state: "verified", verification_reason: null, verification_checked_at: now,
    generation: 1, sessions: [], plan: { name: "Pro", source: "chatgpt_usage", observed_at: now, stale: false },
    usage: { supported: true, stale: false, fetched_at: now, short_used_percent: null, short_resets_at: null, weekly_used_percent: null, weekly_resets_at: null, ...usage },
  };
}

/** Populated provider and fleet fixtures for the operational dashboard. */
function controlFixture(path: string): Record<string, unknown> | undefined {
  const now = new Date().toISOString();
  switch (path) {
    case "/admin/overview":
      return {
        totals: { hosts: 12 }, last_refresh: now,
        versions: { cdx_version_available: "0.125.0", claude_version_available: "2.1.170", cdx_version_checked_at: now, claude_version_checked_at: now },
        version_distribution: { codex: [{ version: "0.125.0", count: 9 }], claude: [{ version: "2.1.170", count: 8 }], install: { both: 6, codex_only: 3, claude_only: 2, neither: 1 } },
      };
    case "/admin/accounts":
      return { accounts: [
        controlAccount(1, "codex", "ChatGPT", { weekly_used_percent: 42, weekly_limit_seconds: 604800, weekly_resets_at: new Date(Date.now() + 3 * 86_400_000).toISOString() }),
        controlAccount(2, "claude", "Claude", { short_used_percent: 27, short_limit_seconds: 18000, weekly_used_percent: 61, weekly_limit_seconds: 604800 }),
      ] };
    case "/admin/runner":
      return { runner: { configured: true, ready: true, detail: "Verification sidecar is available", engines: { codex: { state: "ok", last_check: now, last_ok: now }, claude: { state: "fail", last_check: now, last_error: "Canonical credentials need verification" } } } };
    default:
      return undefined;
  }
}

test("control dashboard is accessible with both engines at desktop and mobile sizes", async ({ page }, info) => {
  test.setTimeout(90_000);
  await installFixtures(page, controlFixture);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  for (const [width, scheme] of [[1440, "light"], [1440, "dark"], [768, "light"], [390, "light"], [390, "dark"]] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.setViewportSize({ width, height: 1000 });
    await page.goto("/admin/dashboard");
    await expect(page.getByRole("heading", { name: "Overview", level: 1 })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole("tab")).toHaveText(["Provider", "Engines", "Runner"]);
    await expect(page.getByRole("heading", { name: "Provider usage", level: 2 })).toBeVisible();
    await expect(page.getByRole("table", { name: "Provider accounts and their quota usage" }).getByRole("meter")).toHaveCount(3);
    await page.getByRole("tab", { name: "Engines" }).click();
    const engines = page.getByRole("table", { name: "Engine installs and latest versions" });
    await expect(engines.getByRole("row", { name: /Codex/ })).toContainText("9 of 12");
    await expect(engines.getByRole("row", { name: /Claude/ })).toContainText("8 of 12");
    await expect(engines.getByRole("row", { name: /Grok/ })).toContainText("No data");
    await expect(page.getByText("No CLI version reported by 1 host.", { exact: false })).toBeVisible();
    await page.getByRole("tab", { name: "Runner" }).click();
    const claudeRunner = page.getByRole("list", { name: "Verification by engine" }).getByRole("listitem").filter({ hasText: "Claude" });
    await expect(claudeRunner).toContainText("Canonical credentials need verification");
    await expect(page.getByRole("link", { name: "Add host" })).toBeVisible();
    await expect.poll(() => page.evaluate(() => {
      const main = document.querySelector("main")!;
      return main.scrollWidth <= main.clientWidth && document.documentElement.scrollWidth <= innerWidth;
    })).toBe(true);
    await expectNoSeriousAxeFindings(page);
    await page.screenshot({ path: info.outputPath(`dashboard-${width}-${scheme}.png`), fullPage: true });
  }
  expect(errors).toEqual([]);
});

test("Grok account usage shows real periods and follows live updates without inventing zero", async ({ page }) => {
  test.setTimeout(60_000);
  let used = 5;
  let period = "weekly";
  let stale = false;
  let available = true;
  const resetsAt = new Date(Date.now() + 604_800_000).toISOString();
  let emit: ((data: string) => void) | undefined;
  await page.routeWebSocket("**/grok-usage-ws", ws => { emit = data => ws.send(data); });
  await installFixtures(page, path => {
    if (path === "/admin/ws/info") return { enabled: true, url: "ws://127.0.0.1:4173/grok-usage-ws" };
    if (path === "/admin/accounts") return { accounts: [{
      id: 7, engine: "grok", label: "Personal", state: "enabled", verification_state: "verified", sessions: [],
      usage: { supported: true, fetched_at: new Date().toISOString(), checked_at: new Date().toISOString(),
        stale, error_code: stale ? "provider_http_503" : null,
        short_used_percent: null, short_resets_at: null, weekly_used_percent: null, weekly_resets_at: null,
        current_window: available ? { used_percent: used, period, starts_at: null, resets_at: resetsAt, shared: true } : null,
      },
    }] };
    return controlFixture(path);
  });
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.goto("/admin/dashboard");
    const group = page.getByRole("group", { name: "Personal Grok usage" });
    await expect(group.getByRole("meter", { name: "Weekly usage" })).toHaveAttribute("aria-valuenow", "5");
    await expect(group).not.toContainText("Shared across");
    await expect(group.locator("time").first()).toHaveAttribute("datetime", resetsAt);
    await expect(group).not.toContainText("Short window");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await expectNoSeriousAxeFindings(page);
  }
  const group = page.getByRole("group", { name: "Personal Grok usage" });
  await expect.poll(() => Boolean(emit)).toBe(true);
  const update = () => emit!(JSON.stringify({ type: "accounts.updated", payload: { account_id: 7 }, ts: new Date().toISOString() }));
  used = 0;
  update();
  await expect(group.getByRole("meter")).toHaveAttribute("aria-valuenow", "0");
  await expect(group).toContainText("0% used");
  period = "monthly";
  update();
  await expect(group.getByRole("meter", { name: "Monthly usage" })).toBeVisible();
  stale = true;
  update();
  await expect(page.getByRole("row", { name: /Personal/ })).toContainText("Last known reading");
  await expect(group).toContainText("Update unavailable; showing the last reading.");
  available = false;
  update();
  await expect(group).toContainText("Usage unavailable");
  await expect(group.getByRole("meter")).toHaveCount(0);
});

test("Grok usage on Accounts retains unknown state and supports dark mode", async ({ page }) => {
  let observed = false;
  await page.emulateMedia({ colorScheme: "dark" });
  await page.setViewportSize({ width: 390, height: 844 });
  await installFixtures(page, path => path === "/admin/accounts" ? { accounts: [{
    id: 7, engine: "grok", label: "Personal", state: "enabled", verification_state: "verified", sessions: [],
    usage: { supported: true, stale: !observed, fetched_at: observed ? new Date().toISOString() : null,
      checked_at: null, short_used_percent: null, short_resets_at: null, weekly_used_percent: null, weekly_resets_at: null,
      current_window: observed ? { used_percent: 75, period: null, starts_at: null, resets_at: null, shared: null } : null },
  }] } : undefined);
  await page.goto("/admin/accounts");
  const group = page.getByRole("group", { name: "Personal Grok usage" });
  await expect(group).toContainText("Waiting for usage data");
  await expect(group.getByRole("meter")).toHaveCount(0);
  observed = true;
  await page.reload();
  await expect(group.getByRole("meter", { name: "Current period" })).toHaveAttribute("aria-valuenow", "75");
  await expect(group).toContainText("Reset time unavailable");
  await expect(group).not.toContainText("Weekly");
  await expectNoSeriousAxeFindings(page);
});

test("accounts lists every provider with an always-visible engine filter", async ({ page }) => {
  let total = 6;
  await installFixtures(page, path => path === "/admin/auth/status" ? { ...fixture(path), capabilities: ["auth.manage"] } : path === "/admin/accounts" ? {
    accounts: Array.from({ length: total }, (_, i) => ({
      id: i + 1, engine: ["codex", "claude", "grok"][i % 3], label: `Subscription ${i + 1}`,
      state: i === 5 ? "paused" : "enabled", verification_state: "verified",
      verification_reason: null, verification_checked_at: null, generation: 1, sessions: [],
      usage: { supported: false, fetched_at: null, stale: false, short_used_percent: null,
        short_resets_at: null, weekly_used_percent: null, weekly_resets_at: null },
    })),
  } : undefined);
  const rows = page.getByRole("row", { name: /Subscription/ });
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.goto("/admin/accounts");
    await expect(rows).toHaveCount(6);
    await expect(page.getByRole("button", { name: "ChatGPT", exact: true })).toBeVisible();
    await expect(rows.filter({ hasText: "Subscription 2" })).toContainText("Claude");
    await expect(rows.filter({ hasText: "Subscription 3" })).toContainText("Grok");
    await expect(rows.filter({ hasText: "Subscription 6" })).toContainText("Paused");
    await expectNoSeriousAxeFindings(page);
  }
  await page.getByRole("button", { name: "Add account", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText("Engine");
  await expect(page.getByRole("dialog").getByRole("radio", { name: "Grok", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  total = 7;
  await page.reload();
  await page.getByRole("button", { name: "Grok", exact: true }).click();
  await expect(rows).toHaveCount(2);
  await expect(rows.filter({ hasText: "Subscription 3" })).toHaveCount(1);
  total = 0;
  await page.reload();
  await expect(page.getByText("No Grok accounts", { exact: true })).toBeVisible();
});

test("host table engine chips show assignments and fleet suspension on desktop and mobile", async ({ page }) => {
  let suspended = false;
  await installFixtures(page, path => path === "/admin/engines/state" ? {
    engines: ["codex", "claude", "grok"].map(engine => ({
      engine, enabled: !(suspended && engine === "claude"), updated_at: null, updated_by: null, assigned_hosts: 1,
    })),
  } : undefined);
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.goto("/admin/hosts");
    const row = page.getByRole("row").filter({ hasText: "console.example.test" });
    await expect(row).toBeVisible();
    await expect(row.getByRole("img", { name: /^Codex: ready/ }).filter({ visible: true })).toHaveCount(1);
    await expect(row.getByRole("img", { name: /^Claude: ready/ }).filter({ visible: true })).toHaveCount(1);
    // Engines the host does not run get no chip at all.
    await expect(row.getByRole("img", { name: /^Grok:/ })).toHaveCount(0);
    await expect(row.getByRole("img", { name: /^Codex: ready/ }).filter({ visible: true })).toContainText("Codex");
    await expect(row.getByRole("img", { name: /^Codex: ready/ }).filter({ visible: true }).locator("span").first()).toHaveClass(/bg-success/);
    await expectNoSeriousAxeFindings(page);
  }
  suspended = true;
  await page.reload();
  const row = page.getByRole("row").filter({ hasText: "console.example.test" });
  await expect(row.getByRole("img", { name: /^Claude: disabled fleet-wide/ }).filter({ visible: true })).toHaveCount(1);
  await expect(row.getByRole("img", { name: /^Claude: disabled fleet-wide/ }).filter({ visible: true })).toHaveAttribute("data-state", "inactive");
});

test("engine table reports independent counts, zeroes, and unavailable snapshots", async ({ page }) => {
  let hosts = 130;
  let available = true;
  let counts = { codex: 121, claude: 30, grok: 2 };
  let unreported = 9;
  await installFixtures(page, path => path === "/admin/overview" ? {
    ...controlFixture(path), totals: { hosts },
    version_distribution: available ? {
      codex: [], claude: [], grok: [], engine_counts: counts,
      install_combinations: [{ engines: [], count: unreported }],
      install: { both: 0, codex_only: 0, claude_only: 0, neither: 0 },
    } : null,
  } : controlFixture(path));
  const coverage = page.locator("section#engines");
  const rows = coverage.getByRole("row");
  await page.goto("/admin/dashboard");
  await page.getByRole("tab", { name: "Engines" }).click();
  await expect(rows.nth(1)).toContainText("121 of 130 (93%)");
  await expect(rows.nth(2)).toContainText("30 of 130 (23%)");
  await expect(rows.nth(3)).toContainText("2 of 130 (2%)");
  await expect(coverage).toContainText("No CLI version reported by 9 hosts.");
  await expect(coverage).toContainText("Hosts with several engines count towards each.");
  await expect(coverage.getByText("Codex + Claude", { exact: true })).toHaveCount(0);

  counts = { codex: 130, claude: 0, grok: 0 };
  unreported = 0;
  await page.reload();
  await expect(rows.nth(1)).toContainText("130 of 130 (100%)");
  await expect(rows.nth(2)).toContainText("0 of 130 (0%)");
  await expect(coverage).toContainText("No CLI version reported by 0 hosts.");

  counts = { codex: 0, claude: 0, grok: 0 };
  unreported = 130;
  await page.reload();
  await expect(rows.nth(1)).toContainText("0 of 130 (0%)");
  await expect(coverage).toContainText("No CLI version reported by 130 hosts.");

  hosts = 0;
  await page.reload();
  await expect(coverage).toContainText("Register a host to start building your fleet.");
  await expect(coverage.getByRole("table")).toHaveCount(0);

  available = false;
  await page.reload();
  await expect(coverage).toContainText("Engine coverage is unavailable until a fleet snapshot loads.");
});

test("control overview distinguishes unavailable, stale, and recovered snapshots", async ({ page }) => {
  await installFixtures(page, controlFixture);
  let failed = true;
  await page.route("**/admin/overview", async (route) => route.fulfill({
    status: failed ? 503 : 200, contentType: "application/json",
    body: JSON.stringify(failed ? { status: "error", message: "Snapshot temporarily unavailable" } : controlFixture("/admin/overview")),
  }));
  await page.goto("/admin/dashboard");
  await expect(page.getByText("Could not load fleet overview", { exact: false })).toBeVisible({ timeout: 15_000 });
  await page.getByRole("tab", { name: "Engines" }).click();
  await expect(page.locator("section#engines")).toContainText("unavailable");
  failed = false;
  await page.getByRole("alert").getByRole("button", { name: "Retry", exact: true }).click();
  const engines = page.locator("section#engines");
  await expect(engines.getByRole("row", { name: /Codex/ })).toContainText("9 of 12 (75%)");
  await expect(engines.getByRole("row", { name: /Claude/ })).toContainText("8 of 12 (67%)");
  failed = true;
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(page.getByText("Overview could not refresh", { exact: false })).toBeVisible();
  await expect(engines.getByRole("row", { name: /Codex/ })).toContainText("9 of 12 (75%)");
  failed = false;
  await page.getByRole("alert").getByRole("button", { name: "Retry", exact: true }).click();
  await expect(page.getByText("Overview could not refresh", { exact: false })).toHaveCount(0);
  await expect(engines.getByRole("row", { name: /Codex/ })).toContainText("9 of 12 (75%)");
});

test("control usage preserves missing windows and bounds over-limit meter semantics", async ({ page }) => {
  await installFixtures(page, (path) => {
    if (path === "/admin/accounts") return { accounts: [
      controlAccount(1, "codex", "ChatGPT", {}),
      controlAccount(2, "claude", "Claude", { short_used_percent: 108, short_limit_seconds: 18000 }),
    ] };
    return controlFixture(path);
  });
  await page.goto("/admin/dashboard");
  const usage = page.getByRole("table", { name: "Provider accounts and their quota usage" });
  await expect(usage.getByRole("row", { name: /ChatGPT/ })).toContainText("No quota windows reported");
  await expect(usage.getByRole("meter")).toHaveCount(1);
  await expect(usage.getByRole("meter")).toHaveAttribute("aria-valuenow", "100");
  await expect(usage.getByRole("meter")).toHaveAttribute("aria-valuetext", "108% used");
});

for (const engine of ["codex", "claude"] as const) {
  test(`control ${engine} verification stays engine-scoped and prevents overlapping runs`, async ({ page }) => {
    await installFixtures(page, controlFixture);
    const label = engine === "codex" ? "Codex" : "Claude";
    const other = engine === "codex" ? "Claude" : "Codex";
    const endpoint = engine === "codex" ? "run" : "run-claude";
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    await page.route(`**/admin/runner/${endpoint}`, async (route) => {
      expect(route.request().method()).toBe("POST");
      await gate;
      await route.fulfill({ contentType: "application/json", body: JSON.stringify({ status: "fail", engine, reason: `${label} credential rejected` }) });
    });
    await page.goto("/admin/dashboard");
    await page.getByRole("tab", { name: "Runner" }).click();
    await page.getByRole("button", { name: `Run ${label} runner verification` }).click();
    await expect(page.getByRole("list", { name: "Verification by engine" }).getByRole("listitem").filter({ hasText: label })).toContainText("Verifying…");
    await expect(page.getByRole("button", { name: `Run ${other} runner verification` })).toBeDisabled();
    release();
    await expect(page.getByText(`${label} credential rejected`, { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: `Run ${other} runner verification` })).toBeEnabled();
  });
}

test("control navigation highlights mobile account destinations", async ({ page }) => {
  await page.goto("/admin/dashboard");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/admin/account#appearance");
  const menu = page.getByRole("button", { name: "Open navigation menu" });
  await expect(menu).toHaveAttribute("aria-current", "true");
  await menu.click();
  await expect(page.getByRole("dialog").getByRole("link", { name: "Password & passkeys", exact: true })).toBeVisible();
  await expect(page.getByRole("dialog").getByRole("link", { name: "Appearance", exact: true })).toBeVisible();
  await expect(page.getByRole("dialog").getByRole("link", { name: "Android devices", exact: true })).toBeVisible();
});

test("Agent Messaging uses peer URL-backed operational views", async ({ page }) => {
  await page.goto("/admin/agent-messaging?view=conversations");
  await expect(page.getByRole("heading", { name: "Messages", level: 1 })).toBeVisible();
  await expect(page.getByRole("button", { name: "Conversations", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByText("agent:console ↔ agent:review")).toBeVisible();

  await page.getByRole("button", { name: "Deliveries", exact: true }).click();
  await expect(page).toHaveURL(/view=deliveries/);
  await expect(page).toHaveURL(/conversation_id=11111111-1111-4111-8111-111111111111/);
  await expect(page.getByRole("button", { name: "Delivery log", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("heading", { name: "Delivery log" })).toBeVisible();
  await expect(page.getByLabel("Filter deliveries by conversation UUID")).toHaveValue(
    "11111111-1111-4111-8111-111111111111",
  );

  await page.getByRole("button", { name: "Addresses", exact: true }).click();
  await expect(page).toHaveURL(/view=addresses/);
  await expect(page.getByRole("heading", { name: "Addresses" })).toBeVisible();
  await expect(page.getByText("agent:console", { exact: true })).toBeVisible();
});

test("quota advice settings save centrally and survive reload", async ({ page }) => {
  let stored = { hard_fail: true, limit_percent: 95, week_partition: "off", advice: {
    mode: "ask", high_usage_percent: 85, projected_usage_percent: 100,
    min_pressure_gap: 20, max_age_minutes: 30, remember_day: true,
  } };
  const writes: unknown[] = [];
  await installFixtures(page, (path, body) => {
    if (path !== "/admin/quota-mode") return undefined;
    if (body) { writes.push(body); stored = body as typeof stored; }
    return stored;
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/admin/engines#quota-enforcement");
  const quotas = page.locator("#quotas");
  await expect(page.getByLabel("Maximum measurement age (minutes)")).toHaveValue("30");
  await expect(page.locator("#quota-week-partition")).toContainText("Off");
  await page.locator("#quota-advice-mode").click();
  await page.getByRole("option", { name: "Hint only", exact: true }).click();
  await page.getByLabel("High usage (%)", { exact: true }).fill("90");
  await page.getByLabel("Maximum measurement age (minutes)").fill("15");
  await page.getByRole("switch", { name: "Allow remembering the provider until local midnight" }).click();
  await quotas.getByRole("button", { name: "Save", exact: true }).click();
  await expect.poll(() => writes.length).toBe(1);
  expect(stored).toEqual({ hard_fail: true, limit_percent: 95, week_partition: "off", advice: {
    mode: "hint", high_usage_percent: 90, projected_usage_percent: 100,
    min_pressure_gap: 20, max_age_minutes: 15, remember_day: false,
  } });
  await page.reload();
  await expect(page.locator("#quota-advice-mode")).toContainText("Hint only");
  await expect(page.getByLabel("Maximum measurement age (minutes)")).toHaveValue("15");
  await expect(page.getByRole("switch", { name: "Allow remembering the provider until local midnight" })).not.toBeChecked();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(quotas.getByRole("button", { name: "Save", exact: true })).toBeVisible();
  await expectNoSeriousAxeFindings(page);
});


test("Claude login expiry remains visible with successful verification and clears after renewal", async ({ page }, info) => {
  test.setTimeout(90_000);
  await installFixtures(page, controlFixture);
  let expiryState = "expiring";
  let configured = true;
  await page.route("**/admin/runner", async (route) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({ runner: { configured, ready: configured, detail: configured ? "configured" : "AUTH_RUNNER_URL is not set", engines: {
      codex: { state: "ok", login_expiry: { state: "not_applicable", expires_at: null, days_remaining: null } },
      claude: { state: "ok", login_expiry: { state: expiryState, expires_at: "2026-09-18T12:00:00.000Z", days_remaining: expiryState === "expired" ? 0 : 3 } },
    } } }),
  }));
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.goto("/admin/dashboard");
    await page.getByRole("tab", { name: "Runner" }).click();
    const card = page.getByRole("list", { name: "Verification by engine" }).getByRole("listitem").filter({ hasText: "Claude" });
    await expect(card).toContainText("Claude login expires in 3 days");
    await expect(card.getByText("OK", { exact: true })).toBeVisible();
    await expect(card).toContainText("2026-09-18T12:00:00.000Z");
    await expect(card).toContainText("Run /login in Claude launched through clx.");
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await expectNoSeriousAxeFindings(page);
    await card.screenshot({ path: info.outputPath(`login-expiry-${width}.png`) });
  }
  configured = false;
  await page.reload();
  const claude = page.getByRole("list", { name: "Verification by engine" }).getByRole("listitem").filter({ hasText: "Claude" });
  await expect(claude).toContainText("Claude login expires in 3 days");
  expiryState = "expired";
  await page.reload();
  await expect(claude).toContainText("Claude login expired");
  expiryState = "ok";
  // Existing polling must remove the warning after canonical renewal.
  await expect(claude).not.toContainText("Claude login expired", { timeout: 20_000 });
});

for (const mode of ["triage", "manage"] as const) {
  test(`host approvals open on connected clients and drain in ${mode} mode`, async ({ page, context }) => {
    const clients = [page, await context.newPage()];
    let requests: Record<string, unknown>[] = [];
    const emitters: ((data: string) => void)[] = [];
    let reads = 0;
    const broadcast = (type: string, payload = {}) => {
      for (const emit of emitters) emit(JSON.stringify({ type, payload, ts: new Date().toISOString() }));
    };
    for (const client of clients) {
      await client.routeWebSocket("**/approvals-ws", (ws) => { emitters.push((data) => ws.send(data)); });
      await installFixtures(client, (path) => {
        if (path === "/admin/hosts/insecure") return { hosts: [], domains: [], domains_active: 0 };
        if (path === "/admin/ws/info") return { enabled: true, url: "ws://127.0.0.1:4173/approvals-ws" };
        if (path === "/admin/insecure-approvals/pending") { reads++; return { requests }; }
        const match = path.match(/\/admin\/insecure-approvals\/(\d+)\/(approve|deny)$/);
        if (match) {
          requests = requests.filter((r) => r.id !== Number(match[1]));
          broadcast(match[2] === "approve" ? "insecure.approved" : "insecure.denied", { request_id: Number(match[1]) });
          return {};
        }
      });
      await client.goto("/admin/engines#defaults");
    }
    await expect.poll(() => emitters.length).toBe(2);
    await expect.poll(() => reads).toBeGreaterThanOrEqual(2);
    const request = (id: number) => ({ id, host_id: id, fqdn: `host${id}.example.test`, status: "pending", live: true,
      requested_at: new Date().toISOString(), expires_at: new Date(Date.now() + 300_000).toISOString() });
    const refresh = async () => {
      const before = reads;
      broadcast("insecure.requested");
      await expect.poll(() => reads).toBeGreaterThanOrEqual(before + 2);
      // Observe the settled render, not only the state before the refetch.
      for (const client of clients) await client.waitForTimeout(200);
    };
    await refresh();
    for (const client of clients) await expect(client.getByRole("dialog")).toBeHidden();
    requests = [{ ...request(1), live: false }];
    await refresh();
    for (const client of clients) await expect(client.getByRole("dialog")).toBeHidden();
    requests = [{ ...request(1), expires_at: new Date(Date.now() - 1000).toISOString() }];
    await refresh();
    for (const client of clients) await expect(client.getByRole("dialog")).toBeHidden();
    // The same request becoming live must now open both clients.
    requests = [request(1)];
    broadcast("insecure.requested");
    for (const client of clients) {
      await expect(client.getByRole("dialog")).toContainText("host1.example.test");
      await client.keyboard.press("Escape");
      await expect(client.getByRole("dialog")).toBeHidden();
    }
    // Replacing an ID without increasing the count must reopen dismissed boxes.
    requests = [request(2)];
    broadcast("insecure.requested");
    for (const client of clients) {
      await expect(client.getByRole("dialog")).toContainText("host2.example.test");
      if (mode === "manage") {
        await client.keyboard.press("Escape");
        await client.evaluate(() => window.dispatchEvent(new Event("codex:open-insecure-approvals")));
        await expect(client.getByRole("dialog")).toBeVisible();
      }
    }
    requests = [...requests, request(3)];
    broadcast("insecure.requested");
    for (const client of clients) await expect(client.getByRole("dialog")).toContainText("host3.example.test");
    await page.getByRole("dialog").getByRole("button", { name: "Approve for 8 hours" }).first().click();
    for (const client of clients) await expect(client.getByRole("dialog")).toBeVisible();
    await expect(page.getByRole("dialog").getByRole("button", { name: "Deny", exact: true })).toHaveCount(1);
    await page.getByRole("dialog").getByRole("button", { name: "Deny", exact: true }).click();
    for (const client of clients) await expect(client.getByRole("dialog")).toBeHidden();
    if (mode === "manage") {
      await page.evaluate(() => window.dispatchEvent(new Event("codex:open-insecure-approvals")));
      await expect(page.getByRole("dialog")).toContainText("No host is waiting for access.");
    }
  });
}


test("Grok quick defaults honor model-specific effort and persist across reload", async ({ page }) => {
  const defaults = quickDefaults();
  const writes: unknown[] = [];
  await installFixtures(page, (path, body) => {
    if (path !== "/admin/model-defaults/grok") return;
    if (body) { writes.push(body); Object.assign(defaults.grok, body); }
    return { ...defaults.grok };
  });
  await page.goto("/admin/engines#defaults");
  const grok = page.getByRole("region", { name: "Grok", exact: true });
  await expect(grok.getByRole("radio", { name: "High Default", exact: true })).toBeChecked();
  await grok.getByRole("radio", { name: "Extra high", exact: true }).locator("..").click();
  await expect(grok.getByRole("status")).toHaveText("Saved");
  await grok.getByRole("radio", { name: "Grok 4.5", exact: true }).locator("..").click();
  await expect(grok.getByRole("radio", { name: "Extra high", exact: true })).toHaveCount(0);
  await expect(grok.getByRole("radio", { name: "High Default", exact: true })).toBeChecked();
  await expect(grok.getByRole("status")).toHaveText("Saved");
  expect(writes).toEqual([{ model: "grok-4.6", reasoning_effort: "xhigh", context_window: 256_000 }, { model: "grok-4.5", reasoning_effort: "high", context_window: 256_000 }]);
  await page.reload();
  await expect(grok.getByRole("radio", { name: "Grok 4.5", exact: true })).toBeChecked();
});

test("Access shows the Grok text gateway and issues a scoped client key", async ({ page }) => {
  const writes: Array<{ path: string; body: unknown }> = [];
  await installFixtures(page, (path, body) => {
    if (body && (path.startsWith("/admin/grok/") || path === "/admin/api/surfaces/grok")) {
      writes.push({ path, body });
      if (path === "/admin/grok/keys") return { key: "fake-gateway-token", record: { id: 3, name: "Grok test", is_active: true, created_at: "2026-10-01T00:00:00Z", expires_at: null } };
      if (path.startsWith("/admin/grok/models/")) return { model: "grok-4.5", enabled: false };
      return { disabled: true };
    }
  });
  await page.goto("/admin/access");
  await page.getByRole("button", { name: "API endpoints", exact: true }).click();
  await expect(page.locator('[data-endpoint="grok"]').getByText(/127\.0\.0\.1:4173\/grok\/v1/)).toBeVisible();
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Configure", exact: true }).click();
  await page.getByRole("switch", { name: "Enable /grok/v1", exact: true }).click();
  await page.locator("#grok-proxy > summary").click();
  await expect(page.getByText("Streaming, tools, images, sampling controls, and token limits are unavailable.", { exact: false })).toBeVisible();
  await expect(page.getByRole("switch", { name: "Grok 4.7", exact: true })).toBeChecked();
  await page.getByRole("switch", { name: "Grok 4.5", exact: true }).click();
  await expect.poll(() => writes.some(w => w.path === "/admin/grok/models/grok-4.5/toggle")).toBe(true);
  await page.getByRole("group", { name: "Filter keys by API" }).getByRole("button", { name: "Grok", exact: true }).click();
  await page.getByRole("button", { name: "New key", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("button", { name: "API format", exact: true })).toContainText("Grok");
  await dialog.getByRole("button", { name: "Engine", exact: true }).click();
  await page.getByRole("option", { name: "Grok", exact: true }).click();
  await dialog.getByRole("textbox", { name: "Name", exact: true }).fill("Grok test");
  await dialog.getByRole("button", { name: "Create key" }).click();
  await expect.poll(() => writes.some(w => w.path === "/admin/grok/keys")).toBe(true);
  expect(writes).toContainEqual({ path: "/admin/api/surfaces/grok", body: { disabled: true } });
  expect(writes).toContainEqual({ path: "/admin/grok/keys", body: { name: "Grok test", backend_engine: "grok", expires_at: null } });
  expect(writes).toContainEqual({ path: "/admin/grok/models/grok-4.5/toggle", body: { enabled: false } });
});


test("engine master switch confirms both edges and reverts on cancel", async ({ page }) => {
  const writes: Array<{ path: string; body: unknown }> = [];
  const state = { grok: true };
  await installFixtures(page, (path, body) => {
    if (path === "/admin/auth/status") return { ...fixture(path), capabilities: ["settings.read", "settings.manage"] };
    if (path === "/admin/engines/state") {
      const base = fixture(path) as { engines: Array<Record<string, unknown>> };
      return { engines: base.engines.map((row) => (row.engine === "grok" ? { ...row, enabled: state.grok } : row)) };
    }
    if (path === "/admin/engines/grok/state" && body) {
      writes.push({ path, body });
      state.grok = (body as { enabled: boolean }).enabled;
      return { ...fixture(path), enabled: state.grok, previous: !state.grok };
    }
  });
  await page.goto("/admin/engines#engine-state");
  const grok = page.getByRole("switch", { name: "Grok (cgx)", exact: true });
  await expect(grok).toBeChecked();

  // Cancel must not leave the switch flipped.
  await grok.click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("heading", { name: "Disable Grok for the fleet" })).toBeVisible();
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(grok).toBeChecked();
  expect(writes).toEqual([]);

  // Confirm disables, and the Grok section says so while staying editable.
  await grok.click();
  await page.getByRole("dialog").getByRole("button", { name: "Disable Grok", exact: true }).click();
  await expect.poll(() => writes.length).toBe(1);
  expect(writes[0]).toEqual({ path: "/admin/engines/grok/state", body: { enabled: false } });
  await expect(grok).not.toBeChecked();
  await expect(page.locator("#grok-defaults").getByText("Disabled fleet-wide", { exact: true })).toBeVisible();

  // Enabling confirms too.
  await grok.click();
  await expect(page.getByRole("dialog").getByRole("heading", { name: "Enable Grok for the fleet" })).toBeVisible();
  await page.getByRole("dialog").getByRole("button", { name: "Enable Grok", exact: true }).click();
  await expect.poll(() => writes.length).toBe(2);
  expect(writes[1]).toEqual({ path: "/admin/engines/grok/state", body: { enabled: true } });
  await expect(grok).toBeChecked();
});

test("host engine switches support all seven combinations and preserve one enabled engine", async ({ page }) => {
  const detail = fixture("/admin/hosts/1/detail") as { host: Record<string, unknown>; overview: unknown };
  const host = { ...detail.host, engines: "grok", engines_list: ["grok"], grok_canonical_digest: "grok-auth", grok_client_version: "1.0.46", grok_wrapper_version: "2.4.0" };
  const writes: unknown[] = [];
  await installFixtures(page, (path, body) => {
    if (path === "/admin/hosts/1/engines" && body) {
      writes.push(body);
      const engines = (body as { engines: string[] }).engines;
      host.engines_list = engines; host.engines = engines.join(",");
      return { status: "ok" };
    }
    if (path === "/admin/hosts/1/detail") return { ...detail, host };
  });
  await page.goto("/admin/hosts/1");
  await expect(page.getByRole("switch", { name: "Grok engine", exact: true })).toBeChecked();
  await expect(page.getByRole("switch", { name: "Grok engine", exact: true })).toBeDisabled();
  const all = ["Codex", "Claude", "Grok"];
  for (const target of [["Codex", "Grok"], ["Codex"], ["Codex", "Claude"], ["Claude"], ["Claude", "Grok"], all, ["Grok"]]) {
    for (const name of target) { const control = page.getByRole("switch", { name: `${name} engine`, exact: true }); if (!await control.isChecked()) await control.click(); await expect(control).toBeChecked(); }
    for (const name of all.filter(name => !target.includes(name))) { const control = page.getByRole("switch", { name: `${name} engine`, exact: true }); if (await control.isChecked()) await control.click(); await expect(control).not.toBeChecked(); }
    if (target.length === 1) await expect(page.getByRole("switch", { name: `${target[0]} engine`, exact: true })).toBeDisabled();
  }
  expect(writes.length).toBeGreaterThanOrEqual(7);
  await page.getByTestId("host-advanced").locator(":scope > summary").click();
  await expect(page.getByRole("region", { name: "Grok engine overrides", exact: true })).toBeVisible();
});


test("Grok host provisioning names its missing credentials and opens subscription upload", async ({ page }) => {
  const detail = fixture("/admin/hosts/1/detail") as { host: Record<string, unknown>; overview: unknown };
  const host = {
    ...detail.host, fqdn: "grok-new.example.test", engines: "grok", engines_list: ["grok"],
    last_refresh: null, claude_last_refresh: null, grok_last_refresh: null,
    last_cron_check: null, grok_canonical_digest: null,
  };
  let registered: unknown;
  await installFixtures(page, (path, body) => {
    if (path === "/admin/setup/status") return {
      ...fixture(path), default_engines: ["grok"],
      canonical_auth: { codex: true, claude: true, grok: false },
    };
    if (path === "/admin/hosts/register") {
      registered = body;
      return { host, installer: { command: "printf 'fake Grok installer'", expires_at: new Date(Date.now() + 3_600_000).toISOString() } };
    }
    if (path === "/admin/hosts/1/detail") return { ...detail, host };
  });
  await page.goto("/admin/hosts?dialog=new-host");
  await expect(page.getByRole("checkbox", { name: /Grok Build \(cgx\)/ })).toBeChecked();
  await page.getByLabel("Hostname (FQDN)").fill("grok-new.example.test");
  await page.getByRole("button", { name: "Register host", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Host registered", exact: true })).toBeVisible();
  expect(registered).toMatchObject({ engines: ["grok"] });
  await expect(page.getByText("The fleet has no Grok credentials yet, so the host cannot sync until they are seeded.", { exact: false })).toBeVisible();
  await page.getByRole("button", { name: "Seed Grok credentials", exact: true }).click();
  await expect(page.getByText("Grok subscription login JSON", { exact: true })).toBeVisible();
  await expect(page.getByText("ChatGPT session auth JSON", { exact: true })).toHaveCount(0);
});

test("setup saves a Grok-only fleet choice and offers subscription credentials", async ({ page }) => {
  const writes: unknown[] = [];
  await installFixtures(page, (path, body) => {
    if (path === "/admin/setup/status") return {
      setup_complete: true, critical_complete: true, owner_created: true, checks: [], next_actions: [],
      canonical_auth: { codex: false, claude: false, grok: false }, default_engines: ["codex"],
      wizard: { engines: null, last_step: "engines", completed_at: null, dismissed_at: null },
    };
    if (path === "/admin/setup/wizard") { writes.push(body); return {}; }
  });
  await page.goto("/admin/setup?step=engines");
  await page.getByRole("button", { name: "None yet", exact: true }).click();
  await page.getByRole("checkbox", { name: "Grok Hosts get the cgx alias.", exact: true }).click();
  await page.getByRole("button", { name: "Save and continue", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Provider credentials", exact: true })).toBeVisible();
  await expect(page.getByText("Grok subscription login JSON", { exact: true })).toBeVisible();
  await expect(page.getByText("xAI API key", { exact: true })).toHaveCount(0);
  expect(writes).toContainEqual({ last_step: "auth", engines: ["grok"] });
});

test("messaging shows all nine engine directions", async ({ page }) => {
  await installFixtures(page, path => {
    if (path !== "/admin/agent-messaging/state") return;
    return { ...fixture(path), directions: ["codex", "claude", "grok"].flatMap(source_engine =>
      ["codex", "claude", "grok"].map(target_engine => ({ source_engine, target_engine, total: 1, pending: 0, completed: 1, dead: 0, ambiguous: 0 }))) };
  });
  await page.goto("/admin/agent-messaging");
  const matrix = page.locator("details").filter({ has: page.locator("summary", { hasText: "Traffic by engine" }) });
  await matrix.locator("summary").click();
  for (const source of ["codex", "claude", "grok"]) for (const target of ["codex", "claude", "grok"]) {
    await expect(matrix.getByText(`${source} → ${target}`, { exact: true })).toBeVisible();
  }
});

// Access puts the daily key list ahead of routing and backend configuration.
const keyFilter = (page: Page) => page.getByRole("group", { name: "Filter keys by API" });

test("Access keeps keys visible, copies endpoints and preserves the vendor filter", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/admin/access");
  await expect(page.getByRole("heading", { name: "API keys", exact: true })).toBeInViewport();
  await expect(page.getByRole("textbox", { name: "Search keys by name or prefix" })).toBeVisible();
  await expect(page.getByRole("switch", { name: "Disable all API traffic" })).not.toBeVisible();
  await expect(page.getByRole("button", { name: "Backend for /v1", exact: true })).not.toBeVisible();
  await page.getByRole("button", { name: "API endpoints", exact: true }).click();
  await page.getByRole("button", { name: "Copy /anthropic/v1 URL", exact: true }).click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe("http://127.0.0.1:4173/anthropic/v1");
  await page.getByRole("button", { name: "Show Anthropic keys" }).click();
  await expect(keyFilter(page).getByRole("button", { name: "Anthropic", exact: true })).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "Configure", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Service availability & routing" })).toBeVisible();
  await expect(page.getByLabel("Proxy default model", { exact: true })).not.toBeVisible();
  await page.getByRole("button", { name: "Configure", exact: true }).click();
  await expect(keyFilter(page).getByRole("button", { name: "Anthropic", exact: true })).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "New key", exact: true }).click();
  await expect(page.getByRole("dialog").getByRole("button", { name: "API format", exact: true })).toContainText("Anthropic");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.locator("[data-sonner-toast]")).toHaveCount(0, { timeout: 10000 });
  await expectNoSeriousAxeFindings(page);
  await page.screenshot({ path: "test-results/access-desktop.png", fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/admin/access");
  await expect(page.getByRole("textbox", { name: "Search keys by name or prefix" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: "test-results/access-mobile.png", fullPage: true });
});

test("Access resolves legacy API anchors and the new-key deep link", async ({ page }) => {
  for (const [anchor, target] of [["service-availability", "#api-state-toggle"], ["exposed-apis", "#api-backend-openai"], ["claude-proxy", "#claude-model"], ["grok-proxy", "#grok-proxy-model"]]) {
    await page.goto(`/admin/access#${anchor}`);
    await expect(page.locator(target)).toBeVisible();
    await expect(page.getByRole("button", { name: "Configure", exact: true })).toHaveAttribute("aria-expanded", "true");
  }
  await page.goto("/admin/access?dialog=new&engine=grok");
  await expect(page.getByRole("dialog").getByRole("button", { name: "API format", exact: true })).toContainText("Grok");
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page).not.toHaveURL(/dialog=new/);
  await expect(keyFilter(page).getByRole("button", { name: "Grok", exact: true })).toHaveAttribute("aria-pressed", "true");
});

test("Access reports disabled and rerouted backends without changing key namespaces", async ({ page }) => {
  await installFixtures(page, (path) => {
    if (path === "/admin/api/surfaces") {
      const data = fixture(path) as { surfaces: Array<Record<string, unknown>> };
      return { ...data, surfaces: data.surfaces.map(row => row.surface === "openai" ? { ...row, backend: "grok" } : row.surface === "anthropic" ? { ...row, disabled: true } : row) };
    }
    if (path === "/admin/engines/state") {
      const data = fixture(path) as { engines: Array<Record<string, unknown>> };
      return { engines: data.engines.map(row => ({ ...row, enabled: row.engine !== "grok" })) };
    }
  });
  await page.goto("/admin/access");
  await page.getByRole("button", { name: "API endpoints", exact: true }).click();
  await expect(page.locator('[data-endpoint="openai"]')).toContainText("Default engine off");
  await expect(page.locator('[data-endpoint="anthropic"]')).toContainText("Disabled");
  await expect(page.locator('[data-endpoint="grok"]')).toContainText("Default engine off");
  await page.getByRole("button", { name: "Show OpenAI keys" }).click();
  await expect(keyFilter(page).getByRole("button", { name: "OpenAI", exact: true })).toHaveAttribute("aria-pressed", "true");
  await installFixtures(page, path => path === "/admin/api/state" ? { disabled: true } : undefined);
  await page.reload();
  await expect(page.getByRole("status").filter({ hasText: "All API traffic is disabled" })).toBeVisible();
  await page.getByRole("button", { name: "API endpoints", exact: true }).click();
  await expect(page.locator('[data-endpoint="openai"]')).toContainText("All traffic off");
});

test("Access reports query errors instead of claiming access is enabled", async ({ page }) => {
  await page.route("**/admin/engines/state", route => route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ message: "status unavailable" }) }));
  await page.goto("/admin/access");
  await page.getByRole("button", { name: "API endpoints", exact: true }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Failed to load API status" })).toBeVisible({ timeout: 15000 });
  await expect(page.locator('[data-endpoint="openai"]')).toContainText("Status unavailable");
  await page.route("**/admin/api/surfaces", route => route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ message: "endpoints unavailable" }) }));
  await page.reload();
  await page.getByRole("button", { name: "API endpoints", exact: true }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Failed to load endpoints" })).toBeVisible({ timeout: 15000 });
});

test("Access retains search, toggle and revoke for issued keys", async ({ page }) => {
  let rows = [{ id: 7, name: "CI runner", key_prefix: "sk-cdx-test", is_active: true, use_count: 12, created_at: "2026-10-01T00:00:00Z", last_used_at: null, expires_at: null }];
  const writes: string[] = [];
  await page.route("**/admin/openai/keys**", async route => {
    const path = new URL(route.request().url()).pathname;
    if (route.request().method() === "POST") { rows[0].is_active = route.request().postDataJSON().active; writes.push(path); }
    if (route.request().method() === "DELETE") { rows = []; writes.push(path); }
    await route.fulfill({ contentType: "application/json", body: JSON.stringify(path.endsWith("/keys") ? rows : { status: "ok" }) });
  });
  await page.goto("/admin/access");
  await expect(page.getByRole("cell", { name: /^CI runner/ })).toBeVisible();
  const search = page.getByRole("textbox", { name: "Search keys by name or prefix" });
  await search.fill("nothing");
  await expect(page.getByText("No matches")).toBeVisible();
  await search.fill("");
  await page.getByRole("switch", { name: "Active: CI runner", exact: true }).click();
  await expect.poll(() => writes).toContain("/admin/openai/keys/7/toggle");
  await expect(page.getByRole("switch", { name: "Active: CI runner", exact: true })).not.toBeChecked();
  await page.getByRole("button", { name: "Actions for CI runner" }).click();
  await page.getByRole("menuitem", { name: "Revoke key" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Revoke key", exact: true }).click();
  await expect.poll(() => writes).toContain("/admin/openai/keys/7");
  await expect(page.getByText("No API keys yet")).toBeVisible();
});

test("Access configuration saves routing and backend defaults and supports keyboard navigation", async ({ page }) => {
  const writes: Array<{ path: string; body: unknown }> = [];
  await installFixtures(page, (path, body) => {
    if (body && ["/admin/api/surfaces/openai", "/admin/claude/settings", "/admin/grok/settings", "/admin/api/state"].includes(path)) {
      writes.push({ path, body });
      return body as Record<string, unknown>;
    }
  });
  await page.goto("/admin/access#configuration");
  await page.getByRole("button", { name: "Backend for /v1", exact: true }).click();
  await page.getByRole("option", { name: "Claude", exact: true }).click();
  await expect.poll(() => writes).toContainEqual({ path: "/admin/api/surfaces/openai", body: { backend: "claude" } });
  await page.locator("#claude-proxy > summary").focus();
  await page.keyboard.press("Enter");
  await page.getByLabel("Max tokens", { exact: true }).fill("4096");
  await page.getByRole("button", { name: "Save proxy defaults" }).click();
  await expect.poll(() => writes).toContainEqual({ path: "/admin/claude/settings", body: { default_model: "claude-sonnet-5", max_tokens: 4096 } });
  await page.locator("#grok-proxy > summary").click();
  await page.getByRole("button", { name: "Save gateway default" }).click();
  await expect.poll(() => writes).toContainEqual({ path: "/admin/grok/settings", body: { default_model: "grok-4.6" } });
  await page.getByRole("switch", { name: "Disable all API traffic" }).click();
  await expect.poll(() => writes).toContainEqual({ path: "/admin/api/state", body: { disabled: true } });
  await page.getByRole("button", { name: "Configure", exact: true }).click();
  await keyFilter(page).getByRole("button", { name: "Anthropic", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(keyFilter(page).getByRole("button", { name: "Anthropic", exact: true })).toHaveAttribute("aria-pressed", "true");
});

test("appearance menu switches light and dark immediately and persists across reload", async ({ page }) => {
  let savedTheme = "auto";
  const writes: string[] = [];
  const pageErrors: string[] = [];
  page.on("pageerror", error => pageErrors.push(error.message));
  await installFixtures(page, (path, body) => {
    if (path !== "/admin/theme") return;
    if (body) { savedTheme = (body as { theme: string }).theme; writes.push(savedTheme); }
    return { theme: savedTheme };
  });
  await page.emulateMedia({ colorScheme: "dark" });
  await page.goto("/admin/dashboard");
  await expect(page.locator("html")).toHaveClass(/dark/);
  for (const choice of ["Light", "Dark"]) {
    await page.getByRole("button", { name: "Appearance", exact: true }).click();
    await expect(page.getByRole("menuitem", { name: choice, exact: true })).toBeVisible();
    await page.getByRole("menuitem", { name: choice, exact: true }).click();
    await expect.poll(() => page.locator("html").evaluate(el => el.classList.contains("dark"))).toBe(choice === "Dark");
    await expect.poll(() => writes.at(-1)).toBe(choice.toLowerCase());
    await page.reload();
    await expect.poll(() => page.locator("html").evaluate(el => el.classList.contains("dark"))).toBe(choice === "Dark");
  }
  await page.goto("/admin/account#appearance");
  await expect(page.getByRole("radio", { name: /Dark/ })).toBeChecked();
  await page.getByRole("button", { name: "Appearance", exact: true }).click();
  await page.getByRole("menuitem", { name: "Light", exact: true }).click();
  await expect(page.getByRole("radio", { name: /Light/ })).toBeChecked();
  await expect.poll(() => writes.at(-1)).toBe("light");
  // Selection updates the theme before the closing menu releases its focus
  // scope. Wait for removal before resizing and opening it with the keyboard.
  await expect(page.getByRole("menuitem", { name: "Light", exact: true })).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "Appearance", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("menuitem", { name: "Light", exact: true })).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(page.getByRole("menuitem", { name: "Dark", exact: true })).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(page.getByRole("menuitem", { name: "System", exact: true })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect.poll(() => writes.at(-1)).toBe("auto");
  await expect(page.getByRole("radio", { name: /System/ })).toBeChecked();
  await expect(page.locator("html")).toHaveClass(/dark/);
  await page.emulateMedia({ colorScheme: "light" });
  await expect(page.locator("html")).not.toHaveClass(/dark/);
  await page.reload();
  await expect(page.getByRole("radio", { name: /System/ })).toBeChecked();
  await expect(page.locator("html")).not.toHaveClass(/dark/);
  expect(pageErrors).toEqual([]);

});

test("appearance menu restores the previous theme when saving fails", async ({ page }) => {
  await page.route("**/admin/theme", route => route.fulfill({
    status: route.request().method() === "POST" ? 503 : 200,
    contentType: "application/json",
    body: JSON.stringify(route.request().method() === "POST" ? { message: "Theme save unavailable" } : { theme: "dark" }),
  }));
  await page.goto("/admin/dashboard");
  await expect(page.locator("html")).toHaveClass(/dark/);
  await page.getByRole("button", { name: "Appearance", exact: true }).click();
  await page.getByRole("menuitem", { name: "Light", exact: true }).click();
  await expect(page.getByText("Could not save appearance", { exact: true })).toBeVisible();
  await expect(page.locator("html")).toHaveClass(/dark/);
  await expect.poll(() => page.evaluate(() => localStorage.getItem("codex.theme"))).toBe("dark");
});


test("new host persistent daemon defaults off, supports key 8 and resets", async ({ page }) => {
  const registrations: Record<string, unknown>[] = [];
  const detail = fixture("/admin/hosts/1/detail") as { host: Record<string, unknown> };
  await installFixtures(page, (path, body) => {
    if (path === "/admin/hosts/register") {
      registrations.push(body as Record<string, unknown>);
      return { host: detail.host, installer: { command: "printf 'fake installer'", expires_at: new Date(Date.now() + 3_600_000).toISOString() } };
    }
  });
  await page.goto("/admin/hosts?dialog=new-host");
  const daemon = page.getByRole("checkbox", { name: /Persistent daemon/ });
  await expect(daemon).not.toBeChecked();
  await page.getByLabel("Hostname (FQDN)").fill("daemon.example.test");
  await daemon.focus();
  await page.keyboard.press("8");
  await expect(daemon).toBeChecked();
  await expect(page.getByText("Requires root and enabled Agent Messaging.", { exact: false })).toBeVisible();
  await page.getByRole("button", { name: "Register host", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Host registered", exact: true })).toBeVisible();
  expect(registrations[0]).toMatchObject({ daemon_enabled: true });
  await expect(page.getByText("Persistent daemon", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Register another", exact: true }).click();
  await expect(daemon).not.toBeChecked();
  await daemon.click();
  await expect(daemon).toBeChecked();
  await daemon.click();
  await expect(daemon).not.toBeChecked();
  await page.getByLabel("Hostname (FQDN)").fill("regular.example.test");
  await page.getByRole("button", { name: "Register host", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Host registered", exact: true })).toBeVisible();
  expect(registrations[1]).toMatchObject({ daemon_enabled: false });
  await expect(page.getByText("Persistent daemon", { exact: true })).toHaveCount(0);
});


test("setup host registration offers the same optional persistent daemon", async ({ page }) => {
  let registered: unknown;
  const detail = fixture("/admin/hosts/1/detail") as { host: Record<string, unknown> };
  await installFixtures(page, (path, body) => {
    if (path === "/admin/hosts/register") {
      registered = body;
      return { host: detail.host, installer: { command: "printf 'fake installer'", expires_at: new Date(Date.now() + 3_600_000).toISOString() } };
    }
  });
  await page.goto("/admin/setup?step=host");
  const daemon = page.getByRole("checkbox", { name: /Persistent daemon/ });
  await expect(daemon).not.toBeChecked();
  await daemon.click();
  await page.getByLabel("Hostname (FQDN)").fill("setup-daemon.example.test");
  await page.getByRole("button", { name: "Register host", exact: true }).click();
  await expect.poll(() => registered).toMatchObject({ daemon_enabled: true, fqdn: "setup-daemon.example.test" });
  await expect(page.getByText("printf 'fake installer'", { exact: false }).first()).toBeVisible();
});
