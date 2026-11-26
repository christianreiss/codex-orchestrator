import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ProviderAccount } from "../../api/accounts";

const mod: string = "./account-state.ts";
const {
  accountStatus, isNearQuota, needsAttention, sortAccounts, matchesSearch, sessionHosts, enginePools, nearQuotaCounted, poolCoveredIds, scoreText,
  poolState, poolUsageText, accountEntries, entryKey, parseOpen, toggleOpen, displayName,
} = (await import(mod)) as typeof import("./account-state");

function account(patch: Partial<ProviderAccount> & { id: number }): ProviderAccount {
  return {
    engine: "claude", label: `Account ${patch.id}`, state: "enabled", verification_state: "verified", verification_reason: null,
    verification_checked_at: null, generation: 1, refresh_state: "idle", sessions: [],
    usage: { fetched_at: null, stale: false, short_used_percent: 10, short_resets_at: null, weekly_used_percent: 10, weekly_resets_at: null },
    ...patch,
  };
}

describe("account status", () => {
  it("states problems in plain words, login first", () => {
    const login = account({ id: 1, refresh_state: "login_required", state: "paused" });
    assert.equal(accountStatus(login, true, "clx").label, "Login needs renewal");
    assert.match(accountStatus(login, true, "clx").detail ?? "", /clx login/);
    assert.equal(accountStatus(account({ id: 2, verification_state: "failed", verification_reason: "bad token" }), true, "clx").detail, "bad token");
    assert.equal(accountStatus(account({ id: 3, state: "paused" }), true, "clx").label, "Paused");
    assert.equal(accountStatus(account({ id: 4 }), false, "clx").label, "Engine off");
    assert.equal(accountStatus(account({ id: 5, state: "removing" }), true, "clx").label, "Removing");
    assert.equal(accountStatus(account({ id: 6 }), true, "clx").label, "Active");
  });
  it("flags near quota at 80% on either window", () => {
    assert.equal(isNearQuota(account({ id: 1 })), false);
    assert.equal(isNearQuota(account({ id: 2, usage: { ...account({ id: 2 }).usage, weekly_used_percent: 80 } })), true);
    assert.equal(accountStatus(account({ id: 3, usage: { ...account({ id: 3 }).usage, short_used_percent: 95 } }), true, "clx").label, "Near quota");
  });
  it("needs attention only for broken logins or verification", () => {
    assert.equal(needsAttention(account({ id: 1, verification_state: "failed" })), true);
    assert.equal(needsAttention(account({ id: 2, state: "paused" })), false);
  });
});

describe("account pools", () => {
  const high = (id: number, patch: Partial<ProviderAccount> = {}) =>
    account({ id, usage: { ...account({ id }).usage, weekly_used_percent: 87 }, pool: { score: 87, usable: true, emulation_blocked: false }, ...patch });
  const fresh = (id: number, patch: Partial<ProviderAccount> = {}) =>
    account({ id, usage: { ...account({ id }).usage, short_used_percent: null, weekly_used_percent: null }, pool: { score: null, usable: true, emulation_blocked: false }, ...patch });

  it("is not near quota while another usable account has headroom", () => {
    // Production shape: #1 at 87% weekly, #8 just enrolled without a reading.
    const accounts = [high(1), fresh(8)];
    const [pool] = enginePools(accounts);
    assert.equal(pool.pooled, true);
    assert.equal(pool.nearQuota, false);
    assert.equal(pool.best?.id, 8);
    assert.deepEqual(pool.high.map((a) => a.id), [1]);
    assert.deepEqual(nearQuotaCounted(accounts), []);
    assert.deepEqual([...poolCoveredIds(accounts)], [1]);
    assert.equal(scoreText(pool.best!), "no reading yet");
    assert.equal(accountStatus(high(1), true, "clx", true).detail, "Other accounts have headroom");
  });

  it("is near quota when every usable account is high", () => {
    const accounts = [high(1), high(2, { pool: { score: 91, usable: true, emulation_blocked: false } })];
    assert.equal(enginePools(accounts)[0].nearQuota, true);
    assert.deepEqual(nearQuotaCounted(accounts).map((a) => a.id), [1, 2]);
    assert.equal(poolCoveredIds(accounts).size, 0);
  });

  it("never counts paused or unverified accounts as headroom", () => {
    const accounts = [high(1), fresh(2, { state: "paused", pool: { score: null, usable: false, emulation_blocked: false } }), fresh(3, { verification_state: "pending", pool: { score: null, usable: false, emulation_blocked: false } })];
    const [pool] = enginePools(accounts);
    assert.equal(pool.pooled, false);
    assert.deepEqual(nearQuotaCounted(accounts).map((a) => a.id), [1]);
  });

  it("uses the server score: a passed reset is headroom, an emulated block is not", () => {
    const passed = high(2, { pool: { score: 30, usable: true, emulation_blocked: false } });
    assert.equal(enginePools([high(1), passed])[0].nearQuota, false);
    const blocked = account({ id: 3, pool: { score: 100, usable: true, emulation_blocked: true } });
    const pools = enginePools([high(1), blocked]);
    assert.equal(pools[0].nearQuota, true);
    assert.deepEqual(pools[0].high.map((a) => a.id), [1, 3]);
  });

  it("keeps the per-account rule for single-account engines and judges engines apart", () => {
    const accounts = [high(1), high(2, { engine: "codex" }), fresh(3, { engine: "codex" })];
    assert.deepEqual(enginePools(accounts).map((p) => p.engine), ["codex", "claude"]);
    assert.deepEqual(nearQuotaCounted(accounts).map((a) => a.id), [1]);
    // Without server pool data the highest window decides, as before.
    assert.deepEqual(nearQuotaCounted([account({ id: 4, usage: { ...account({ id: 4 }).usage, short_used_percent: 95 } })]).map((a) => a.id), [4]);
  });
});

describe("account groups", () => {
  const usage = (id: number, short: number | null, weekly: number | null) => ({ ...account({ id }).usage, short_used_percent: short, weekly_used_percent: weekly });
  const row = (id: number, short: number | null, weekly: number | null, patch: Partial<ProviderAccount> = {}) => {
    const score = short === null && weekly === null ? null : Math.max(short ?? 0, weekly ?? 0);
    return account({ id, usage: usage(id, short, weekly), pool: { score, short, weekly, usable: true, emulation_blocked: false }, ...patch });
  };

  it("leads the header with the pool state and states the averages with their coverage", () => {
    // Production shape: one busy account, one without a reading. One busy account is not the pool.
    const [pool] = enginePools([row(1, 10, 87), row(8, null, null)]);
    assert.deepEqual(poolState(pool), { tone: "success", label: "OK" });
    assert.equal(pool.avgShort, 10);
    assert.equal(pool.avgWeekly, 87);
    assert.equal(poolUsageText(pool), "Least used: Account 8 (no reading yet) · average short 10%, weekly 87% (1 of 2 reporting)");
    const [both] = enginePools([row(1, 10, 87), row(2, 30, 20)]);
    assert.equal(poolUsageText(both), "Least used: Account 2 (30%) · average short 20%, weekly 54% (2 of 2 reporting)");
  });

  it("averages the windows as the server scores them, never a passed window", () => {
    const passed = account({ id: 2, usage: usage(2, 20, 95), pool: { score: 20, short: 20, weekly: null, usable: true, emulation_blocked: false } });
    const [pool] = enginePools([row(1, 40, 60), passed]);
    assert.equal(pool.avgWeekly, 60);
    assert.equal(pool.avgShort, 30);
  });

  it("states problems before quota and near quota only for a whole pool", () => {
    assert.deepEqual(poolState(enginePools([row(1, 90, 90), row(2, 85, 10)])[0]), { tone: "warning", label: "Pool near quota" });
    assert.deepEqual(poolState(enginePools([row(1, 90, 90), row(2, 10, 10, { verification_state: "failed" })])[0]), { tone: "danger", label: "1 needs attention" });
    const paused = { state: "paused" as const, pool: { score: 10, usable: false, emulation_blocked: false } };
    const [none] = enginePools([row(1, 10, 10, paused), row(2, 10, 10, paused)]);
    assert.deepEqual(poolState(none), { tone: "warning", label: "No usable account" });
    assert.equal(poolUsageText(none), "");
  });

  it("groups engines with several accounts and keeps single accounts as rows", () => {
    const broken = row(5, 10, 10, { engine: "codex", refresh_state: "login_required" });
    const accounts = [row(1, 10, 10), row(2, 90, 10), broken, row(6, 10, 10, { engine: "grok" })];
    const problems = accountEntries(accounts);
    assert.deepEqual(problems.map(entryKey), ["account:5", "engine:claude", "account:6"]);
    const group = problems[1];
    assert.equal(group.kind, "group");
    if (group.kind === "group") assert.deepEqual(group.rows.map((a) => a.id), [2, 1]);
    const listed = accountEntries([row(6, 10, 10, { engine: "grok" }), row(1, 10, 10), row(2, 90, 10)], "listed");
    assert.deepEqual(listed.map(entryKey), ["account:6", "engine:claude"]);
    if (listed[1].kind === "group") assert.deepEqual(listed[1].rows.map((a) => a.id), [1, 2]);
  });

  it("keeps the expanded engines in one URL value", () => {
    assert.equal(toggleOpen("", "claude"), "claude");
    assert.equal(toggleOpen("claude", "codex"), "codex,claude");
    assert.equal(toggleOpen("codex,claude", "claude"), "codex");
    assert.deepEqual([...parseOpen(" claude, ,kimi")], ["claude", "kimi"]);
    assert.equal(parseOpen(null).size, 0);
  });

  it("never shows a default label that reads like the provider", () => {
    assert.equal(displayName({ id: 1, label: "Claude", email: null }), "Claude account #1");
    assert.equal(displayName({ id: 3, label: "Claude account" }), "Claude account #3");
    assert.equal(displayName({ id: 4, label: "Kimi Code 2" }), "Kimi Code account #4");
    assert.equal(displayName({ id: 1, label: "Claude", email: "ops@example.test" }), "ops@example.test");
    assert.equal(displayName({ id: 8, label: "ops@example.test", email: "ops@example.test" }), "ops@example.test");
    assert.equal(displayName({ id: 9, label: "ChatGPT Team" }), "ChatGPT Team");
  });
});

describe("account list helpers", () => {
  it("sorts problems first, then engine and name", () => {
    const sorted = sortAccounts([
      account({ id: 5, label: "Kimi", engine: "kimi" }), account({ id: 1, label: "B", engine: "grok" }), account({ id: 2, label: "A", engine: "codex" }),
      account({ id: 3, label: "Z", engine: "claude", verification_state: "failed" }), account({ id: 4, label: "P", state: "paused" }),
    ]);
    assert.deepEqual(sorted.map((a) => a.id), [3, 4, 2, 1, 5]);
  });
  it("searches label, id, engine and skips the runner host", () => {
    assert.equal(matchesSearch(account({ id: 7, label: "Team Alpha" }), "alpha"), true);
    assert.equal(matchesSearch(account({ id: 7 }), "#7"), true);
    assert.equal(matchesSearch(account({ id: 7 }), "grok"), false);
    assert.deepEqual(sessionHosts(account({ id: 1, sessions: [{ id: "a", host_id: 0, expires_at: "" }, { id: "b", host_id: 4, expires_at: "" }, { id: "c", host_id: 4, expires_at: "" }] })), [4]);
  });
});
