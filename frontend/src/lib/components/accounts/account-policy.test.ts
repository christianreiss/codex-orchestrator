import assert from "node:assert/strict";
import { describe, it } from "node:test";

const mod: string = "./account-policy.ts";
const { policyIssues, switchTargets, SPREAD_POINTS } = (await import(mod)) as typeof import("./account-policy");

const base = { mode: "auto", strategy: "exhaust", soft_ceiling: 90, hard_ceiling: 99, min_dwell_minutes: 15 } as const;

describe("policy form validation", () => {
  it("accepts the defaults", () => assert.deepEqual(policyIssues(base), {}));
  it("rejects a hard limit below the soft limit", () => {
    assert.match(policyIssues({ ...base, soft_ceiling: 95, hard_ceiling: 90 }).hard_ceiling ?? "", /below the soft/);
  });
  it("bounds the soft limit, the hard limit and the dwell time", () => {
    assert.ok(policyIssues({ ...base, soft_ceiling: 49 }).soft_ceiling);
    assert.ok(policyIssues({ ...base, soft_ceiling: 100 }).soft_ceiling);
    assert.ok(policyIssues({ ...base, hard_ceiling: 101 }).hard_ceiling);
    assert.ok(policyIssues({ ...base, min_dwell_minutes: 241 }).min_dwell_minutes);
    assert.ok(policyIssues({ ...base, min_dwell_minutes: Number.NaN }).min_dwell_minutes);
  });
  it("ignores fields the chosen mode hides", () => {
    assert.deepEqual(policyIssues({ ...base, strategy: "balanced", soft_ceiling: Number.NaN }), {});
    assert.deepEqual(policyIssues({ ...base, mode: "manual", min_dwell_minutes: -1 }), {});
  });
  it("names the band widths from the contract", () => assert.deepEqual(SPREAD_POINTS, { eng: 10, normal: 20, locker: 30 }));
});

describe("switch targets", () => {
  const acc = (id: number, patch: Record<string, unknown> = {}) => ({ id, engine: "claude", label: `A${id}`, state: "enabled", verification_state: "verified", ...patch });
  it("offers only enabled, verified accounts of the engine other than the current one", () => {
    const options = switchTargets([acc(1), acc(2), acc(3, { state: "paused" }), acc(4, { verification_state: "failed" }), acc(5, { engine: "codex" }), acc(6, { email: "six@x.de" })], "claude", 1);
    assert.deepEqual(options, [{ value: "2", label: "A2" }, { value: "6", label: "A6 (six@x.de)" }]);
  });
});
