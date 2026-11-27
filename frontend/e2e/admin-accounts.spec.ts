import { expect, test, type Page } from "@playwright/test";
import { installOwnerUpdates } from "./owner-stream";

const reset = "2026-10-01T12:00:00Z";
function account(id: number, engine: "claude" | "codex" | "grok" | "kimi", label: string, percent: number | null) {
  return { id, engine, label, state: "enabled", verification_state: "verified", verification_reason: null, verification_checked_at: reset, generation: 1, refresh_state: "idle",
    usage: { supported: true, fetched_at: engine === "grok" ? null : reset, checked_at: reset, stale: engine === "grok", current_window: null, short_used_percent: percent, short_resets_at: engine === "grok" ? null : reset, weekly_used_percent: percent, weekly_resets_at: engine === "grok" ? null : reset }, sessions: [] };
}
async function fixtures(page: Page, canManage = true, extra: ReturnType<typeof account>[] = []) {
  const accounts = [account(1, "claude", "Claude Alpha", 20), account(2, "claude", "Claude Beta", 80), account(3, "claude", "Claude Gamma", 20), ...extra];
  const writes: Array<{ method: string; path: string; body: unknown }> = [];
  await page.route("**/admin/**", async (route) => {
    const request = route.request();
    if (!["fetch", "xhr"].includes(request.resourceType())) { await route.continue(); return; }
    const path = new URL(request.url()).pathname;
    const method = request.method();
    let body: unknown = {};
    if (path === "/admin/auth/status") body = { authenticated: true, enforced: true, user: { id: 1, name: "Operator", username: "operator", access_level: "owner" }, roles: ["owner"], capabilities: canManage ? ["auth.manage", "auth.metadata.read"] : ["auth.metadata.read"] };
    else if (path === "/admin/setup/status") body = { setup_complete: true, next_actions: [], checks: [], critical_complete: true, wizard: { completed_at: reset } };
    else if (path === "/admin/ws/info") body = { enabled: false };
    else if (path === "/admin/accounts" && method === "GET") body = { accounts };
    else if (path.startsWith("/admin/accounts") && method !== "GET") {
      const payload = request.postData() ? request.postDataJSON() : {};
      writes.push({ method, path, body: payload });
      const id = Number(path.split("/")[3]);
      const target = accounts.find((a) => a.id === id);
      if (method === "PATCH" && target) Object.assign(target, payload);
      if (method === "DELETE") accounts.splice(accounts.findIndex((a) => a.id === id), 1);
      if (method === "POST" && path === "/admin/accounts") accounts.push(account(4, payload.engine, payload.label, 0));
      body = { status: "ok", verification_state: "verified", account_id: id || 4 };
    }
    await route.fulfill({ json: { status: "ok", data: body } });
  });
  return writes;
}

// Account rows only: an engine group's header names its least-used account too.
const rowOf = (page: Page, name: string | RegExp) => page.getByRole("row", { name }).and(page.locator(":not([data-testid=account-group])"));
async function choose(page: Page, row: ReturnType<typeof rowOf>, label: string, item: string) {
  await row.getByRole("button", { name: `Actions for ${label}` }).click();
  await page.getByRole("menuitem", { name: item, exact: true }).click();
}

test("manages a Claude-only pool and shows each quota separately", async ({ page }) => {
  const writes = await fixtures(page);
  await page.goto("/admin/accounts");
  // Three Claude accounts form one group: collapsed by default, the header judges the pool.
  const group = page.getByTestId("account-group");
  await expect(group).toContainText("Claude 3 accounts");
  await expect(group).toContainText("OK");
  await expect(group).toContainText("Least used: Claude Alpha (20%) · average short 40%, weekly 40% (3 of 3 reporting)");
  await expect(rowOf(page, /Claude Alpha/)).toHaveCount(0);
  await group.getByRole("button", { name: /^Claude 3 accounts/ }).click();
  await expect(group.getByRole("button", { name: /^Claude 3 accounts/ })).toHaveAttribute("aria-expanded", "true");
  await expect(page).toHaveURL(/[?&]open=claude/);
  await expect(rowOf(page, /Claude Alpha/)).toBeVisible();
  await expect(rowOf(page, /Claude Beta/)).toBeVisible();
  await expect(rowOf(page, /Claude Gamma/)).toBeVisible();
  await expect(page.getByText("80%", { exact: true })).toHaveCount(2);
  await choose(page, rowOf(page, /Claude Alpha/), "Claude Alpha", "Pause");
  await expect(rowOf(page, /Claude Alpha/)).toContainText("Paused");
  await choose(page, rowOf(page, /Claude Alpha/), "Claude Alpha", "Resume");
  await choose(page, rowOf(page, /Claude Alpha/), "Claude Alpha", "Rename");
  await page.getByRole("dialog").getByRole("textbox", { name: "Account name" }).fill("Claude Primary");
  await page.getByRole("dialog").getByRole("button", { name: "Save name", exact: true }).click();
  await expect(rowOf(page, /Claude Primary/)).toBeVisible();
  await choose(page, rowOf(page, /Claude Primary/), "Claude Primary", "Verify");
  await page.getByRole("button", { name: "Add account", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("textbox", { name: "Account name" }).fill("Claude Fourth");
  await dialog.getByRole("radio", { name: "Claude", exact: true }).click();
  await dialog.locator("textarea").fill('{"claudeAiOauth":{"accessToken":"test"}}');
  await dialog.getByRole("button", { name: "Upload credentials" }).click();
  await expect(rowOf(page, /Claude Fourth/)).toBeVisible();
  await choose(page, rowOf(page, /Claude Fourth/), "Claude Fourth", "Replace credentials");
  await page.getByRole("dialog").locator("textarea").fill('{"claudeAiOauth":{"accessToken":"replacement"}}');
  await page.getByRole("dialog").getByRole("button", { name: "Upload credentials" }).click();
  await choose(page, rowOf(page, /Claude Fourth/), "Claude Fourth", "Remove account");
  await page.getByRole("dialog").getByRole("button", { name: "Remove account", exact: true }).click();
  await expect(rowOf(page, /Claude Fourth/)).toHaveCount(0);
  expect(writes.map((w) => `${w.method} ${w.path}`)).toEqual(["PATCH /admin/accounts/1", "PATCH /admin/accounts/1", "PATCH /admin/accounts/1", "POST /admin/accounts/1/verify", "POST /admin/accounts", "POST /admin/accounts/4/credentials", "DELETE /admin/accounts/4"]);
});

test("read-only operators can inspect quotas without management actions", async ({ page }) => {
  const writes = await fixtures(page, false);
  await page.goto("/admin/accounts?open=claude");
  await expect(rowOf(page, /Claude Alpha/)).toBeVisible();
  await expect(page.getByText("80%", { exact: true })).toHaveCount(2);
  await expect(page.getByRole("button", { name: "Add account" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^Actions for/ })).toHaveCount(0);
  expect(writes).toEqual([]);
});

test("the engine filter is always visible, scopes the list and keeps engine-specific empty states", async ({ page }) => {
  await fixtures(page, false, [account(7, "grok", "Grok Primary", null)]);
  await page.goto("/admin/accounts?open=claude");
  await expect(rowOf(page, /Claude Alpha/)).toBeVisible();
  await expect(rowOf(page, /Grok Primary/)).toBeVisible();
  await page.getByRole("button", { name: "Codex", exact: true }).click();
  await expect(page.getByText("No Codex accounts", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Claude", exact: true }).click();
  await expect(rowOf(page, /Claude Alpha/)).toBeVisible();
  await expect(rowOf(page, /Grok Primary/)).toHaveCount(0);
  await page.getByRole("button", { name: "Grok", exact: true }).click();
  await expect(rowOf(page, /Grok Primary/)).toBeVisible();
  await expect(rowOf(page, /Claude Alpha/)).toHaveCount(0);
  await page.getByRole("button", { name: "All", exact: true }).click();
  await page.getByRole("textbox", { name: "Search accounts" }).fill("beta");
  await expect(rowOf(page, /Claude Beta/)).toBeVisible();
  await expect(rowOf(page, /Claude Alpha/)).toHaveCount(0);
  await page.getByRole("textbox", { name: "Search accounts" }).fill("zzz");
  await expect(page.getByText("No matches", { exact: true })).toBeVisible();
});

test("a login enrolled after load appears without a reload and joins its engine group", async ({ page }) => {
  // The page once froze after its first render (the policy form's effect looped), so a second
  // Claude account enrolled later never appeared and the first kept its default label.
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await fixtures(page);
  let listed = [account(1, "claude", "Claude", 87)];
  await page.route("**/admin/accounts", (route) =>
    ["fetch", "xhr"].includes(route.request().resourceType()) ? route.fulfill({ json: { status: "ok", data: { accounts: listed } } }) : route.continue());
  const emit = await installOwnerUpdates(page);
  await page.goto("/admin/accounts");
  // A default label never reads like the provider itself.
  await expect(rowOf(page, /Claude account #1/)).toBeVisible();
  await expect(page.getByTestId("account-group")).toHaveCount(0);
  listed = [account(1, "claude", "Claude", 87), account(8, "claude", "ops@example.test", 5)];
  await emit("accounts.updated");
  const group = page.getByTestId("account-group");
  await expect(group).toContainText("Claude 2 accounts");
  await expect(group).toContainText("OK");
  await expect(group).toContainText("Least used: ops@example.test (5%)");
  await expect(page.locator("main dl dd").first()).toHaveText("2");
  expect(errors).toEqual([]);
});

test("accounts that need attention are listed first and counted", async ({ page }) => {
  const broken = { ...account(9, "codex", "ChatGPT Team", 10), refresh_state: "login_required" };
  await fixtures(page, true, [broken]);
  await page.goto("/admin/accounts");
  await expect(page.getByRole("row").nth(1)).toContainText("ChatGPT Team");
  await expect(page.getByRole("row").nth(1)).toContainText("Login needs renewal");
  await expect(page.getByText("need attention")).toBeVisible();
});

test("Grok subscription accounts show unavailable quota and upload full OIDC credentials", async ({ page }) => {
  const grok = { ...account(5, "grok", "Grok Primary", null), refresh_state: "login_required" };
  const writes = await fixtures(page, true, [grok]);
  await page.goto("/admin/accounts");
  const row = rowOf(page, /Grok Primary/);
  await expect(row).toContainText("Usage unavailable");
  await expect(row).toContainText("cgx login");
  await expect(row.getByRole("meter")).toHaveCount(0);
  await choose(page, row, "Grok Primary", "Replace credentials");
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("Subscription login credentials include refresh material");
  await expect(dialog.getByText("OpenAI API key", { exact: true })).toHaveCount(0);
  const payload = JSON.stringify({ "https://auth.x.ai::b1a00492-073a-47ea-816f-4c329264a828": {
    auth_mode: "oidc", key: "fake-access", refresh_token: "fake-refresh", oidc_issuer: "https://auth.x.ai",
    oidc_client_id: "b1a00492-073a-47ea-816f-4c329264a828", expires_at: reset, user_id: "fake-user" } });
  await dialog.locator("textarea").fill(payload);
  await dialog.getByRole("button", { name: "Upload credentials" }).click();
  await expect(dialog).toHaveCount(0);
  expect(writes).toEqual([{ method: "POST", path: "/admin/accounts/5/credentials", body: { payload } }]);
});

for (const mobile of [false, true]) {
  test(`quota overrides preserve failed saves and PayG suppresses controls (${mobile ? "mobile" : "desktop"})`, async ({ page }) => {
    if (mobile) await page.setViewportSize({ width: 390, height: 844 });
    await page.emulateMedia({ colorScheme: mobile ? "dark" : "light" });
    await fixtures(page);
    const defaults = { unlimited: false, short_warn_percent: 85, long_warn_percent: 85, short_auto_resume: true, long_auto_resume: false };
    let override: typeof defaults | null = null, fail = true;
    await page.route("**/admin/accounts/1/quota-policy", async route => {
      if (route.request().method() === "PUT") {
        if (fail) { fail = false; await route.fulfill({ status: 503, json: { status: "error", message: "Policy save unavailable" } }); return; }
        override = route.request().postDataJSON().policy;
      }
      await route.fulfill({ json: { status: "ok", data: { defaults, override, effective: override ?? defaults } } });
    });
    await page.goto("/admin/accounts?open=claude");
    await choose(page, rowOf(page, /Claude Alpha/), "Claude Alpha", "Quota policy");
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByRole("switch", { name: "Use engine defaults" })).toBeChecked();
    await dialog.getByRole("switch", { name: "Use engine defaults" }).click();
    await dialog.getByRole("switch", { name: "PayG / unlimited" }).click();
    await expect(dialog.getByRole("switch", { name: "Warn agents" }).first()).toBeDisabled();
    await dialog.getByRole("button", { name: "Save quota policy" }).click();
    await expect(dialog.getByRole("alert")).toContainText("Policy save unavailable");
    await expect(dialog.getByRole("switch", { name: "PayG / unlimited" })).toBeChecked();
    await dialog.getByRole("button", { name: "Save quota policy" }).click();
    await expect(dialog.getByRole("status")).toContainText("Quota policy saved");
    expect(override).toMatchObject({ unlimited: true });
    await dialog.getByRole("switch", { name: "Use engine defaults" }).click();
    await dialog.getByRole("button", { name: "Save quota policy" }).click();
    await expect.poll(() => override).toBeNull();
    await expect(dialog.getByRole("switch", { name: "PayG / unlimited" })).not.toBeChecked();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    const { default: AxeBuilder } = await import("@axe-core/playwright");
    const axe = await new AxeBuilder({ page }).include('[role="dialog"]').analyze();
    expect(axe.violations).toEqual([]);
  });
}

for (const engine of ["codex", "claude", "grok", "kimi"] as const) {
  for (const theme of ["light", "dark"] as const) {
    test(`provider credential layout ${engine} ${theme}`, async ({ page }, testInfo) => {
      await fixtures(page);
      await page.setViewportSize({ width: theme === "dark" ? 320 : 1440, height: 900 });
      await page.addInitScript(value => localStorage.setItem("codex.theme", value), theme);
      await page.route("**/admin/auth/seed-command", async route => {
        const selected = route.request().postDataJSON().engine;
        await route.fulfill({ json: { status: "ok", data: { command: `echo fixture-${selected}`, expires_at: "2026-10-26T12:00:00Z" } } });
      });
      await page.goto("/admin/accounts");
      await page.getByRole("button", { name: "Add account", exact: true }).click();
      const dialog = page.getByRole("dialog");
      const label = engine === "codex" ? "Codex" : engine === "claude" ? "Claude" : engine === "grok" ? "Grok" : "Kimi Code";
      await dialog.getByRole("radio", { name: label, exact: true }).click();
      if (engine === "codex") await dialog.getByText("ChatGPT session", { exact: true }).click();
      await expect(dialog.getByLabel("Or choose a credentials file")).toBeVisible();
      await dialog.getByLabel("Or choose a credentials file").focus();
      await expect(dialog.getByLabel("Or choose a credentials file")).toBeFocused();
      expect(await dialog.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
      const { default: AxeBuilder } = await import("@axe-core/playwright");
      expect((await new AxeBuilder({ page }).include('[role="dialog"]').analyze()).violations).toEqual([]);
      await dialog.evaluate(el => { el.scrollTop = 0; });
      await page.screenshot({ path: testInfo.outputPath(`provider-${engine}-${theme}.png`), fullPage: true });
      await dialog.getByRole("tab", { name: "One-time command" }).click();
      await expect(dialog.getByRole("radiogroup", { name: "Engine", exact: true })).toHaveCount(1);
      await dialog.getByRole("button", { name: "Generate", exact: true }).click();
      await expect(dialog.getByText(`echo fixture-${engine}`, { exact: true })).toHaveText(`echo fixture-${engine}`);
      await dialog.getByRole("radio", { name: engine === "grok" ? "Claude" : "Grok", exact: true }).click();
      await expect(dialog.getByText(`echo fixture-${engine}`, { exact: true })).toHaveCount(0);
    });
  }
}

test("the distribution policy is chosen on cards and limited on one two-thumb slider", async ({ page }) => {
  await fixtures(page);
  let policy = { mode: "auto", strategy: "balanced", spread: "normal", spread_points: 20, soft_ceiling: 90, hard_ceiling: 96, min_dwell_minutes: 15 };
  const posts: unknown[] = [];
  await page.route("**/admin/accounts/policy/claude", async (route) => {
    if (route.request().method() === "POST") {
      const changes = route.request().postDataJSON();
      posts.push(changes);
      policy = { ...policy, ...changes };
    }
    await route.fulfill({ json: { status: "ok", data: policy } });
  });
  await page.goto("/admin/accounts");
  const automatic = page.getByRole("radio", { name: /^Automatic/ });
  await expect(automatic).toHaveAttribute("aria-checked", "true");
  await expect(page.getByRole("radio", { name: /^Balanced/ })).toHaveAttribute("aria-checked", "true");
  // Balanced uses the band: no limits until a filling strategy is chosen.
  await expect(page.getByRole("slider")).toHaveCount(0);
  await page.getByRole("radio", { name: /^Expiring first/ }).click();
  await expect(page.getByRole("radio", { name: /^Balanced/ })).toHaveAttribute("aria-checked", "false");

  const soft = page.getByRole("slider", { name: "Soft limit" });
  const hard = page.getByRole("slider", { name: "Hard limit" });
  await expect(soft).toHaveAttribute("aria-valuenow", "90");
  await expect(hard).toHaveAttribute("aria-valuetext", "96%");
  await soft.focus();
  for (let i = 0; i < 5; i++) await page.keyboard.press("ArrowLeft");
  await hard.focus();
  await page.keyboard.press("End");
  await expect(page.getByTestId("policy-limits")).toHaveText(/Soft\s*85%\s*Hard\s*100%/);
  // Pushed to the end, the soft thumb stops one short of the hard one: the server allows 99 at most.
  await soft.focus();
  await page.keyboard.press("End");
  await expect(page.getByTestId("policy-limits")).toHaveText(/Soft\s*99%\s*Hard\s*100%/);
  await page.keyboard.press("Home");
  // The pointer moves the thumbs too: drag the hard limit down from 100%.
  const box = (await hard.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x - 60, box.y + box.height / 2, { steps: 5 });
  await page.mouse.up();
  const dragged = Number(await hard.getAttribute("aria-valuenow"));
  expect(dragged).toBeLessThan(100);
  expect(dragged).toBeGreaterThan(50);
  expect(posts).toEqual([]);

  await page.getByRole("button", { name: "Save policy" }).click();
  await expect.poll(() => posts.length).toBe(1);
  expect(posts[0]).toEqual({ mode: "auto", strategy: "reset_aware", min_dwell_minutes: 15, soft_ceiling: 50, hard_ceiling: dragged });

  // Manual hides strategy and limits and sends only the mode.
  await page.getByRole("radio", { name: /^Manual/ }).click();
  await expect(page.getByRole("radio", { name: /^Expiring first/ })).toHaveCount(0);
  await page.getByRole("button", { name: "Save policy" }).click();
  await expect.poll(() => posts.length).toBe(2);
  expect(posts[1]).toEqual({ mode: "manual" });
});

for (const mobile of [false, true]) {
  test(`pausing sessions for a switch is its own choice and each scope says where it stands (${mobile ? "mobile" : "desktop"})`, async ({ page }, testInfo) => {
    if (mobile) await page.setViewportSize({ width: 320, height: 900 });
    await fixtures(page);
    let policy = { mode: "manual", strategy: "balanced", spread: "normal", spread_points: 20, soft_ceiling: 90, hard_ceiling: 96, min_dwell_minutes: 15, pause: "off", pause_after_seconds: 120, pause_hold_seconds: 90 };
    const posts: unknown[] = [];
    await page.route("**/admin/accounts/policy/claude", async (route) => {
      if (route.request().method() === "POST") {
        const changes = route.request().postDataJSON();
        posts.push(changes);
        policy = { ...policy, ...changes };
      }
      await route.fulfill({ json: { status: "ok", data: policy } });
    });
    const directive = (reason: string) => ({ account_id: 3, account_label: "Claude Gamma", binding_generation: 7, reason, requested_at: new Date(Date.now() - 4 * 60_000).toISOString() });
    const quiet = { pausable: true, blocked_by: [], round: null, last: null, retry_at: null };
    const scope = (host_id: number, host_fqdn: string, sessions: number, extra: Record<string, unknown>) => ({
      host_id, host_fqdn, scope_id: `scope-${host_id}`, account_id: 1, account_label: "Claude Alpha", binding_generation: 7, sessions, bound_at: reset, account_switch: null, pause: quiet, ...extra,
    });
    await page.route("**/admin/accounts/scopes?engine=claude", (route) =>
      route.fulfill({
        json: {
          status: "ok",
          data: [
            scope(1, "resting.test", 1, {}),
            scope(2, "pausing.test", 3, {
              account_switch: directive("policy"),
              pause: { ...quiet, round: { id: "r1", deadline: new Date(Date.now() + 60_000).toISOString(), ready_at: null, sessions: [{ session_id: "a", state: "paused", reported_at: reset }, { session_id: "b", state: "paused", reported_at: reset }, { session_id: "c", state: "requested", reported_at: null }] } },
            }),
            scope(3, "old-session.test", 3, { account_switch: directive("admin"), pause: { ...quiet, pausable: false, blocked_by: [{ session_id: "x", reason: "no_hooks" }] } }),
            scope(4, "straggler.test", 2, {
              account_switch: directive("agent"),
              pause: { ...quiet, last: { round: "r0", outcome: "deadline", at: reset, asked: 2, paused: 1, blocker: "y", detail: null }, retry_at: new Date(Date.now() + 5 * 60_000).toISOString() },
            }),
            // A server before pause rounds says nothing about pausing.
            scope(5, "plain.test", 1, { account_switch: directive("host"), pause: undefined }),
          ],
        },
      }),
    );
    await page.goto("/admin/accounts");

    // Off: one switch, no durations, and nothing about pausing in the summary line.
    const toggle = page.getByRole("switch", { name: "Pause sessions for a switch" });
    await expect(toggle).toHaveAttribute("aria-checked", "false");
    await expect(page.getByLabel("Hold a session at most (seconds)")).toHaveCount(0);
    await toggle.click();
    const wait = page.getByLabel("Wait for a natural gap first (seconds)");
    const hold = page.getByLabel("Hold a session at most (seconds)");
    await expect(wait).toHaveValue("120");
    await expect(hold).toHaveValue("90");
    await expect(page.getByText("or while the sessions are paused for it")).toBeVisible();
    // The bounds are the server's, said next to the field, and block the save.
    await hold.fill("10");
    await expect(page.getByText("Enter a whole number of seconds from 30 to 300.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Save policy" })).toBeDisabled();
    await hold.fill("60");
    await wait.fill("30");
    await page.getByRole("button", { name: "Save policy" }).click();
    await expect.poll(() => posts.length).toBe(1);
    // Manual mode sends the pause choice too: an operator's own switch is paused for as well.
    expect(posts[0]).toEqual({ mode: "manual", pause: "on", pause_after_seconds: 30, pause_hold_seconds: 60 });
    await toggle.click();
    await page.getByRole("button", { name: "Save policy" }).click();
    await expect.poll(() => posts.length).toBe(2);
    expect(posts[1]).toEqual({ mode: "manual", pause: "off" });

    const row = (host: string) => page.getByRole("row", { name: new RegExp(host.replace(".", "\\.")) });
    await expect(row("resting.test")).toContainText("None");
    await expect(row("resting.test").getByTestId("scope-pause-status")).toHaveCount(0);
    await expect(row("pausing.test")).toContainText("To Claude Gamma");
    await expect(row("pausing.test").getByTestId("scope-pause-status")).toHaveText("Pausing sessions: 2 of 3 paused.");
    await expect(row("pausing.test")).not.toContainText("waiting for a gap between turns");
    await expect(row("old-session.test").getByTestId("scope-pause-status")).toContainText("Cannot pause for this switch: 1 session of 3 was started before pausing was available");
    await expect(row("old-session.test")).toContainText("Requested by an admin");
    await expect(row("straggler.test").getByTestId("scope-pause-status")).toContainText("The last pause ran out of time with 1 of 2 sessions paused. Next attempt");
    await expect(row("plain.test")).toContainText("waiting for a gap between turns");
    await expect(row("plain.test").getByTestId("scope-pause-status")).toHaveCount(0);

    // Nothing may force the page sideways at 320 px.
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await toggle.click();
    await toggle.scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath(`accounts-pause-${mobile ? "mobile" : "desktop"}.png`), fullPage: true });
    await row("pausing.test").scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath(`accounts-pause-scopes-${mobile ? "mobile" : "desktop"}.png`), fullPage: true });
  });
}
