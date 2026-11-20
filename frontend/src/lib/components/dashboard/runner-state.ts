/**
 * Per-engine state of the verification runner, as the Overview's Runner tab
 * shows it. Pure (type imports only) so `node --test` can load it, and shared
 * with "Needs you" so both count a failed engine the same way.
 */
import type { RunnerEngineStatus, RunnerStatus } from "../../api/runner";
import type { Engine } from "../../constants/engines";

export type RunnerToken = "ok" | "fail" | "running" | "idle" | "unconfigured";

/** The engine's own telemetry, or its entry in the older combined `last_result`. */
export function runnerEngineStatus(runner: RunnerStatus | null, engine: Engine): RunnerEngineStatus | null {
  const direct = runner?.engines?.[engine];
  if (direct) return direct;
  const legacy = runner?.last_result;
  if (legacy && typeof legacy === "object" && !Array.isArray(legacy)) {
    const candidate = legacy[engine];
    if (candidate && typeof candidate === "object" && !Array.isArray(candidate)) return candidate as RunnerEngineStatus;
  }
  return null;
}

/** What the runner last said about one engine; an unreachable runner fails every engine it has no state for. */
export function runnerToken(runner: RunnerStatus | null, engine: Engine): RunnerToken {
  if (!runner) return "idle";
  if (!runner.configured) return "unconfigured";
  const raw = (runnerEngineStatus(runner, engine)?.state ?? "").toLowerCase();
  if (raw === "running" || raw === "ok" || raw === "fail" || raw === "idle") return raw;
  return runner.ready ? "idle" : "fail";
}

/** The given (switched-on) engines whose login verification is failing. */
export function failedRunnerEngines(runner: RunnerStatus | null, engines: readonly Engine[]): Engine[] {
  return engines.filter((engine) => runnerToken(runner, engine) === "fail");
}
