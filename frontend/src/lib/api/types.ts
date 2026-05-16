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


// account feature ↓
export interface Passkey {
  id: number;
  name: string;
  transports?: string | string[] | null;
  created_at?: string | null;
  last_used_at?: string | null;
}

export interface PasskeyListResponse {
  passkeys: Passkey[];
}

export interface PasskeyRegisterResponse {
  passkey: Passkey;
}

/**
 * PublicKeyCredentialCreationOptionsJSON-compatible shape returned by
 * `POST /admin/auth/passkey/register/options`. Strings are base64url —
 * @simplewebauthn/browser consumes this directly via startRegistration().
 */
export interface PasskeyRegistrationOptionsJSON {
  challenge: string;
  rp: { id: string; name: string };
  user: { id: string; name: string; displayName: string };
  pubKeyCredParams: Array<{ type: "public-key"; alg: number }>;
  timeout?: number;
  attestation?: string;
  authenticatorSelection?: Record<string, unknown>;
  excludeCredentials?: Array<{ type: "public-key"; id: string; transports?: string[] }>;
}

export interface PasswordChangeRequest {
  current_password: string;
  new_password: string;
  confirm_password: string;
}

export interface PasswordChangeResponse {
  user: User;
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
// cli-auth-verify feature ↓
/**
 * Response payload from `POST /cli/auth/lookup`. Describes a pending
 * device-code login request the browser is asked to approve.
 */
export interface CliAuthLookup {
  id: number;
  /** Fully-qualified hostname the CLI was started from. */
  fqdn: string;
  /** Whether the host will be registered as secure (mTLS). */
  secure: boolean;
  /** Source IP that initiated the request, if recorded. */
  ip: string | null;
  /** ISO timestamp the CLI started the request. */
  created_at: string | null;
  /** ISO timestamp at which the user code expires. */
  expires_at: string | null;
}

export interface CliAuthApprove {
  fqdn: string;
  host_id: number;
}
// cli-auth-verify feature ↑
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
// manual feature ↓

export interface ManualArticleSummary {
  slug: string;
  title: string;
  section: string;
  summary: string;
  tags?: string[];
  verified?: string;
}

export interface ManualManifest {
  version: string;
  articles: ManualArticleSummary[];
}

export interface ManualAnchor {
  id: string;
  text: string;
  level: number;
}

export interface ManualSearchDoc {
  slug: string;
  title: string;
  section: string;
  summary: string;
  anchors: ManualAnchor[];
  /** Optional preview / body excerpts present in some indexes. */
  body?: string;
  tokens?: string[];
}

export interface ManualSearchIndex {
  version: string;
  docs: ManualSearchDoc[];
// settings feature ↓
export interface ApiStateValue {
  disabled: boolean;
}

export interface CdxSilentValue {
  silent: boolean;
}

export interface ReverseDnsValue {
  enabled: boolean;
}

export interface AutoUpdateValue {
  enabled: boolean;
}

export interface InsecureApprovalValue {
  enabled: boolean;
}

export interface ClaudeSettingsValue {
  default_model: string;
  max_tokens: number;
  disabled: boolean;
}

export interface ClaudeVersionValue {
  version: string | null;
  locked: boolean;
  updated_at: string | null;
}

export interface QuotaModeValue {
  hard_fail: boolean;
  limit_percent: number;
  week_partition: number;
}

export interface LogRetentionValue {
  enabled: boolean;
  days_logs: number;
  days_mcp: number;
  days_events: number;
  days_graph_stats: number;
}

export interface PrunePolicyValue {
  inactivity_window_days: number;
}

export interface CodexVersionLockValue {
  locked_version: string | null;
  locked_at: string | null;
}

export interface CodexVersionsSummary {
  client_version: string | null;
  client_version_checked_at?: string | null;
  client_version_source?: string | null;
  client_version_enforce_exact?: boolean;
  wrapper_version?: string | null;
  reported_client_version?: string | null;
  reported_wrapper_version?: string | null;
  [key: string]: unknown;
}

export interface CodexVersionsCheckResult {
  available_client: {
    version?: string | null;
    updated_at?: string | null;
    source?: string | null;
    [key: string]: unknown;
  };
  versions: CodexVersionsSummary;
}

export interface ScalingTierRule {
  threshold_percent?: number;
  factor?: number;
  [key: string]: unknown;
}

export interface ScalingRules {
  enabled?: boolean;
  tiers?: ScalingTierRule[];
  [key: string]: unknown;
}

export interface ScalingStatus {
  enabled: boolean;
  rules: ScalingRules | null;
  normal?: unknown;
  spark?: unknown;
  active_state?: unknown;
  [key: string]: unknown;
// users feature ↓
export const USER_ROLES = [
  "admin",
  "fleet_operator",
  "trusted_user",
  "user",
] as const;
export type UserRole = (typeof USER_ROLES)[number];

/** Admin user shape as returned by `AdminAuthService::sanitizeUser`. */
export interface AdminUser {
  id: number;
  name: string;
  username: string;
  email: string;
  access_level: UserRole | string;
  active: boolean;
  last_login_at?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
}

export interface AdminUserListResponse {
  users: AdminUser[];
}

export interface AdminUserResponse {
  user: AdminUser;
}

export interface AdminUserPayload {
  name?: string;
  username: string;
  email?: string;
  access_level: UserRole | string;
  active: boolean;
  password?: string;
}

export interface AdminAuthStatusResponse {
  has_users: boolean;
  admin_count: number;
  enforced: boolean;
  authenticated: boolean;
  user: AdminUser | null;
  /** Role key → human-readable label, e.g. `{admin: "Admin", ...}`. */
  roles: Record<string, string>;
  passkeys_registered?: number;
  passkey_login_available?: boolean;
}
