/**
 * Pure helpers behind the Activity feed: time windows, filtering of the two
 * data sources (admin changes, tool calls), action grouping and paging.
 * No Svelte, no network, so they are unit-testable.
 */
import type { AdminAuditLogRow, McpAccessLogRow } from "$lib/api/types";

export const PAGE_SIZE = 50;

export const TIME_WINDOWS = [
  { value: "all", label: "All time", ms: 0 },
  { value: "5m", label: "Last 5 minutes", ms: 5 * 60_000 },
  { value: "1h", label: "Last hour", ms: 60 * 60_000 },
  { value: "24h", label: "Last 24 hours", ms: 24 * 60 * 60_000 },
  { value: "7d", label: "Last 7 days", ms: 7 * 24 * 60 * 60_000 },
] as const;

export type TimeWindow = (typeof TIME_WINDOWS)[number]["value"];
export type ActivityType = "changes" | "tools";
export type ToolStatus = "all" | "ok" | "fail";

export function parseWindow(value: string | null): TimeWindow {
  return TIME_WINDOWS.find((w) => w.value === value)?.value ?? "all";
}

export function parseType(value: string | null): ActivityType {
  return value === "tools" ? "tools" : "changes";
}

export function parseStatus(value: string | null): ToolStatus {
  return value === "ok" || value === "fail" ? value : "all";
}

/** `all`, `system`, or a numeric host id; anything else falls back to `all`. */
export function parseHost(value: string | null): string {
  if (value === "all" || value === "system") return value;
  return value !== null && /^\d+$/.test(value) ? value : "all";
}

/** Earliest accepted timestamp for a window, or 0 when unbounded. */
export function windowCutoff(window: TimeWindow, now = Date.now()): number {
  const found = TIME_WINDOWS.find((w) => w.value === window);
  return found && found.ms > 0 ? now - found.ms : 0;
}

function inWindow(createdAt: string | null | undefined, cutoff: number): boolean {
  if (cutoff <= 0 || !createdAt) return true;
  const ts = Date.parse(createdAt);
  return !Number.isFinite(ts) || ts >= cutoff;
}

/** First segment of an action or tool name: "host.pruned" -> "host", "project_card_move" -> "project". */
export function actionGroup(value: string, separators: RegExp = /[.:/]/): string {
  const first = value.split(separators)[0];
  return first || value;
}

/** Distinct groups with their row counts, most frequent first, then alphabetical. */
export function actionGroups(values: string[], separators?: RegExp): Array<{ value: string; count: number }> {
  const counts = new Map<string, number>();
  for (const value of values) {
    if (!value) continue;
    const group = actionGroup(value, separators);
    counts.set(group, (counts.get(group) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
}

export function parseMaybe(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

/** Compact one-line JSON for a details column. */
export function detailsToString(details: unknown): string {
  if (details === null || details === undefined) return "";
  const parsed = parseMaybe(details);
  if (typeof parsed === "string") return parsed;
  try {
    return JSON.stringify(parsed);
  } catch {
    return String(parsed);
  }
}

export function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** Full payload of a change row, for the copy button and the expanded view. */
export function changePayload(row: AdminAuditLogRow): Record<string, unknown> {
  return {
    id: row.id,
    host_id: row.host_id,
    action: row.action,
    details: parseMaybe(row.details),
    created_at: row.created_at ?? null,
  };
}

export type ChangeFilter = { q: string; host: string; window: TimeWindow; action: string };

export function filterChanges(
  rows: AdminAuditLogRow[],
  filter: ChangeFilter,
  hostLabel: (row: AdminAuditLogRow) => string,
  now = Date.now(),
): AdminAuditLogRow[] {
  const needle = filter.q.trim().toLowerCase();
  const prefix = filter.action.trim().toLowerCase();
  const cutoff = windowCutoff(filter.window, now);
  return rows.filter((row) => {
    const hasHost = row.host_id !== null && row.host_id !== undefined;
    if (filter.host === "system" && hasHost) return false;
    if (filter.host !== "all" && filter.host !== "system" && String(row.host_id ?? "") !== filter.host) return false;
    if (prefix !== "" && !row.action.toLowerCase().startsWith(prefix)) return false;
    if (!inWindow(row.created_at, cutoff)) return false;
    if (needle === "") return true;
    return (
      row.action.toLowerCase().includes(needle) ||
      hostLabel(row).toLowerCase().includes(needle) ||
      detailsToString(row.details).toLowerCase().includes(needle)
    );
  });
}

export type ToolFilter = {
  q: string;
  /** FQDN of the chosen host, or null for every host. */
  hostFqdn: string | null;
  window: TimeWindow;
  /** Tool-name prefix, "" for every tool. */
  action: string;
  status: ToolStatus;
};

export function toolSucceeded(row: McpAccessLogRow): boolean {
  return Boolean(row.success);
}

export function filterToolCalls(rows: McpAccessLogRow[], filter: ToolFilter, now = Date.now()): McpAccessLogRow[] {
  const needle = filter.q.trim().toLowerCase();
  const prefix = filter.action.trim().toLowerCase();
  const cutoff = windowCutoff(filter.window, now);
  return rows.filter((row) => {
    if (filter.hostFqdn !== null && (row.host_fqdn ?? "") !== filter.hostFqdn) return false;
    if (filter.status === "ok" && !toolSucceeded(row)) return false;
    if (filter.status === "fail" && toolSucceeded(row)) return false;
    if (prefix !== "" && !(row.name ?? "").toLowerCase().startsWith(prefix)) return false;
    if (!inWindow(row.created_at, cutoff)) return false;
    if (needle === "") return true;
    return (
      (row.host_fqdn ?? "").toLowerCase().includes(needle) ||
      (row.name ?? "").toLowerCase().includes(needle) ||
      (row.method ?? "").toLowerCase().includes(needle)
    );
  });
}

export function pageCountFor(total: number, size = PAGE_SIZE): number {
  return Math.max(1, Math.ceil(total / size));
}

export function paginate<T>(items: T[], page: number, size = PAGE_SIZE): T[] {
  const current = Math.min(Math.max(1, page), pageCountFor(items.length, size));
  return items.slice((current - 1) * size, current * size);
}
