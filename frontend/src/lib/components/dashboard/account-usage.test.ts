import assert from "node:assert/strict";
import { it } from "node:test";
import type { ProviderAccount } from "../../api/accounts";

const modulePath: string = "./account-usage.ts";
const { accountQuotaRows } = await import(modulePath) as typeof import("./account-usage");
function account(engine: ProviderAccount["engine"], changes: Partial<ProviderAccount["usage"]> = {}) {
  return { engine, usage: {
    fetched_at: null, stale: false, short_used_percent: null, short_resets_at: null,
    weekly_used_percent: null, weekly_resets_at: null, ...changes,
  } };
}

it("renders a supplied 5-hour window at zero and a weekly window with their reset times", () => {
  const rows = accountQuotaRows(account("codex", {
    short_used_percent: 0, short_limit_seconds: 18000, short_resets_at: "2026-10-13T17:00:00Z",
    weekly_used_percent: 15, weekly_limit_seconds: 604800,
  }));
  assert.deepEqual(rows.map(({ label, value, reset }) => ({ label, value, reset })), [
    { label: "5-hour window", value: 0, reset: "2026-10-13T17:00:00Z" },
    { label: "Weekly window", value: 15, reset: null },
  ]);
});

it("weekly-only and missing data never acquire a fabricated 5-hour meter", () => {
  assert.deepEqual(accountQuotaRows(account("codex")), []);
  assert.deepEqual(accountQuotaRows(account("codex", { weekly_used_percent: 15 })).map(r => r.label), ["Weekly window"]);
});

it("keeps old-server compatibility without guessing ChatGPT duration", () => {
  assert.equal(accountQuotaRows(account("codex", { short_used_percent: 7 }))[0].label, "Short window");
  assert.equal(accountQuotaRows(account("claude", { short_used_percent: 0 }))[0].label, "5-hour window");
  assert.equal(accountQuotaRows(account("codex", { short_used_percent: 7, short_limit_seconds: 86400 }))[0].label, "1-day window");
});

it("ignores unavailable and non-finite readings, preserves stale observations", () => {
  assert.deepEqual(accountQuotaRows(account("codex", { short_used_percent: NaN })), []);
  assert.deepEqual(accountQuotaRows(account("codex", { short_used_percent: 4, supported: false })), []);
  assert.equal(accountQuotaRows(account("claude", { stale: true, weekly_used_percent: 24 }))[0].value, 24);
  assert.deepEqual(accountQuotaRows(account("grok", { weekly_used_percent: 87 })), []);
});

it("keeps every Kimi window, including zero and optional weekly absence", () => {
  const usage = { windows: [{ kind: "five_hour", used_percent: 0, resets_at: null }, { kind: "month_total", used_percent: 42, resets_at: null }, { kind: "month_code", used_percent: 18, resets_at: null }] };
  const rows = accountQuotaRows({ engine: "kimi", usage } as Parameters<typeof accountQuotaRows>[0]);
  assert.deepEqual(rows.map(row => [row.key, row.label, row.value]), [["five_hour", "5-hour window", 0], ["month_total", "Monthly total", 42], ["month_code", "Monthly code", 18]]);
});

const { poolQuotaRows } = await import(modulePath) as typeof import("./account-usage");
const NOW = Date.parse("2026-11-26T12:00:00Z");
const hours = (h: number) => new Date(NOW + h * 3600_000).toISOString();
// Linear elapsed over a period that ends at `reset`, as periodElapsedPercent computes it.
const elapsedOf = (reset: string | null | undefined, period: { limitSeconds?: number | null }, now: number) =>
  reset && period.limitSeconds ? Math.max(0, Math.min(100, 100 - ((Date.parse(reset) - now) / (period.limitSeconds * 1000)) * 100)) : null;

it("a pool window is the mean of its reporting accounts, with the earliest reset and its coverage", () => {
  const rows = poolQuotaRows([
    account("claude", { short_used_percent: 34, short_limit_seconds: 18000, short_resets_at: hours(2), weekly_used_percent: 88, weekly_limit_seconds: 604800, weekly_resets_at: hours(75) }),
    account("claude", { short_used_percent: 9, short_limit_seconds: 18000, short_resets_at: hours(4), weekly_used_percent: 3, weekly_limit_seconds: 604800, weekly_resets_at: hours(23) }),
  ], elapsedOf, NOW);
  assert.deepEqual(rows.map(({ key, label, value, reset, reporting, of }) => ({ key, label, value, reset, reporting, of })), [
    { key: "short", label: "5-hour window", value: 21.5, reset: hours(2), reporting: 2, of: 2 },
    { key: "weekly", label: "Weekly window", value: 45.5, reset: hours(23), reporting: 2, of: 2 },
  ]);
  // 5-hour windows 3 of 5 hours and 1 of 5 hours in: the marker sits at their mean, 40%.
  assert.equal(Math.round(rows[0]!.elapsed!), 40);
});

it("an unmeasured account or a passed reset is left out of the mean, never counted as zero", () => {
  const rows = poolQuotaRows([
    account("claude", { short_used_percent: 60, short_limit_seconds: 18000, short_resets_at: hours(1) }),
    account("claude"),
    account("claude", { short_used_percent: 95, short_limit_seconds: 18000, short_resets_at: hours(-1) }),
  ], elapsedOf, NOW);
  assert.deepEqual(rows.map(({ key, value, reporting, of }) => ({ key, value, reporting, of })), [{ key: "short", value: 60, reporting: 1, of: 3 }]);
});

it("Grok pools average the reported period; unsupported usage adds nothing", () => {
  const grok = (used: number) => account("grok", { current_window: { used_percent: used, period: "weekly", starts_at: null, resets_at: hours(10), shared: true } });
  const rows = poolQuotaRows([grok(20), grok(50), account("grok", { supported: false })], elapsedOf, NOW);
  assert.deepEqual(rows.map(({ label, value, reporting, of }) => ({ label, value, reporting, of })), [{ label: "Weekly usage", value: 35, reporting: 2, of: 3 }]);
});

const { expiringAtNextReset } = await import(modulePath) as typeof import("./account-usage");

it("names the unused quota of the account whose weekly window resets first", () => {
  const soon = account("claude", { weekly_used_percent: 14, weekly_limit_seconds: 604800, weekly_resets_at: hours(21) });
  const later = account("claude", { weekly_used_percent: 86, weekly_limit_seconds: 604800, weekly_resets_at: hours(73) });
  const unmeasured = account("claude");
  const result = expiringAtNextReset([later, soon, unmeasured], NOW);
  assert.equal(result?.reset, hours(21));
  assert.deepEqual(result?.accounts.map(({ account: a, unused }) => [a, unused]), [[soon, 86]]);
});

it("groups resets within an hour of the first and skips passed or missing ones", () => {
  const a = account("claude", { weekly_used_percent: 40, weekly_resets_at: hours(5) });
  const b = account("claude", { weekly_used_percent: 10, weekly_resets_at: hours(5.5) });
  const passed = account("claude", { weekly_used_percent: 0, weekly_resets_at: hours(-1) });
  const c = account("claude", { weekly_used_percent: 0, weekly_resets_at: hours(30) });
  const result = expiringAtNextReset([a, b, passed, c], NOW);
  assert.deepEqual(result?.accounts.map(({ account: x, unused }) => [x, unused]), [[b, 90], [a, 60]]);
});

it("stays silent when nothing would be lost or no reset is dated", () => {
  assert.equal(expiringAtNextReset([account("claude", { weekly_used_percent: 100, weekly_resets_at: hours(2) })], NOW), null);
  assert.equal(expiringAtNextReset([account("claude", { weekly_used_percent: 20 })], NOW), null);
  assert.equal(expiringAtNextReset([account("claude", { supported: false })], NOW), null);
});

it("reads Grok's reported period", () => {
  const grok = account("grok", { current_window: { used_percent: 30, period: "weekly", starts_at: null, resets_at: hours(10), shared: true } });
  assert.equal(expiringAtNextReset([grok], NOW)?.accounts[0]?.unused, 70);
});
