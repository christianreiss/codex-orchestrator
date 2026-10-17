import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ProviderAccount } from "../../api/accounts";

const mod: string = "./account-state.ts";
const { accountStatus, isNearQuota, needsAttention, sortAccounts, matchesSearch, sessionHosts } = (await import(mod)) as typeof import("./account-state");

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

describe("account list helpers", () => {
  it("sorts problems first, then engine and name", () => {
    const sorted = sortAccounts([
      account({ id: 1, label: "B", engine: "grok" }), account({ id: 2, label: "A", engine: "codex" }),
      account({ id: 3, label: "Z", engine: "claude", verification_state: "failed" }), account({ id: 4, label: "P", state: "paused" }),
    ]);
    assert.deepEqual(sorted.map((a) => a.id), [3, 4, 2, 1]);
  });
  it("searches label, id, engine and skips the runner host", () => {
    assert.equal(matchesSearch(account({ id: 7, label: "Team Alpha" }), "alpha"), true);
    assert.equal(matchesSearch(account({ id: 7 }), "#7"), true);
    assert.equal(matchesSearch(account({ id: 7 }), "grok"), false);
    assert.deepEqual(sessionHosts(account({ id: 1, sessions: [{ id: "a", host_id: 0, expires_at: "" }, { id: "b", host_id: 4, expires_at: "" }, { id: "c", host_id: 4, expires_at: "" }] })), [4]);
  });
});
