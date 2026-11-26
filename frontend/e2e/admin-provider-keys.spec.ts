import { expect, test, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { CAPABILITIES } from "../src/lib/auth/capabilities";
import { fixture, pick, PROVIDER_KEYS_FIXTURE } from "./admin-fixtures";

/**
 * Provider keys (`/admin/provider-keys`): the real provider API keys a gateway
 * API spends while its source is API key. A stateful stub stands in for the
 * server so every write is recorded and later reads reflect it.
 */
type Key = Record<string, unknown> & { id: number; provider: string; label: string; sort_order: number; state: string; verification_state: string };
type Write = { method: string; path: string; body: unknown };
type Failure = { status: number; code?: string; message: string; required_capability?: string };
type Options = {
  capabilities?: readonly string[];
  disabledEngines?: readonly string[];
  keys?: Key[];
  sources?: Partial<Record<string, "emulated" | "upstream">>;
  /** How `GET /admin/provider-keys` answers; `fail-after-first` serves one list, then fails. */
  list?: "ok" | "hold" | "deny" | "fail" | "fail-after-first";
  createError?: Failure;
  /** What a verification returns for the key. */
  verdict?: { verification_state: string; verification_reason: string | null };
};

const BASE = PROVIDER_KEYS_FIXTURE.keys[0] as unknown as Key;
function makeKey(id: number, provider: string, label: string, sort_order: number, extra: Partial<Key> = {}): Key {
  return { ...BASE, id, provider, label, sort_order, key_hint: `sk-…${String(id).padStart(4, "0")}`, base_url: null, ...extra };
}
const OPENAI_KEYS = () => [
  makeKey(1, "openai", "Primary", 0),
  makeKey(2, "openai", "Backup", 1, { state: "paused" }),
  makeKey(3, "openai", "Old project", 2, { verification_state: "invalid", verification_reason: "HTTP 401" }),
  makeKey(4, "anthropic", "Claude team", 0, { verification_state: "unverified", verification_checked_at: null, last_used_at: null }),
];

async function providerKeys(page: Page, options: Options = {}) {
  const keys = (options.keys ?? OPENAI_KEYS()).map((k) => ({ ...k }));
  const writes: Write[] = [];
  const control = { list: options.list ?? "ok", lists: 0 };
  let releaseList: (() => void) | undefined;
  let nextId = 100;
  const disabled = new Set(options.disabledEngines ?? []);
  const providers = () =>
    PROVIDER_KEYS_FIXTURE.providers.map((p) => {
      const own = keys.filter((k) => k.provider === p.provider);
      const active = own.filter((k) => k.state === "active");
      return {
        ...p,
        engine_enabled: !disabled.has(p.engine),
        source: options.sources?.[p.provider] ?? p.source,
        counts: { total: own.length, active: active.length, usable: active.filter((k) => k.verification_state !== "invalid").length },
      };
    });

  await page.route("**/admin/**", async (route) => {
    const request = route.request();
    if (!request.headers().accept?.includes("application/json")) return route.continue();
    const path = new URL(request.url()).pathname.replace(/\/admin\/engines\/active$/, "/admin/engines/state");
    const method = request.method();
    const json = (body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    const fail = (failure: Failure) => json({ status: "error", ...failure }, failure.status);
    let body: unknown;
    try {
      body = request.postDataJSON();
    } catch {
      body = undefined;
    }

    if (path === "/admin/auth/status") return json({ ...fixture(path), capabilities: [...(options.capabilities ?? CAPABILITIES)] });
    if (path === "/admin/engines/state") {
      const rows = (fixture(path) as { engines: Array<{ engine: string }> }).engines;
      return json({ engines: rows.map((row) => ({ ...row, enabled: !disabled.has(row.engine) })) });
    }
    if (path === "/admin/provider-keys" && method === "GET") {
      control.lists += 1;
      if (control.list === "hold") await new Promise<void>((resolve) => { releaseList = resolve; });
      if (control.list === "deny") return fail({ status: 403, message: "Missing capability", required_capability: "auth.read_metadata" });
      if (control.list === "fail" || (control.list === "fail-after-first" && control.lists > 1)) return fail({ status: 503, code: "unavailable", message: "Database unavailable" });
      return json({ providers: providers(), keys });
    }
    if (path.startsWith("/admin/provider-keys")) {
      writes.push({ method, path, body });
      const payload = (body ?? {}) as Record<string, unknown>;
      const id = Number(path.split("/")[3]);
      const record = keys.find((k) => k.id === id);
      if (path === "/admin/provider-keys" && method === "POST") {
        if (options.createError) return fail(options.createError);
        const created = makeKey(nextId++, String(payload.provider), String(payload.label), keys.filter((k) => k.provider === payload.provider).length, {
          base_url: (payload.base_url as string | undefined) ?? null,
          verification_state: "unverified",
          verification_checked_at: null,
          last_used_at: null,
        });
        keys.push(created);
        return json(created, 201);
      }
      if (path === "/admin/provider-keys/order") {
        const ids = payload.ids as number[];
        ids.forEach((kid, index) => { const k = keys.find((entry) => entry.id === kid); if (k) k.sort_order = index; });
        return json({ keys: keys.filter((k) => k.provider === payload.provider) });
      }
      if (!record) return fail({ status: 404, code: "provider_key_not_found", message: "Provider key not found" });
      if (path.endsWith("/verify")) {
        Object.assign(record, options.verdict ?? { verification_state: "valid", verification_reason: null }, { verification_checked_at: "2026-11-26T10:00:00Z" });
        return json(record);
      }
      if (path.endsWith("/state")) {
        record.state = String(payload.state);
        return json(record);
      }
      if (method === "PATCH") {
        if (typeof payload.label === "string") record.label = payload.label;
        if (typeof payload.base_url === "string") record.base_url = payload.base_url || null;
        if (typeof payload.key === "string") Object.assign(record, { key_hint: "sk-…new1", verification_state: "unverified" });
        return json(record);
      }
      if (method === "DELETE") {
        keys.splice(keys.indexOf(record), 1);
        return json({ id });
      }
    }
    return json(fixture(path));
  });
  return { writes, keys, control, releaseList: () => releaseList?.() };
}

const region = (page: Page, label: string) => page.getByRole("region", { name: `${label} keys` });
const rowOf = (page: Page, label: string) => page.locator("tr[data-key-id]").filter({ hasText: label });
async function rowAction(page: Page, label: string, action: string) {
  await page.getByRole("button", { name: `Actions for ${label}`, exact: true }).click();
  await page.getByRole("menuitem", { name: action, exact: true }).click();
}
const mutating = (writes: Write[]) => writes.filter((w) => w.method !== "GET");

test("lists each provider's keys in failover order with their verdicts", async ({ page }) => {
  await providerKeys(page);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/admin/provider-keys");
  await expect(page.getByRole("heading", { level: 1, name: "Provider keys" })).toBeVisible();
  for (const label of ["OpenAI", "Anthropic", "xAI", "Moonshot AI"]) await expect(page.getByRole("heading", { level: 2, name: label, exact: true })).toBeVisible();

  const openai = region(page, "OpenAI");
  await expect(openai.locator("tr[data-key-id]")).toHaveText([/Primary/, /Backup/, /Old project/]);
  await expect(rowOf(page, "Primary")).toContainText("Verified");
  await expect(rowOf(page, "Backup")).toContainText("Paused");
  await expect(rowOf(page, "Backup")).toContainText("Not tried while paused");
  await expect(rowOf(page, "Old project")).toContainText("Rejected");
  await expect(rowOf(page, "Old project")).toContainText("HTTP 401");
  await expect(rowOf(page, "Old project")).toContainText("Skipped in failover");
  await expect(rowOf(page, "Claude team")).toContainText("Unchecked");
  await expect(page.locator("#provider-openai")).toContainText("1 of 3 keys usable");
  await expect(page.locator("#provider-openai").getByRole("link", { name: "Change under API keys" })).toHaveAttribute("href", "/admin/api-keys#exposed-apis");

  // An empty provider says what a key is for and offers to add one.
  await expect(page.locator("#provider-xai")).toContainText("No xAI keys");
  await expect(page.getByRole("button", { name: "Add xAI key", exact: true })).toBeVisible();
  // Each provider names the surface it answers: Moonshot AI is the /kimi/v1 key path.
  await expect(page.locator("#provider-moonshot")).toContainText("Source of /kimi/v1:");
  await expect(page.locator("#provider-xai")).toContainText("Source of /grok/v1:");

  const axe = await new AxeBuilder({ page }).include("main").analyze();
  expect(axe.violations.filter((v) => ["critical", "serious"].includes(v.impact ?? ""))).toEqual([]);
});

test("an upstream API without a usable key warns beside its table", async ({ page }) => {
  await providerKeys(page, { sources: { openai: "upstream" }, keys: [makeKey(3, "openai", "Old project", 0, { verification_state: "invalid" })] });
  await page.goto("/admin/provider-keys");
  const section = page.locator("#provider-openai");
  await expect(section).toContainText("API key");
  await expect(section.getByRole("status")).toContainText("/v1 answers with API key, but no OpenAI key is usable: its requests fail (503)");
});

test("shows loading, then a denial without retry", async ({ page }) => {
  const state = await providerKeys(page, { list: "hold" });
  await page.goto("/admin/provider-keys");
  await expect(page.getByRole("status", { name: "Loading" })).toBeVisible();
  state.control.list = "deny";
  state.releaseList();
  await expect(page.getByText("No access", { exact: true })).toBeVisible();
  await expect(page.getByText("You need the auth.read_metadata capability. An owner or admin can grant it.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Retry" })).toHaveCount(0);
});

test("a load failure offers retry and recovers", async ({ page }) => {
  const state = await providerKeys(page, { list: "fail" });
  await page.goto("/admin/provider-keys");
  await expect(page.getByRole("alert")).toContainText("Could not load provider keys: Database unavailable");
  state.control.list = "ok";
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(rowOf(page, "Primary")).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("a failed refresh keeps the loaded keys and says so", async ({ page }) => {
  await providerKeys(page, { list: "fail-after-first" });
  await page.goto("/admin/provider-keys");
  await expect(rowOf(page, "Primary")).toBeVisible();
  await rowAction(page, "Primary", "Verify key");
  await expect(page.getByRole("alert").filter({ hasText: "Refresh failed. Showing previously loaded keys." })).toBeVisible({ timeout: 10_000 });
  await expect(rowOf(page, "Primary")).toBeVisible();
});

test("without keys.manage the page is read-only", async ({ page }) => {
  const state = await providerKeys(page, { capabilities: CAPABILITIES.filter((c) => c !== "keys.manage") });
  await page.goto("/admin/provider-keys");
  await expect(rowOf(page, "Primary")).toBeVisible();
  await expect(page.getByText("Read-only: adding, changing, ordering and deleting provider keys requires the keys.manage capability.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Add key", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^Actions for / })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^Move / })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Add xAI key" })).toHaveCount(0);
  expect(mutating(state.writes)).toEqual([]);
});

test("a switched-off engine hides its provider and counts its keys", async ({ page }) => {
  await providerKeys(page, { disabledEngines: ["claude"] });
  await page.goto("/admin/provider-keys");
  await expect(rowOf(page, "Primary")).toBeVisible();
  await expect(page.getByRole("heading", { level: 2, name: "Anthropic", exact: true })).toHaveCount(0);
  await expect(page.getByText("1 item from switched-off engines is hidden.")).toBeVisible();
  await page.getByRole("button", { name: "Add key", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Provider", exact: true }).click();
  await expect(page.getByRole("option", { name: "OpenAI", exact: true })).toBeVisible();
  await expect(page.getByRole("option", { name: "Anthropic", exact: true })).toHaveCount(0);
});

test("reflows at 320 px without horizontal overflow", async ({ page }) => {
  await providerKeys(page);
  await page.setViewportSize({ width: 320, height: 800 });
  await page.goto("/admin/provider-keys");
  await expect(rowOf(page, "Primary")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  const actions = page.getByRole("button", { name: "Actions for Primary", exact: true });
  await actions.scrollIntoViewIfNeeded();
  await expect(actions).toBeInViewport();
  await page.getByRole("button", { name: "Add key", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByLabel("API key")).toBeVisible();
  expect(await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test("adding a key chains a verification and shows its verdict", async ({ page }) => {
  const state = await providerKeys(page, { verdict: { verification_state: "valid", verification_reason: "restricted (HTTP 403)" } });
  await page.goto("/admin/provider-keys");
  await page.getByRole("button", { name: "Add key", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await pick(page, dialog.getByRole("button", { name: "Provider", exact: true }), "xAI");
  await expect(dialog).toContainText("Its key answers /grok/v1.");
  await dialog.getByLabel("Name").fill("Grok research");
  const keyField = dialog.getByLabel("API key");
  await expect(keyField).toHaveAttribute("type", "password");
  await keyField.fill("xai-0123456789abcdef0123");
  await dialog.getByRole("button", { name: "Add key", exact: true }).click();
  await expect(dialog.getByRole("status").filter({ hasText: "Saved and verified: xAI accepted the key with limited rights (restricted (HTTP 403))." })).toBeVisible();
  expect(mutating(state.writes)).toEqual([
    { method: "POST", path: "/admin/provider-keys", body: { provider: "xai", label: "Grok research", key: "xai-0123456789abcdef0123" } },
    { method: "POST", path: "/admin/provider-keys/100/verify", body: {} },
  ]);
  await expect(dialog.getByRole("button", { name: "Verify again" })).toHaveCount(0);
  await dialog.getByRole("button", { name: "Done", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(region(page, "xAI").locator("tr[data-key-id]")).toHaveText([/Grok research/]);
});

test("a rejected key can be verified again from the dialog", async ({ page }) => {
  const state = await providerKeys(page, { verdict: { verification_state: "invalid", verification_reason: "HTTP 401" } });
  await page.goto("/admin/provider-keys");
  await page.getByRole("button", { name: "Add xAI key", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Name").fill("Wrong key");
  await dialog.getByLabel("API key").fill("xai-0123456789abcdef0123");
  await dialog.getByRole("button", { name: "Add key", exact: true }).click();
  await expect(dialog.getByRole("status").filter({ hasText: "Saved, but xAI rejected the key (HTTP 401). It is skipped in failover until you replace it." })).toBeVisible();
  await dialog.getByRole("button", { name: "Verify again", exact: true }).click();
  await expect.poll(() => mutating(state.writes).map((w) => w.path)).toEqual(["/admin/provider-keys", "/admin/provider-keys/100/verify", "/admin/provider-keys/100/verify"]);
});

test("field errors stay beside their field and keep the draft", async ({ page }) => {
  const state = await providerKeys(page, { createError: { status: 400, code: "gateway_key_not_allowed", message: "key is a gateway key" } });
  await page.goto("/admin/provider-keys");
  await page.getByRole("button", { name: "Add key", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "Add key", exact: true }).click();
  await expect(dialog).toContainText("Name the key, for example the account or project it belongs to.");
  await expect(dialog).toContainText("Paste the API key.");
  expect(mutating(state.writes)).toEqual([]);

  await dialog.getByLabel("Name").fill("Pasted the wrong thing");
  await dialog.getByLabel("API key").fill("sk-cdx-0123456789abcdef0123");
  await dialog.getByLabel("Base URL (optional)").fill("ftp://example.com");
  await dialog.getByRole("button", { name: "Add key", exact: true }).click();
  await expect(dialog).toContainText("Enter a full URL that starts with https://.");
  expect(mutating(state.writes)).toEqual([]);

  await dialog.getByLabel("Base URL (optional)").fill("");
  await dialog.getByRole("button", { name: "Add key", exact: true }).click();
  await expect(dialog.getByLabel("API key")).toHaveAttribute("aria-invalid", "true");
  await expect(dialog).toContainText("This is a gateway key issued by this orchestrator, not a provider API key.");
  await expect(dialog.getByLabel("Name")).toHaveValue("Pasted the wrong thing");
  // A refused save is never followed by a verification.
  expect(mutating(state.writes).map((w) => w.path)).toEqual(["/admin/provider-keys"]);
});

test("editing sends only the changed fields and never prefills the key", async ({ page }) => {
  const state = await providerKeys(page);
  await page.goto("/admin/provider-keys");
  await rowAction(page, "Primary", "Edit key");
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("heading", { name: "Edit Primary" })).toBeVisible();
  await expect(dialog.getByLabel("Name")).toHaveValue("Primary");
  await expect(dialog.getByLabel("New API key")).toHaveValue("");
  await expect(dialog.getByLabel("New API key")).toHaveAttribute("type", "password");
  await expect(dialog.getByRole("button", { name: "Save key", exact: true })).toBeDisabled();

  // A rename is not a new credential: no verification follows.
  await dialog.getByLabel("Name").fill("Primary account");
  await dialog.getByRole("button", { name: "Save key", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(mutating(state.writes)).toEqual([{ method: "PATCH", path: "/admin/provider-keys/1", body: { label: "Primary account" } }]);
  await expect(rowOf(page, "Primary account")).toBeVisible();

  // A new base URL is checked again.
  await rowAction(page, "Primary account", "Edit key");
  await dialog.getByLabel("Base URL (optional)").fill("https://eu.api.openai.com/v1");
  await dialog.getByRole("button", { name: "Save key", exact: true }).click();
  await expect(dialog.getByRole("status").filter({ hasText: "Saved and verified: OpenAI accepted the key." })).toBeVisible();
  expect(mutating(state.writes).slice(1)).toEqual([
    { method: "PATCH", path: "/admin/provider-keys/1", body: { base_url: "https://eu.api.openai.com/v1" } },
    { method: "POST", path: "/admin/provider-keys/1/verify", body: {} },
  ]);
});

test("closing a dirty dialog asks before discarding", async ({ page }) => {
  await providerKeys(page);
  await page.goto("/admin/provider-keys");
  await page.getByRole("button", { name: "Add key", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Name").fill("Half typed");
  const prompts: string[] = [];
  page.once("dialog", async (prompt) => { prompts.push(prompt.message()); await prompt.dismiss(); });
  await page.keyboard.press("Escape");
  await expect(dialog.getByLabel("Name")).toHaveValue("Half typed");
  expect(prompts).toEqual(["Discard this provider key?"]);
});

test("the arrows reorder by posting the full order", async ({ page }) => {
  const state = await providerKeys(page);
  await page.goto("/admin/provider-keys");
  await expect(page.getByRole("button", { name: "Move Primary up", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "Move Backup up", exact: true }).click();
  await expect(region(page, "OpenAI").locator("tr[data-key-id]")).toHaveText([/Backup/, /Primary/, /Old project/]);
  expect(mutating(state.writes)).toEqual([{ method: "POST", path: "/admin/provider-keys/order", body: { provider: "openai", ids: [2, 1, 3] } }]);
  await expect(page.getByText("Backup moved to position 1")).toBeAttached();
});

test("deleting names the failover consequence before it runs", async ({ page }) => {
  const state = await providerKeys(page, {
    sources: { openai: "upstream" },
    keys: [makeKey(1, "openai", "Primary", 0), makeKey(5, "openai", "Second", 1)],
  });
  await page.goto("/admin/provider-keys");
  await rowAction(page, "Primary", "Delete key");
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("heading", { name: "Delete Primary?" })).toBeVisible();
  await expect(dialog).toContainText("The OpenAI key sk-…0001 is removed from this server.");
  await expect(dialog).toContainText("The next key, Second, takes over: requests go to it first.");
  await dialog.getByRole("button", { name: "Delete key", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(rowOf(page, "Primary")).toHaveCount(0);

  await rowAction(page, "Second", "Delete key");
  await expect(dialog).toContainText("It is the last usable OpenAI key. /v1 answers with API key, so its requests fail (503)");
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(rowOf(page, "Second")).toBeVisible();
  expect(mutating(state.writes)).toEqual([{ method: "DELETE", path: "/admin/provider-keys/1", body: null }]);
});

test("pausing the last usable key of an upstream API asks first", async ({ page }) => {
  const state = await providerKeys(page, { sources: { openai: "upstream" }, keys: [makeKey(1, "openai", "Primary", 0)] });
  await page.goto("/admin/provider-keys");
  await rowAction(page, "Primary", "Pause key");
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("heading", { name: "Pause Primary?" })).toBeVisible();
  await expect(dialog).toContainText("its requests fail (503)");
  expect(mutating(state.writes)).toEqual([]);
  await dialog.getByRole("button", { name: "Pause key", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(rowOf(page, "Primary")).toContainText("Paused");
  expect(mutating(state.writes)).toEqual([{ method: "POST", path: "/admin/provider-keys/1/state", body: { state: "paused" } }]);
});

test("the verify row action shows the provider's verdict in the row", async ({ page }) => {
  const state = await providerKeys(page, { verdict: { verification_state: "invalid", verification_reason: "HTTP 401" } });
  await page.goto("/admin/provider-keys");
  await rowAction(page, "Claude team", "Verify key");
  await expect(rowOf(page, "Claude team")).toContainText("Rejected");
  await expect(rowOf(page, "Claude team")).toContainText("HTTP 401");
  await expect(page.getByText("Claude team: Rejected, HTTP 401")).toBeAttached();
  expect(mutating(state.writes)).toEqual([{ method: "POST", path: "/admin/provider-keys/4/verify", body: {} }]);
});
