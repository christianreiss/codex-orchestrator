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

/* Claude ---------------------------------------------------------------- */

export interface ClaudeVersionResponse {
  client_version?: string | null;
  client_version_lock?: string | null;
  client_version_enforce_exact?: boolean;
  client_version_lock_updated_at?: string | null;
}

/* Query keys ------------------------------------------------------------ */

export const usageKeys = {
  chatgpt: ["usage", "chatgpt"] as const,
  chatgptHistory: (days = 60) => ["usage", "chatgpt", "history", days] as const,
  claudeVersion: ["usage", "claude", "version"] as const,
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

export function claudeVersionQuery() {
  return createQuery<ClaudeVersionResponse>({
    queryKey: usageKeys.claudeVersion,
    queryFn: () => api.get<ClaudeVersionResponse>("/admin/claude/version"),
  });
}

/* Aggregations --------------------------------------------------------- */

/** Find the most "interesting" ChatGPT series (highest absolute usage). */
export function pickPrimaryChatgptSeries(history: ChatGptHistoryResponse | undefined): ChatGptHistorySeries | null {
  if (!history || !history.series || history.series.length === 0) return null;
  // Prefer secondary (weekly) over primary (5h) when both exist; users care more about it.
  const secondary = history.series.find((s) => s.key.endsWith("_secondary"));
  if (secondary && secondary.points.length > 0) return secondary;
  return history.series.find((s) => s.points.length > 0) ?? history.series[0];
}
