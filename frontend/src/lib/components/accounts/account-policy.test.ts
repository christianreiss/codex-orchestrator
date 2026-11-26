import assert from "node:assert/strict";
import { describe, it } from "node:test";

const mod: string = "./account-policy.ts";
const { ceilingsFrom, policyIssues, policySummary, switchTargets, usesCeilings, SPREAD_POINTS, STRATEGY_OPTIONS } = (await import(mod)) as typeof import("./account-policy");

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
  it("judges the limits for every strategy that fills to them", () => {
    assert.deepEqual(policyIssues({ ...base, strategy: "reset_aware" }), {});
    assert.match(policyIssues({ ...base, strategy: "reset_aware", soft_ceiling: 95, hard_ceiling: 90 }).hard_ceiling ?? "", /below the soft/);
    assert.ok(policyIssues({ ...base, strategy: "reset_aware", soft_ceiling: 49 }).soft_ceiling);
    assert.equal(usesCeilings("exhaust"), true);
    assert.equal(usesCeilings("reset_aware"), true);
    assert.equal(usesCeilings("balanced"), false);
  });
  it("offers the three server strategies, each with a label, a hint and one explanation", () => {
    assert.deepEqual(STRATEGY_OPTIONS.map((option) => option.value), ["balanced", "exhaust", "reset_aware"]);
    for (const option of STRATEGY_OPTIONS) assert.ok(option.label && option.hint && option.explanation.endsWith("."));
  });
});

describe("limit slider", () => {
  it("passes valid thumbs through", () => assert.deepEqual(ceilingsFrom([90, 96]), { soft_ceiling: 90, hard_ceiling: 96 }));
  it("keeps the soft limit at most 99 when both thumbs reach the end", () => {
    assert.deepEqual(ceilingsFrom([100, 100]), { soft_ceiling: 99, hard_ceiling: 100 });
  });
  it("orders crossed thumbs and clamps to 50..100 whole percent", () => {
    assert.deepEqual(ceilingsFrom([97, 80]), { soft_ceiling: 80, hard_ceiling: 97 });
    assert.deepEqual(ceilingsFrom([30, 120]), { soft_ceiling: 50, hard_ceiling: 100 });
    assert.deepEqual(ceilingsFrom([85.4, Number.NaN]), { soft_ceiling: 50, hard_ceiling: 85 });
  });
  it("always yields a pair the form accepts", () => {
    for (const pair of [[50, 50], [99, 99], [100, 100], [60, 100]] as const) {
      assert.deepEqual(policyIssues({ mode: "auto", strategy: "exhaust", min_dwell_minutes: 15, ...ceilingsFrom(pair) }), {});
    }
  });
});

describe("switch targets", () => {
  const acc = (id: number, patch: Record<string, unknown> = {}) => ({ id, engine: "claude", label: `A${id}`, state: "enabled", verification_state: "verified", ...patch });
  it("offers only enabled, verified accounts of the engine other than the current one", () => {
    const options = switchTargets([acc(1), acc(2), acc(3, { state: "paused" }), acc(4, { verification_state: "failed" }), acc(5, { engine: "codex" }), acc(6, { email: "six@x.de" })], "claude", 1);
    assert.deepEqual(options, [{ value: "2", label: "A2" }, { value: "6", label: "A6 (six@x.de)" }]);
  });
});

describe("policy summary for group headers", () => {
  it("names every strategy by its form label", () => {
    assert.equal(policySummary({ mode: "auto", strategy: "balanced" }), "Automatic, Balanced");
    assert.equal(policySummary({ mode: "auto", strategy: "exhaust" }), "Automatic, Exhaust");
    assert.equal(policySummary({ mode: "auto", strategy: "reset_aware" }), "Automatic, Expiring first");
  });
  it("says Manual, and nothing before the policy has loaded", () => {
    assert.equal(policySummary({ mode: "manual", strategy: "exhaust" }), "Manual");
    assert.equal(policySummary(undefined), "");
  });
});
