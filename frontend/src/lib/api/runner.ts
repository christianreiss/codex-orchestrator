/**
 * Runner verification API surface.
 *
 * Backs the dashboard "Runner state" card. Wraps:
 *   - GET  /admin/runner               → current proxy status
 *   - POST /admin/runner/run           → trigger Codex verification
 *   - POST /admin/runner/run-claude    → trigger Claude verification
 *
 * The /admin/runner response shape comes from `RunnerProxyService.status()`
 * (api/src/services/runner-proxy.ts) — currently a minimal probe of the
 * proxy's configuration. The legacy PHP controller surfaced richer fields
 * (state / last_run / last_error / last_result) sourced from the
 * `versions` table; we leave those typed as optional so the card renders
 * gracefully whether the backend has been upgraded to expose them yet or
 * not.
 *
 * No WebSocket events exist for runner state changes today, so the card
 * polls via `refetchInterval`.
 */
import { api, ApiError } from "./client";
import { createQuery, createMutation, useQueryClient } from "@tanstack/svelte-query";

/* Response shapes ------------------------------------------------------- */

/**
 * Mirrors the {@link RunnerStatus} interface in
 * `api/src/services/runner-proxy.ts`.
 *
 * Optional legacy fields (`state`, `last_run`, `last_error`, `last_result`)
 * are not emitted by the current proxy stub but were present on the legacy
 * PHP `/admin/runner` payload — kept here so the UI can render them when
 * the backend backfills them.
 */
export interface RunnerStatus {
  configured: boolean;
  url: string | null;
  ready: boolean;
  detail: string;
  /** Optional: one of `idle` | `running` | `ok` | `fail`. */
  state?: string | null;
  /** Optional ISO timestamp of the most recent verification attempt. */
  last_run?: string | null;
  /** Optional last error message (when state === "fail"). */
  last_error?: string | null;
  /** Optional last successful result blob (string or structured payload). */
  last_result?: string | Record<string, unknown> | null;
}

export interface RunnerStateResponse {
  runner: RunnerStatus;
}

/**
 * Mirrors {@link RunnerRunResult} in `api/src/services/runner-proxy.ts`.
 * The actual proxy implementation also surfaces engine-specific extras
 * from the runner-client; we accept any additional keys.
 */
export interface RunnerRunResult {
  status: "ok" | "error" | "fail" | string;
  output?: string;
  detail?: string;
  reason?: string;
  reachable?: boolean;
  latency_ms?: number;
  updated_auth?: Record<string, unknown>;
  [key: string]: unknown;
}

/* Query keys ------------------------------------------------------------ */

export const runnerKeys = {
  state: () => ["runner", "state"] as const,
};

/* Query / mutation builders -------------------------------------------- */

/**
 * Polls `/admin/runner` every 15 s. No WebSocket events exist for runner
 * state today (see grep over `api/src` for `runner.` publish calls) — the
 * polling interval is the sole refresh trigger.
 */
export function createRunnerStateQuery() {
  return createQuery<RunnerStateResponse>({
    queryKey: runnerKeys.state(),
    queryFn: () => api.get<RunnerStateResponse>("/admin/runner"),
    refetchInterval: 15_000,
  });
}

export function createRunCodexRunnerMutation() {
  const qc = useQueryClient();
  return createMutation<RunnerRunResult, ApiError, void>({
    mutationFn: () => api.post<RunnerRunResult>("/admin/runner/run", {}),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: runnerKeys.state() });
    },
  });
}

export function createRunClaudeRunnerMutation() {
  const qc = useQueryClient();
  return createMutation<RunnerRunResult, ApiError, void>({
    mutationFn: () => api.post<RunnerRunResult>("/admin/runner/run-claude", {}),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: runnerKeys.state() });
    },
  });
}
