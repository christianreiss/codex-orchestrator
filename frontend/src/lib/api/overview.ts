/**
 * Admin overview endpoint — primary stats for the dashboard.
 *
 * Wraps `/admin/overview` and `POST /admin/versions/check` plus the
 * pending-insecure-approvals probe. All feature-specific types live here
 * so the shared `lib/api/types.ts` stays minimal.
 */
import { api } from "./client";
import { createQuery, createMutation } from "@tanstack/svelte-query";

export interface OverviewVersions {
  client_version?: string | null;
  wrapper_version?: string | null;
  cdx_version?: string | null;
  cdx_version_available?: string | null;
  cdx_version_checked_at?: string | null;
  client_version_checked_at?: string | null;
  claude_version?: string | null;
  claude_version_available?: string | null;
  claude_version_checked_at?: string | null;
  claude_wrapper_version?: string | null;
  claude_client_version_minimum?: string | null;
  [key: string]: unknown;
}

export interface VersionCount {
  version: string;
  count: number;
}

export interface VersionDistribution {
  codex: VersionCount[];
  claude: VersionCount[];
  install: { both: number; codex_only: number; claude_only: number; neither: number };
}

export interface EngineInstallCounts {
  codex: number;
  claude: number;
}

/**
 * Collapse the mutually-exclusive install buckets into one reported-install
 * count per engine. A dual-engine host intentionally contributes to both.
 */
export function engineInstallCounts(
  distribution: VersionDistribution | null | undefined,
): EngineInstallCounts | null {
  const install = distribution?.install;
  if (!install) return null;

  return {
    codex: install.both + install.codex_only,
    claude: install.both + install.claude_only,
  };
}

export interface OverviewResponse {
  totals: { hosts: number };
  latest_log_at?: string | null;
  last_refresh?: string | null;
  avg_refresh_age_days?: number | null;
  version_distribution?: VersionDistribution | null;
  versions: OverviewVersions;
  chatgpt_usage?: unknown;
  chatgpt_usage_summary?: unknown;
  chatgpt_cached?: boolean;
  insecure_approval_enabled?: boolean;
  auto_update_enabled?: boolean;
  inactivity_window_days?: number;
  [key: string]: unknown;
}

export interface InsecureApprovalRequest {
  id: number;
  host_id: number;
  fqdn: string;
  request_ip?: string | null;
  requested_at?: string | null;
  updated_at?: string | null;
  status: string;
}

export interface InsecureApprovalsPending {
  requests: InsecureApprovalRequest[];
}

export interface AvailableClientRelease {
  version?: string | null;
  url?: string | null;
  published_at?: string | null;
  fetched_at?: string | null;
  cached?: boolean;
  [key: string]: unknown;
}

export interface VersionsCheckResponse {
  available_client?: AvailableClientRelease | string | null;
  versions: OverviewVersions;
}

/**
 * Version checks historically returned the version string directly. The
 * current Fastify route returns the cached upstream release record, so keep
 * the dashboard tolerant while presenting only the human-useful version.
 */
export function releaseVersion(value: AvailableClientRelease | string | null | undefined): string | null {
  if (typeof value === "string") return value;
  return typeof value?.version === "string" ? value.version : null;
}

function numericVersion(value: string): number[] | null {
  const match = value.trim().match(/^v?(\d+(?:\.\d+)+)(?:[-+].*)?$/);
  return match?.[1]?.split(".").map((segment) => Number.parseInt(segment, 10)) ?? null;
}

/** Reported host versions strictly older than the concrete upstream release. */
export function outdatedClientVersions(
  available: string | null | undefined,
  reported: VersionCount[] | null | undefined,
): VersionCount[] {
  const availableParts = available ? numericVersion(available) : null;
  if (!availableParts) return [];

  return (reported ?? []).filter(({ version, count }) => {
    if (count <= 0) return false;
    const reportedParts = numericVersion(version);
    if (!reportedParts) return false; // `latest` is a policy alias, not telemetry.
    const length = Math.max(availableParts.length, reportedParts.length);
    for (let index = 0; index < length; index += 1) {
      const current = reportedParts[index] ?? 0;
      const latest = availableParts[index] ?? 0;
      if (current < latest) return true;
      if (current > latest) return false;
    }
    return false;
  });
}

export const overviewKeys = {
  root: ["overview"] as const,
  insecure: ["overview", "insecure-approvals"] as const,
  versionsCheck: ["overview", "versions-check"] as const,
};

export function overviewQuery() {
  return createQuery<OverviewResponse>({
    queryKey: overviewKeys.root,
    queryFn: () => api.get<OverviewResponse>("/admin/overview"),
  });
}

export function insecureApprovalsPendingQuery() {
  return createQuery<InsecureApprovalsPending>({
    queryKey: overviewKeys.insecure,
    queryFn: () => api.get<InsecureApprovalsPending>("/admin/insecure-approvals/pending"),
    retry: 0,
  });
}

/**
 * Versions check is exposed as a mutation since the backend treats it as a
 * write (it actually probes GitHub). We surface the most-recent result via
 * the mutation's `data` field; the dashboard runs it once on mount.
 */
export function versionsCheckMutation() {
  return createMutation<VersionsCheckResponse, Error, void>({
    mutationFn: () => api.post<VersionsCheckResponse>("/admin/versions/check"),
  });
}
