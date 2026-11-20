import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { RunnerStatus } from "../../api/runner";

const needsYouModule: string = "./needs-you.ts";
const runnerModule: string = "./runner-state.ts";
const { needsYou, NEEDS_YOU_LIMIT } = (await import(needsYouModule)) as typeof import("./needs-you");
const { failedRunnerEngines, runnerToken } = (await import(runnerModule)) as typeof import("./runner-state");

type Input = import("./needs-you").NeedsYouInput;

const ok = <T>(value: T) => ({ status: "ok" as const, value });
const quiet: Input = {
  approvals: ok(0),
  agents: ok(0),
  access: ok({ windows: 0, fleetUntil: null }),
  runner: ok(0),
  accounts: ok({ attention: 0, nearQuota: 0, either: 0 }),
  feedback: ok(0),
};

describe("needs you", () => {
  it("says nothing is pending only once every readable signal answered", () => {
    assert.deepEqual(needsYou(quiet), { rows: [], failed: [], pending: false, calm: true });
    assert.equal(needsYou({ ...quiet, agents: { status: "pending" } }).calm, false);
    assert.equal(needsYou({ ...quiet, agents: { status: "pending" } }).pending, true);
    // A signal this operator may not read is neither counted nor missing.
    assert.equal(needsYou({ ...quiet, feedback: { status: "hidden" }, agents: { status: "hidden" } }).calm, true);
  });

  it("names a failed signal instead of counting it as zero", () => {
    const state = needsYou({ ...quiet, runner: { status: "error" }, approvals: ok(2) });
    assert.equal(state.calm, false);
    assert.deepEqual(state.failed, [{ id: "runner", label: "verification runner" }]);
    assert.deepEqual(state.rows.map((entry) => entry.id), ["approvals"]);
  });

  it("lists one row per signal, in order, each with a count and its owning page", () => {
    const state = needsYou({
      approvals: ok(1),
      agents: ok(3),
      access: ok({ windows: 2, fleetUntil: null }),
      runner: ok(1),
      accounts: ok({ attention: 1, nearQuota: 2, either: 2 }),
      feedback: ok(4),
    });
    assert.ok(state.rows.length <= NEEDS_YOU_LIMIT);
    assert.deepEqual(
      state.rows.map(({ id, count, href }) => [id, count, href]),
      [
        ["approvals", 1, "/hosts?insecure=1"],
        ["agents", 3, "/agents"],
        ["access", 2, "/hosts?insecure=1"],
        ["runner", 1, "/dashboard?tab=runner"],
        ["accounts", 2, "/accounts"],
        ["feedback", 4, "/reports"],
      ],
    );
    assert.equal(state.rows[0]!.text, "1 host is waiting for temporary access approval");
    assert.equal(state.rows[1]!.text, "3 agents are waiting for your answer");
    assert.equal(state.rows[4]!.text, "2 accounts need attention or are near quota");
    assert.equal(state.rows[4]!.detail, "1 needs attention · 2 near quota");
    assert.equal(state.rows[4]!.tone, "danger");
    assert.equal(state.rows[5]!.text, "4 unclaimed feedback reports");
  });

  it("puts a fleet-wide access window in the temporary access row", () => {
    const fleetOnly = needsYou({ ...quiet, access: ok({ windows: 0, fleetUntil: "2026-11-20T12:00:00Z" }) }).rows[0]!;
    assert.equal(fleetOnly.text, "Fleet-wide temporary access is open");
    assert.equal(fleetOnly.tone, "danger");
    const both = needsYou({ ...quiet, access: ok({ windows: 1, fleetUntil: "2026-11-20T12:00:00Z" }) }).rows[0]!;
    assert.equal(both.text, "Fleet-wide temporary access is open, plus 1 host window");
    assert.equal(both.count, 2);
  });
});

describe("runner state", () => {
  const base: RunnerStatus = { configured: true, url: "http://runner", ready: true, detail: "" };

  it("fails an engine the runner reported failing, and every engine when it is unreachable", () => {
    const runner = { ...base, engines: { codex: { state: "fail" }, claude: { state: "ok" } } };
    assert.deepEqual(failedRunnerEngines(runner, ["codex", "claude", "grok"]), ["codex"]);
    assert.deepEqual(failedRunnerEngines({ ...base, ready: false }, ["codex", "claude"]), ["codex", "claude"]);
  });

  it("does not count a runner that is not configured or not yet read as failing", () => {
    assert.equal(runnerToken({ ...base, configured: false }, "codex"), "unconfigured");
    assert.equal(runnerToken(null, "codex"), "idle");
    assert.deepEqual(failedRunnerEngines({ ...base, configured: false, ready: false }, ["codex"]), []);
  });

  it("reads the older combined result when an engine has no entry of its own", () => {
    assert.equal(runnerToken({ ...base, last_result: { claude: { state: "fail" } } }, "claude"), "fail");
  });
});
