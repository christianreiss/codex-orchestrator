import assert from "node:assert/strict";
import { it } from "node:test";
import type { ProviderAccount } from "../../api/accounts";

const modulePath: string = "./attention.ts";
const { buildAttention, peakUsage } = (await import(modulePath)) as typeof import("./attention");

function account(id: number, changes: Partial<ProviderAccount> = {}, usage: Partial<ProviderAccount["usage"]> = {}): ProviderAccount {
  return {
    id, engine: "claude", label: `acct-${id}`, state: "enabled", verification_state: "verified", verification_reason: null,
    verification_checked_at: null, generation: 1, sessions: [],
    usage: { fetched_at: null, stale: false, short_used_percent: null, short_resets_at: null, weekly_used_percent: null, weekly_resets_at: null, ...usage },
    ...changes,
  };
}

it("is empty when nothing is wrong", () => {
  assert.deepEqual(buildAttention({ hosts: { authProblems: [], versionProblems: [] }, pendingApprovals: 0, accounts: [account(1)] }), []);
});

it("orders danger before warning before info and links every item to a fix", () => {
  const items = buildAttention({
    pendingApprovals: 2,
    staleReleaseChecks: ["Codex"],
    hosts: { authProblems: ["a.example"], versionProblems: [] },
    accounts: [account(1, { refresh_state: "login_required" })],
  });
  assert.deepEqual(items.map((i) => i.tone), ["danger", "danger", "warning", "info"]);
  assert.ok(items.every((i) => i.href.startsWith("/") && i.action));
  assert.equal(items[0].id, "hosts-auth");
});

it("flags near-quota and exhausted accounts but skips paused ones and unsupported usage", () => {
  const items = buildAttention({
    accounts: [
      account(1, {}, { weekly_used_percent: 93 }),
      account(2, {}, { short_used_percent: 100 }),
      account(3, { state: "paused" }, { weekly_used_percent: 99 }),
      account(4, {}, { supported: false, weekly_used_percent: 99 }),
      account(5, {}, { weekly_used_percent: 40 }),
    ],
  });
  assert.deepEqual(items.map((i) => [i.id, i.tone]), [["account-2-quota", "danger"], ["account-1-quota", "warning"]]);
});

it("reads Grok windows for the peak reading", () => {
  assert.equal(peakUsage(account(1, { engine: "grok" }, { current_window: { used_percent: 87, period: "weekly", starts_at: null, resets_at: null, shared: null } })), 87);
  assert.equal(peakUsage(account(1)), null);
});

it("reports a failed approvals check separately from zero approvals", () => {
  assert.equal(buildAttention({ pendingApprovals: null })[0].id, "approvals-check");
  assert.equal(buildAttention({ pendingApprovals: 1 })[0].title, "1 host waiting for temporary access");
});

it("reports runner failures and expiring logins", () => {
  const ids = buildAttention({
    runner: {
      configured: true, url: null, ready: true, detail: "",
      engines: { claude: { state: "fail", last_error: "boom", login_expiry: { state: "expiring", expires_at: null, days_remaining: 1 } } },
    },
  }).map((i) => i.id);
  assert.deepEqual(ids, ["runner-claude-fail", "runner-claude-expiring"]);
  assert.equal(buildAttention({ runner: { configured: false, url: null, ready: false, detail: "" } })[0].id, "runner-unconfigured");
});

it("summarises fleet-wide engine switches", () => {
  assert.equal(buildAttention({ allEnginesDisabled: true, disabledEngines: ["Codex"] })[0].id, "engines-all-off");
  assert.match(buildAttention({ disabledEngines: ["Codex", "Grok"] })[0].title, /Codex, Grok are switched off/);
});
