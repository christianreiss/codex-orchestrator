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

// projects feature ↓
export interface ProjectAbout {
  title?: string | null;
  name?: string | null;
  description?: string | null;
  [key: string]: unknown;
}

export interface ProjectCounts {
  notes: number;
  open_todos: number;
  done_todos: number;
  files: number;
  feedback: number;
}

export interface ProjectSummary {
  slug: string;
  title: string;
  name: string;
  description: string;
  about: ProjectAbout | null;
  latest_seq: number;
  created_at: string | null;
  updated_at: string | null;
  /** Counts strip — present on the list endpoint. */
  counts?: ProjectCounts;
}

export interface ProjectListResponse {
  projects: ProjectSummary[];
}

export interface ProjectDetailProject {
  slug: string;
  about: ProjectAbout | null;
  roster_markdown: string;
  latest_seq: number;
  created_at: string | null;
  updated_at: string | null;
  counts: ProjectCounts;
}

export interface ProjectNote {
  id: number;
  header: string;
  body: string;
  created_at?: string | null;
  updated_at?: string | null;
}

export interface ProjectTodo {
  id: number;
  title: string;
  detail?: string | null;
  done: boolean;
  created_at?: string | null;
  updated_at?: string | null;
}

export interface ProjectFile {
  id: number;
  stored_name: string;
  description?: string | null;
  content_sha256?: string | null;
  mime_type?: string | null;
  size_bytes: number;
  content: string;
  created_at?: string | null;
  updated_at?: string | null;
}

export type ProjectFeedbackType = "bug" | "feature" | "note";

export interface ProjectFeedback {
  id: number;
  project_id?: number | null;
  type: ProjectFeedbackType;
  title: string;
  body: string;
  created_at?: string | null;
  updated_at?: string | null;
}

export interface ProjectChange {
  id?: number;
  seq: number;
  event_type?: string;
  action: string;
  entity_type?: string | null;
  entity_id?: number | string | null;
  payload?: Record<string, unknown> | null;
  source_host_id?: number | string | null;
  created_at?: string | null;
}

export interface ProjectDetailResponse {
  project: ProjectDetailProject;
  notes: ProjectNote[];
  todos: ProjectTodo[];
  files: ProjectFile[];
  feedback: ProjectFeedback[];
  recent_changes: ProjectChange[];
}

export interface ProjectModuleState {
  enabled: boolean;
  updated_at?: string | null;
  managed_skill?: unknown;
}

export interface ProjectAssistResponse {
  project: string;
  about: ProjectAbout | null;
  roster_markdown: string;
  assistant_message: string;
  changed_fields: string[];
  latency_ms?: number | null;
  codex_version?: string | null;
}

export interface ProjectChangesResponse {
  project: string;
  since: number;
  latest_seq: number;
  changes: ProjectChange[];
}
// projects feature ↑

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
