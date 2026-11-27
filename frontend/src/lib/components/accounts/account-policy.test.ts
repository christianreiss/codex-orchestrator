import assert from "node:assert/strict";
import { describe, it } from "node:test";

const mod: string = "./account-policy.ts";
const { ceilingsFrom, policyIssues, policySummary, scopePauseStatus, switchTargets, usesCeilings, SPREAD_POINTS, STRATEGY_OPTIONS } = (await import(mod)) as typeof import("./account-policy");

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

describe("pausing sessions for a switch", () => {
  it("judges the two durations only while pausing is on, in either mode", () => {
    assert.deepEqual(policyIssues({ ...base, pause: "off", pause_after_seconds: -1, pause_hold_seconds: 9999 }), {});
    assert.deepEqual(policyIssues({ ...base, pause: "on", pause_after_seconds: 120, pause_hold_seconds: 90 }), {});
    assert.ok(policyIssues({ ...base, pause: "on", pause_after_seconds: 3601, pause_hold_seconds: 90 }).pause_after_seconds);
    assert.ok(policyIssues({ ...base, pause: "on", pause_after_seconds: 0, pause_hold_seconds: 29 }).pause_hold_seconds);
    assert.ok(policyIssues({ ...base, pause: "on", pause_after_seconds: 0, pause_hold_seconds: 301 }).pause_hold_seconds);
    // An operator's own switch is paused for as well, so manual mode judges them too.
    assert.ok(policyIssues({ ...base, mode: "manual", pause: "on", pause_after_seconds: Number.NaN, pause_hold_seconds: 90 }).pause_after_seconds);
    // A server before pause rounds sends none of the fields.
    assert.deepEqual(policyIssues(base), {});
  });

  const idle = { pausable: true, blocked_by: [], round: null, last: null, retry_at: null };
  it("says nothing when there is nothing to say", () => {
    assert.equal(scopePauseStatus({ pending: false, sessions: 3, pause: idle }), null);
    assert.equal(scopePauseStatus({ pending: true, sessions: 3, pause: idle }), null);
    assert.equal(scopePauseStatus({ pending: true, sessions: 3, pause: null }), null);
    assert.equal(scopePauseStatus({ pending: true, sessions: 3 }), null);
  });
  it("counts the sessions of a running round", () => {
    const round = { ready_at: null, sessions: [{ state: "paused" }, { state: "requested" }, { state: "paused" }] };
    assert.deepEqual(scopePauseStatus({ pending: true, sessions: 3, pause: { ...idle, round } }), { tone: "active", text: "Pausing sessions: 2 of 3 paused.", retryAt: null });
    const ready = { ready_at: "2026-11-27T10:00:00Z", sessions: [{ state: "paused" }] };
    assert.equal(scopePauseStatus({ pending: true, sessions: 1, pause: { ...idle, round: ready } })?.text, "All 1 session is paused. Switching now.");
  });
  it("names why a pending switch cannot be paused for", () => {
    const status = scopePauseStatus({ pending: true, sessions: 3, pause: { ...idle, pausable: false, blocked_by: [{ session_id: "a", reason: "no_hooks" }] } });
    assert.equal(status?.tone, "blocked");
    assert.match(status?.text ?? "", /^Cannot pause for this switch: 1 session of 3 was started before pausing was available/);
    assert.match(status?.text ?? "", /waits for a gap between turns\.$/);
    const two = scopePauseStatus({ pending: true, sessions: 4, pause: { ...idle, pausable: false, blocked_by: [{ session_id: "a", reason: "detached" }, { session_id: "b", reason: "timed_lease" }] } });
    assert.match(two?.text ?? "", /2 sessions of 4 is not connected right now/);
    // Without a pending switch it is not the operator's problem yet.
    assert.equal(scopePauseStatus({ pending: false, sessions: 3, pause: { ...idle, pausable: false, blocked_by: [{ session_id: "a", reason: "no_hooks" }] } }), null);
  });
  it("reports how the last round ended and when the next may start", () => {
    const last = { outcome: "deadline", paused: 2, asked: 3, detail: null };
    assert.deepEqual(scopePauseStatus({ pending: true, sessions: 3, pause: { ...idle, last, retry_at: "2026-11-27T10:05:00Z" } }), {
      tone: "info",
      text: "The last pause ran out of time with 2 of 3 sessions paused.",
      retryAt: "2026-11-27T10:05:00Z",
    });
    assert.equal(scopePauseStatus({ pending: true, sessions: 3, pause: { ...idle, last: { outcome: "failed", paused: 3, asked: 3, detail: "flush: server says no" } } })?.text, "The last pause failed (flush: server says no).");
    assert.equal(scopePauseStatus({ pending: true, sessions: 3, pause: { ...idle, last: { outcome: "switched", paused: 3, asked: 3, detail: null } } }), null);
  });
});
