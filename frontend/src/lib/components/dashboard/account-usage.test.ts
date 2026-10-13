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
