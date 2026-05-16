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

// logs feature ↓
/** A row from `/admin/usage/ingests`. */
export interface UsageIngestRow {
  id: number | string;
  host_id: number | null;
  engine?: string | null;
  fqdn?: string | null;
  entries?: number | null;
  total?: number | null;
  input?: number | null;
  output?: number | null;
  cached?: number | null;
  reasoning?: number | null;
  client_ip?: string | null;
  payload?: unknown;
  created_at?: string | null;
}

/** Paginated envelope returned from `/admin/usage/ingests`. */
export interface UsageIngestPage {
  items: UsageIngestRow[];
  total: number;
  page: number;
  per_page: number;
  pages: number;
}

/** A row from `/admin/mcp/logs`. */
export interface McpAccessLogRow {
  id: number | string;
  host_id: number | null;
  host_fqdn?: string | null;
  client_ip?: string | null;
  method?: string | null;
  name?: string | null;
  success: boolean | number;
  error_code?: string | null;
  error_message?: string | null;
  created_at?: string | null;
  params?: unknown;
}

/** A row from `/admin/logs` (admin audit trail). */
export interface AdminAuditLogRow {
  id: number | string;
  host_id: number | null;
  action: string;
  details?: unknown;
  created_at?: string | null;
}

/** Minimal host shape used by the logs host-FQDN map. */
export interface HostFqdnSummary {
  id: number | string;
  fqdn?: string | null;
  hostname?: string | null;
  display_name?: string | null;
}
