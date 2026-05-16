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

// api-keys feature ↓

export type ApiKeyEngine = "openai" | "claude";

/**
 * Shape of a row returned by `GET /admin/{openai|claude}/keys`.
 *
 * Mirrors the columns selected by `OpenaiApiKeyRepository::listByEngine()`:
 *   id, name, key_prefix, admin_user_id, rate_limit_rpm, is_active,
 *   use_count, last_used_at, expires_at, engine, created_at, updated_at.
 */
export interface AdminApiKey {
  id: number;
  name: string;
  key_prefix: string;
  admin_user_id?: number | null;
  rate_limit_rpm: number;
  is_active: number | boolean;
  use_count: number;
  last_used_at?: string | null;
  expires_at?: string | null;
  engine?: string;
  created_at?: string | null;
  updated_at?: string | null;
}

/**
 * Shape returned by `POST /admin/{openai|claude}/keys`: the freshly minted
 * plaintext key (shown exactly once) plus the persisted record.
 */
export interface AdminApiKeyCreated {
  key: string;
  record: AdminApiKey;
}

export interface AdminApiKillSwitchState {
  disabled: boolean;
}

export interface CreateApiKeyPayload {
  name: string;
  rate_limit_rpm: number;
  /** ISO 8601 timestamp or `null` to never expire. */
  expires_at?: string | null;
}
