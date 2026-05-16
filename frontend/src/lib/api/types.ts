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

// integrations feature ↓
/** Joplin module configuration + verification + activation state. */
export interface JoplinConfigState {
  enabled: boolean;
  url: string;
  email: string;
  password_set: boolean;
  sync_interval_minutes: number;
  config_complete: boolean;
  verified_connection: boolean;
  verified_at: string | null;
  can_activate: boolean;
  activation_reason: string;
  /** Present on the response of POST /admin/joplin/config when toggling enabled flipped off due to changed creds. */
  auto_disabled?: boolean;
  /** Present on POST /admin/joplin/config when initial sync ran. */
  initial_sync?: JoplinSyncResult | null;
}

/** Result of POST /admin/joplin/test — extends config state with probe outcome. */
export interface JoplinTestResult extends JoplinConfigState {
  reachable: boolean;
  status_code: number | null;
  reason?: string | null;
  version?: string | null;
}

/** Result of POST /admin/joplin/sync — extends config state with sync stats. */
export interface JoplinSyncState extends JoplinConfigState {
  sync?: JoplinSyncResult;
}

export interface JoplinSyncResult {
  synced: number;
  errors: number;
  notebooks: number;
}

/** Payload accepted by POST /admin/joplin/config. */
export interface JoplinConfigPayload {
  url?: string;
  email?: string;
  password?: string;
  sync_interval_minutes?: number;
  enabled?: boolean;
}
