/**
 * Usage endpoints — ChatGPT quota + Claude usage history.
 *
 * Hand-typed against the actual response shapes from
 * AdminOverviewController + AdminSettingsController. Feature-local;
 * the dashboard is currently the sole consumer.
 */
import { api } from "./client";
import { createQuery, createMutation, useQueryClient } from "@tanstack/svelte-query";

/* ChatGPT --------------------------------------------------------------- */

export interface ChatGptWindow {
  used_percent?: number | null;
  limit_seconds?: number | null;
  reset_after_seconds?: number | null;
  resets_at?: string | null;
  [key: string]: unknown;
}

export interface ChatGptUsageSummary {
  status?: string | null;
  plan_type?: string | null;
  rate_allowed?: boolean | null;
  rate_limit_reached?: boolean | null;
  active_quota_lane?: "normal" | "spark" | string;
  fetched_at?: string | null;
  next_eligible_at?: string | null;
  primary_window?: ChatGptWindow | null;
  secondary_window?: ChatGptWindow | null;
  normal_window?: {
    primary_window?: ChatGptWindow | null;
    secondary_window?: ChatGptWindow | null;
  } | null;
  spark_window?: {
    primary_window?: ChatGptWindow | null;
    secondary_window?: ChatGptWindow | null;
  } | null;
  daily_used_percent?: number | null;
  daily_baseline_at?: string | null;
  [key: string]: unknown;
}

export interface ChatGptUsageResponse {
  /** Raw snapshot row — may be null when no fetch has succeeded yet. */
  snapshot?: Record<string, unknown> | null;
  cached?: boolean;
  next_eligible_at?: string | null;
  /** Optional summary surface — the controller returns the snapshot block. */
  [key: string]: unknown;
}

export interface ChatGptHistorySeriesPoint {
  ts: string;
  value: number;
}

export interface ChatGptHistorySeries {
  key: string;
  label: string;
  points: ChatGptHistorySeriesPoint[];
}

export interface ChatGptHistoryResponse {
  days: number;
  since?: string;
  from?: string;
  until?: string;
  interval: "raw" | "hour" | "day" | string;
  lane: "normal" | "spark" | "both" | string;
  window: "primary" | "secondary" | "both" | string;
  series: ChatGptHistorySeries[];
  points?: Array<Record<string, unknown>>;
}

/* Claude ------------------------------------------------------------------
 *
 * Unlike ChatGPT usage, this is never fetched by the server: the orchestrator
 * holds no Claude OAuth token and calls no Anthropic/claude.ai endpoint for
 * it (Anthropic's Consumer ToS prohibits third-party use of a subscription's
 * OAuth token). Rows are PUSHED by the clx wrapper's fleet-owned statusLine
 * command from Claude Code's own already-computed `rate_limits` reading, so
 * there is no refresh mutation here — the server has nothing of its own to
 * re-fetch on demand. */

export interface ClaudeUsageWindow {
  used_percent?: number | null;
  resets_at?: string | null;
  [key: string]: unknown;
}

export interface ClaudeUsageSnapshot {
  source?: string | null;
  five_hour_used_percent?: number | null;
  five_hour_resets_at?: string | null;
  seven_day_used_percent?: number | null;
  seven_day_resets_at?: string | null;
  five_hour_window?: ClaudeUsageWindow | null;
  seven_day_window?: ClaudeUsageWindow | null;
  fetched_at?: string | null;
  [key: string]: unknown;
}

export interface ClaudeUsageResponse {
  snapshot?: ClaudeUsageSnapshot | null;
  [key: string]: unknown;
}

export interface ClaudeHistoryResponse {
  days: number;
  from?: string;
  until?: string;
  series: ChatGptHistorySeries[];
}

/* Query keys ------------------------------------------------------------ */

export const usageKeys = {
  chatgpt: ["usage", "chatgpt"] as const,
  chatgptHistory: (days = 60) => ["usage", "chatgpt", "history", days] as const,
  claude: ["usage", "claude"] as const,
  claudeHistory: (days = 60) => ["usage", "claude", "history", days] as const,
};

/* Query / mutation builders -------------------------------------------- */

export function chatgptUsageQuery() {
  return createQuery<ChatGptUsageResponse>({
    queryKey: usageKeys.chatgpt,
    queryFn: () => api.get<ChatGptUsageResponse>("/admin/chatgpt/usage"),
  });
}

export function chatgptHistoryQuery(days = 60) {
  return createQuery<ChatGptHistoryResponse>({
    queryKey: usageKeys.chatgptHistory(days),
    queryFn: () =>
      api.get<ChatGptHistoryResponse>(`/admin/chatgpt/usage/history?days=${days}&interval=day`),
  });
}

export function chatgptRefreshMutation() {
  const qc = useQueryClient();
  return createMutation<ChatGptUsageResponse, Error, void>({
    mutationFn: () => api.post<ChatGptUsageResponse>("/admin/chatgpt/usage/refresh"),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["usage", "chatgpt"] });
      void qc.invalidateQueries({ queryKey: ["overview"] });
    },
  });
}

export function claudeUsageQuery() {
  return createQuery<ClaudeUsageResponse>({
    queryKey: usageKeys.claude,
    queryFn: () => api.get<ClaudeUsageResponse>("/admin/claude/usage"),
  });
}

export function claudeHistoryQuery(days = 60) {
  return createQuery<ClaudeHistoryResponse>({
    queryKey: usageKeys.claudeHistory(days),
    queryFn: () => api.get<ClaudeHistoryResponse>(`/admin/claude/usage/history?days=${days}`),
  });
}

/* Aggregations --------------------------------------------------------- */

/**
 * Pick the ChatGPT series the dashboard charts. Nothing is compared by
 * magnitude: a series whose key ends in `_secondary` wins as long as it has
 * points, else the first series that has any points, else `series[0]` — which
 * is empty whenever every series is.
 */
export function pickPrimaryChatgptSeries(history: ChatGptHistoryResponse | undefined): ChatGptHistorySeries | null {
  if (!history || !history.series || history.series.length === 0) return null;
  // Prefer secondary (weekly) over primary (5h) when both exist; users care more about it.
  const secondary = history.series.find((s) => s.key.endsWith("_secondary"));
  if (secondary && secondary.points.length > 0) return secondary;
  return history.series.find((s) => s.points.length > 0) ?? history.series[0];
}

const FIVE_HOURS_SECONDS = 5 * 60 * 60;
const SEVEN_DAYS_SECONDS = 7 * 24 * 60 * 60;

/**
 * chatgpt.com's usage payload doesn't guarantee `primary_window` is always
 * the 5-hour lane and `secondary_window` the weekly one — the cxx CLI
 * wrapper already learned this the hard way and derives its label from the
 * window's actual `limit_seconds` (see quotaWindowLabel in
 * wrappers/cxx/internal/persona/codex/summary/summary.go) instead of
 * trusting field position. Mirror that here so the dashboard can't mislabel
 * a window when a window's duration doesn't match its usual slot.
 */
export function chatgptWindowLabel(limitSeconds: number | null | undefined, fallback: string): string {
  if (typeof limitSeconds !== "number" || !Number.isFinite(limitSeconds) || limitSeconds <= 0) {
    return fallback;
  }
  if (limitSeconds === FIVE_HOURS_SECONDS) return "5-hour window";
  if (limitSeconds === SEVEN_DAYS_SECONDS) return "Weekly window";
  if (limitSeconds % 86400 === 0) return `${limitSeconds / 86400}-day window`;
  if (limitSeconds % 3600 === 0) return `${limitSeconds / 3600}-hour window`;
  return fallback;
}
