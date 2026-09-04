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
  /** Present on ChatGPT quota series; the Claude history reuses this shape without them. */
  lane?: "normal" | "spark";
  window?: "primary" | "secondary";
  /** The window length this slot currently measures against, from the newest point that reports one. */
  limit_seconds?: number | null;
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

function seriesLane(series: ChatGptHistorySeries): "normal" | "spark" {
  return series.lane ?? (series.key.startsWith("spark") ? "spark" : "normal");
}

/**
 * Rank a series for the sparkline: the normal lane always outranks spark, and
 * within a lane the longer window wins. A series with no reported window
 * length ranks last inside its lane, which leaves the declaration order
 * (primary before secondary) as the tiebreak.
 */
function chatgptSeriesRank(series: ChatGptHistorySeries): number {
  const laneWeight = seriesLane(series) === "normal" ? 1_000_000_000 : 0;
  const limit =
    typeof series.limit_seconds === "number" && series.limit_seconds > 0 ? series.limit_seconds : 0;
  return laneWeight + limit;
}

/**
 * Pick the ChatGPT series the dashboard charts: of the series that actually
 * have points, the highest-ranked one.
 *
 * This used to take the first series whose key ended `_secondary` — the same
 * trust-the-field-position reasoning `chatgptWindowLabel` below exists to
 * undo. chatgpt.com moved the normal lane's weekly quota into
 * `primary_window` on 2026-07-11 and stopped sending a secondary window at
 * all, so that rule kept selecting `normal_secondary`: a lane whose newest
 * point predates the change, drawn as if it were current.
 */
export function pickPrimaryChatgptSeries(history: ChatGptHistoryResponse | undefined): ChatGptHistorySeries | null {
  if (!history || !history.series || history.series.length === 0) return null;
  const withPoints = history.series.filter((s) => s.points.length > 0);
  if (withPoints.length === 0) return history.series[0];
  return withPoints.reduce((best, s) => (chatgptSeriesRank(s) > chatgptSeriesRank(best) ? s : best));
}

/**
 * Label one history series for the chart legend. Falls back to the server's
 * own label whenever the series reports no window length — there is nothing
 * more truthful to say than what the server already said.
 */
export function chatgptSeriesLabel(series: ChatGptHistorySeries): string {
  if (typeof series.limit_seconds !== "number" || series.limit_seconds <= 0) return series.label;
  const lane = seriesLane(series) === "spark" ? "Spark" : "Normal";
  return `${lane} · ${chatgptWindowLabel(series.limit_seconds, series.label)}`;
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

/* Quota rows ------------------------------------------------------------ */

/** One quota bar on the ChatGPT card: a window the provider actually reported. */
export interface ChatGptQuotaRow {
  key: "normal_primary" | "normal_secondary" | "spark_primary" | "spark_secondary";
  lane: "normal" | "spark";
  label: string;
  usedPercent: number;
}

/**
 * Build one row per quota window chatgpt.com actually reported, in the order
 * the cxx CLI prints them.
 *
 * A slot is skipped when its window carries no `used_percent`, mirroring
 * `addRow` in wrappers/cxx/internal/persona/codex/summary/summary.go, which
 * returns early on a nil `used`. That guard is the whole point: chatgpt.com
 * dropped the normal lane's 5-hour window on 2026-07-11 and now sends
 * `secondary_window: null`, so a card rendering one meter per slot drew a bar
 * for a window that no longer exists — and with no `limit_seconds` to read it
 * fell back to the positional label, duplicating the "Weekly window" above it.
 *
 * The check is `typeof … === "number"` rather than a truthiness test on
 * purpose: a window sitting at exactly 0% is real and still gets a bar. Both
 * Spark windows normally are.
 */
export function chatgptQuotaRows(summary: ChatGptUsageSummary | null | undefined): ChatGptQuotaRow[] {
  if (!summary) return [];
  const spark = summary.spark_window ?? null;
  const slots: Array<{
    key: ChatGptQuotaRow["key"];
    lane: ChatGptQuotaRow["lane"];
    window: ChatGptWindow | null | undefined;
    fallback: string;
  }> = [
    {
      key: "normal_primary",
      lane: "normal",
      window: summary.primary_window ?? summary.normal_window?.primary_window,
      fallback: "5-hour window",
    },
    {
      key: "normal_secondary",
      lane: "normal",
      window: summary.secondary_window ?? summary.normal_window?.secondary_window,
      fallback: "Weekly window",
    },
    {
      key: "spark_primary",
      lane: "spark",
      window: spark?.primary_window,
      fallback: "5-hour window",
    },
    {
      key: "spark_secondary",
      lane: "spark",
      window: spark?.secondary_window,
      fallback: "Weekly window",
    },
  ];

  const rows: ChatGptQuotaRow[] = [];
  for (const slot of slots) {
    const used = slot.window?.used_percent;
    if (typeof used !== "number" || !Number.isFinite(used)) continue;
    const label = chatgptWindowLabel(slot.window?.limit_seconds, slot.fallback);
    rows.push({
      key: slot.key,
      lane: slot.lane,
      label: slot.lane === "spark" ? `Spark · ${label}` : label,
      usedPercent: used,
    });
  }
  return rows;
}
