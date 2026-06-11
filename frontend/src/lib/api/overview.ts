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
  claude_wrapper_version?: string | null;
  claude_client_version_minimum?: string | null;
  [key: string]: unknown;
}

export interface VersionDistribution {
  codex: Array<{ version: string; count: number }>;
  claude: Array<{ version: string; count: number }>;
  install: { both: number; codex_only: number; claude_only: number; neither: number };
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
  has_canonical_auth?: boolean;
  seed_required?: boolean;
  insecure_approval_enabled?: boolean;
  auto_update_enabled?: boolean;
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

export interface VersionsCheckResponse {
  available_client?: string | null;
  versions: OverviewVersions;
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
