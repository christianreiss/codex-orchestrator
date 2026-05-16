/**
 * Shared API types. Intentionally minimal — feature agents in Phase 2 will
 * extend these (or add their own per-resource files).
 */

export type Role = "admin" | "fleet_operator" | "trusted_user" | "user";

export interface User {
  id: number | string;
  username: string;
  name?: string | null;
  email?: string | null;
  role?: Role | string;
  roles?: string[];
  created_at?: string | null;
  updated_at?: string | null;
}

export interface AuthStatus {
  enforced: boolean;
  authenticated: boolean;
  user: User | null;
  roles?: string[];
}

export interface AdminBootstrap {
  enforced: boolean;
  authenticated: boolean;
  user: User | null;
}

export interface Host {
  id: number | string;
  hostname: string;
  display_name?: string | null;
  status?: "online" | "offline" | "pending" | string;
  secure?: boolean;
  vip?: boolean;
  roaming?: boolean;
  insecure_window_open?: boolean;
  last_seen?: string | null;
  ip_address?: string | null;
}

export interface Project {
  id: number | string;
  slug: string;
  name: string;
  about?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
}

export interface Skill {
  id?: number | string;
  slug: string;
  name: string;
  manifest?: string | null;
  body?: string | null;
  updated_at?: string | null;
}

export interface Memory {
  id: number | string;
  key: string;
  value: string;
  created_at?: string | null;
}

export interface LogEntry {
  id: number | string;
  ts?: string;
  level?: string;
  message: string;
  source?: string | null;
  meta?: Record<string, unknown>;
}

export interface ApiKey {
  id: number | string;
  label?: string | null;
  provider: "openai" | "claude" | string;
  enabled?: boolean;
  last_used_at?: string | null;
  created_at?: string | null;
}

export interface UsageSnapshot {
  provider: "openai" | "claude" | string;
  total_tokens?: number;
  total_cost?: number;
  window_start?: string | null;
  window_end?: string | null;
  buckets?: Array<{ ts: string; value: number }>;
}

/** Standard backend envelope for admin routes. */
export interface OkEnvelope<T> {
  status: "ok";
  data?: T;
  [key: string]: unknown;
}

export interface ErrorEnvelope {
  status: "error";
  message?: string;
  code?: string;
  [key: string]: unknown;
}

/** OpenAI-shaped error envelope (used by some controllers). */
export interface OpenAIErrorEnvelope {
  error: { message?: string; type?: string; code?: string };
}

/** Anthropic-shaped error envelope (used by Claude controllers). */
export interface AnthropicErrorEnvelope {
  type: "error";
  error: { message?: string; type?: string; code?: string };
}

// hosts feature ↓ ----------------------------------------------------------
//
// Rich host shapes that mirror the actual response payloads produced by
// AdminOverviewController::hosts() / hostDetail() and the AdminHostController
// register / quick-register endpoints. These supersede the minimal `Host`
// stub above for everything under /hosts.

export type HostEngine = "codex" | "claude";

export type HostAutoUpdateState =
  | "disabled"
  | "current"
  | "available"
  | "applying"
  | "error"
  | "unknown"
  | string;

export interface HostTokenUsage {
  ts?: string | null;
  input_tokens?: number | null;
  output_tokens?: number | null;
  total_tokens?: number | null;
  [key: string]: unknown;
}

/** Row shape returned by GET /admin/hosts. */
export interface HostListItem {
  id: number;
  fqdn: string;
  status: string;
  last_refresh: string | null;
  claude_last_refresh: string | null;
  updated_at: string | null;
  created_at: string | null;
  client_version: string | null;
  claude_client_version: string | null;
  client_version_override: string | null;
  claude_client_version_override: string | null;
  agents_document_id_override: number | null;
  wrapper_version: string | null;
  claude_wrapper_version: string | null;
  api_calls: number | null;
  ip4: string | null;
  ip6: string | null;
  allow_roaming_ips: boolean;
  secure: boolean;
  vip: boolean;
  insecure_enabled_until: string | null;
  insecure_grace_until: string | null;
  insecure_window_minutes: number | null;
  curl_insecure: boolean;
  last_cron_check: string | null;
  reverse_dns_mode: string | null;
  lane_preference: string | null;
  model_override: string | null;
  reasoning_effort_override: string | null;
  claude_model_override: string | null;
  claude_reasoning_effort_override: string | null;
  engines: string;
  engines_list: HostEngine[] | string[];
  auto_update_override: boolean | null;
  effective_auto_update_enabled: boolean;
  auto_update_state: HostAutoUpdateState;
  auto_update_label: string | null;
  auto_update_emoji: string | null;
  auto_update_rank: number | null;
  auto_update_last_event_at: string | null;
  auto_update_target_version: string | null;
  canonical_digest: string | null;
  claude_canonical_digest: string | null;
  recent_digests: string[];
  claude_recent_digests: string[];
  authed: boolean;
  auth_outdated: boolean;
  auth_source: boolean;
  token_usage: HostTokenUsage | null;
  users: Array<{ user_id?: number | string; username?: string; [key: string]: unknown }>;
}

export interface HostDetail extends HostListItem {}

export interface HostsListResponse {
  hosts: HostListItem[];
}

export interface HostDetailResponse {
  host: HostDetail;
  overview: {
    versions: {
      client_version: string | null;
      wrapper_version: string | null;
      client_version_checked_at: string | null;
      claude_version: string | null;
    };
    reverse_dns_enabled: boolean;
    auto_update_enabled: boolean;
    inactivity_window_days: number;
  };
}

export interface HostInsecureWindowItem {
  id: number;
  fqdn: string;
  active: boolean;
  insecure_enabled_until: string | null;
  secure: boolean;
}

export interface InsecureDomainAllowItem {
  id: number;
  domain: string | null;
  active: boolean;
  enabled_until: string | null;
  window_minutes: number | null;
}

export interface InsecureSummaryResponse {
  count: number;
  active: number;
  hosts: HostInsecureWindowItem[];
  domains: InsecureDomainAllowItem[];
  domains_active: number;
}

export interface InsecureApprovalRequest {
  id: number;
  host_id: number;
  fqdn: string;
  request_ip: string | null;
  requested_at: string | null;
  updated_at: string | null;
  status: string;
}

export interface InsecureApprovalsResponse {
  requests: InsecureApprovalRequest[];
}

export interface InstallerInfo {
  token: string;
  mode: string;
  label: string;
  url: string;
  command: string;
  expires_at: string;
}

export interface HostRegisterResponse {
  host: Record<string, unknown> & { id: number; fqdn?: string; api_key?: string };
  installer: InstallerInfo;
}

export interface HostRegisterPayload {
  fqdn: string;
  secure?: boolean;
  vip?: boolean;
  temporary?: boolean;
  curl_insecure?: boolean;
  engines?: HostEngine[] | string[];
  duration_minutes?: number;
  reverse_dns_mode?: "global" | "enabled" | "disabled";
}

export interface HostQuickRegisterPayload {
  engines: HostEngine[] | string[];
  duration_minutes?: number;
}
// hosts feature ↑ ----------------------------------------------------------
