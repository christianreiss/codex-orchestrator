/**
 * Admin overview endpoint — primary stats for the dashboard.
 *
 * Wraps `/admin/overview` plus the pending-insecure-approvals probe. All
 * feature-specific types live here so the shared `lib/api/types.ts` stays
 * minimal.
 */
import { api } from "./client";
import { createQuery } from "@tanstack/svelte-query";

export interface OverviewVersions {
  client_version?: string | null;
  wrapper_version?: string | null;
  cdx_version?: string | null;
  cdx_version_available?: string | null;
  cdx_version_checked_at?: string | null;
  /** Upstream release lookup has stopped refreshing; the served target is old. */
  cdx_version_stale?: boolean;
  client_version_checked_at?: string | null;
  claude_version?: string | null;
  claude_version_available?: string | null;
  claude_version_checked_at?: string | null;
  claude_version_stale?: boolean;
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

export const overviewKeys = {
  root: ["overview"] as const,
  insecure: ["overview", "insecure-approvals"] as const,
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
