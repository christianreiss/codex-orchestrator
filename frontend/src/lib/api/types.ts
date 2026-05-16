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

// authoring feature ↓
// ---------------------------------------------------------------------------
// Skills

export interface SkillRow {
  slug: string;
  display_name?: string | null;
  description?: string | null;
  sha256?: string | null;
  manifest?: string | null;
  uri?: string | null;
  canonical_uri?: string | null;
  managed?: boolean;
  status?: string | null;
  updated_at?: string | null;
  created_at?: string | null;
  deleted_at?: string | null;
  engine?: string | null;
}

export interface SkillListResponse {
  skills: SkillRow[];
}

export interface SkillDetail extends SkillRow {
  manifest: string;
}

export interface SkillStoreResult {
  status: "created" | "updated" | "unchanged" | string;
  slug: string;
  sha256: string;
  updated_at?: string | null;
  managed?: boolean;
  uri?: string;
  canonical_uri?: string;
}

export interface SkillGenerateResult {
  slug: string;
  display_name?: string;
  description?: string;
  manifest: string;
  tags?: string[];
  what?: string;
  when?: string;
  steps?: string;
  latency_ms?: number | null;
  codex_version?: string | null;
}

export interface SkillAssistMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

export interface SkillAssistResult {
  slug?: string;
  display_name?: string;
  description?: string;
  manifest?: string;
  assistant_message?: SkillAssistMessage | null;
  tags?: string[];
  what?: string;
  when?: string;
  steps?: string;
  latency_ms?: number | null;
}

// Agents (AGENTS.md)

export interface AgentsVersionMeta {
  id: number;
  sha256: string;
  updated_at?: string | null;
  created_at?: string | null;
  size_bytes?: number;
  is_latest?: boolean;
  is_active?: boolean;
  is_served?: boolean;
}

export interface AgentsDocument {
  status: "ok" | "missing" | string;
  mode: "latest" | "locked" | string;
  active_id?: number | null;
  served_id?: number | null;
  latest_id?: number | null;
  backup_limit?: number;
  sha256?: string;
  updated_at?: string | null;
  size_bytes?: number;
  content?: string;
  versions: AgentsVersionMeta[];
  pruned_count?: number;
}

export interface AgentsVersion extends AgentsVersionMeta {
  content: string;
}

export interface AgentsStoreResult {
  status: string;
  version_id?: number | null;
  sha256?: string;
  updated_at?: string | null;
  size_bytes?: number;
  pruned_count?: number;
}

// Memories

export interface MemoryEntry {
  id: string | number | null;
  record_id?: number | null;
  host_id?: number | string | null;
  host?: string | null;
  content: string;
  metadata?: Record<string, unknown> | null;
  tags?: string[];
  summary?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
  score?: number | null;
}

export interface MemoriesListResponse {
  status: "ok" | string;
  query?: string;
  host_id?: number | string | null;
  limit?: number;
  count?: number;
  matches: MemoryEntry[];
}
