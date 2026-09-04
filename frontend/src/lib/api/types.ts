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
  /**
   * The caller's row of the server's role→capability matrix. Absent when the
   * API predates the capability layer; the console then offers nothing beyond
   * reads rather than assuming a permission it cannot confirm.
   */
  capabilities?: string[];
  /** `"compatible"` or `"strict"`; see `lib/auth/capabilities.ts`. */
  authorization_mode?: string;
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

/**
 * Project board. Todos are a view of the same cards since migration 0026 — a
 * todo id is its card number — so `ProjectTodo` above is the narrower window
 * onto these rows, not a separate kind of thing.
 */
export type ProjectBoardRole = "plan" | "code" | "review" | "verify" | "ops";

export interface BoardCardClaim {
  held: boolean;
  role?: string | null;
  username?: string | null;
  host_id?: number | null;
  host?: string | null;
  worktree_path?: string | null;
  claimed_at?: string | null;
  expires_at?: string | null;
  agent_address_bound?: boolean;
  /** True when the claim belongs to the caller. Always false in the console. */
  yours?: boolean;
  released_at?: string | null;
  release_reason?: string | null;
}

export interface BoardCard {
  id: string;
  number: number;
  title: string;
  detail: string;
  labels: string[];
  priority: number;
  blocked_reason: string | null;
  column: { id: string; key: string; title: string } | null;
  claim: BoardCardClaim | null;
  entered_column_at: string | null;
  created_at: string | null;
  updated_at: string | null;
}

export interface BoardColumn {
  id: string;
  key: string;
  title: string;
  position: number;
  wip_limit: number | null;
  allowed_roles: string[] | null;
  default_next_column_id: string | null;
  is_intake: boolean;
  is_terminal: boolean;
  is_blocked: boolean;
  card_count: number;
  over_wip: boolean;
  cards: BoardCard[];
  truncated: boolean;
}

export interface BoardReclaimed {
  id: string;
  number: number;
  title: string;
  released_at: string | null;
  reason: string | null;
}

export interface BoardResponse {
  project: string;
  board_slug: string;
  latest_seq: number;
  columns: BoardColumn[];
  your_claims: BoardCard[];
  reclaimed_recently: BoardReclaimed[];
}

export interface ProjectBoardModuleState {
  enabled: boolean;
  boards: number;
  cards: number;
  claimed: number;
  updated_at: string | null;
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

export type ProjectFeedbackType = "bug" | "feature" | "note" | "issue" | "test";

export interface ProjectFeedback {
  id: number;
  project_id?: number | null;
  type: ProjectFeedbackType;
  title: string;
  body: string;
  created_at?: string | null;
  updated_at?: string | null;
}

/** Shape is the raw Drizzle row from coordProjectEvents — camelCase, not
 * the hand-mapped snake_case most other admin responses use. */
export interface ProjectChange {
  id?: number;
  seq: number;
  eventType?: string;
  action: string;
  entityType?: string | null;
  entityId?: number | string | null;
  payloadJson?: Record<string, unknown> | null;
  sourceHostId?: number | string | null;
  createdAt?: string | null;
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
  excludeCredentials?: Array<{
    type: "public-key";
    id: string;
    transports?: string[];
  }>;
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
 *   id, name, key_prefix, admin_user_id, is_active,
 *   use_count, last_used_at, expires_at, engine, created_at, updated_at.
 */
export interface AdminApiKey {
  id: number;
  name: string;
  key_prefix: string;
  admin_user_id?: number | null;
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
  source_type?: string | null;
  source_repository?: string | null;
  source_path?: string | null;
  source_revision?: string | null;
  source_license?: string | null;
  bundle_sha256?: string | null;
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
  builder_mode?: boolean;
}

export type AgentPolicyModuleId =
  | "operating_contract"
  | "remote_access"
  | "fast_loop"
  | "evidence_and_commands"
  | "security"
  | "git_shared_worktree"
  | "failure_handling"
  | "no_execution_access"
  | "response_style"
  | "midnight_rule";

export interface AgentPolicyComposition {
  schema_version: 1;
  template_id: "fleet-standard";
  template_version: 1;
  enabled_modules: AgentPolicyModuleId[];
  custom_instructions: string;
}

export interface AgentPolicyCatalogItem {
  id: string;
  label: string;
  description: string;
  required: boolean;
  default_enabled: boolean;
  /** The `##` heading this module emits. Absent on the required pseudo-modules. */
  heading?: string;
}

export interface AgentPolicyCatalog {
  template_id: "fleet-standard";
  template_version: 1;
  required: AgentPolicyCatalogItem[];
  modules: AgentPolicyCatalogItem[];
}

/**
 * The fleet's master switch for the canonical middle of AGENTS.md/CLAUDE.md.
 * `off` still serves the mandatory policy block and the managed feature block —
 * it drops only what the policy builder generated.
 */
export type AgentsGenerationMode = "managed" | "manual" | "off";

export interface AgentsDocument {
  status: "ok" | "missing" | string;
  mode: "latest" | "locked" | string;
  generation_mode?: AgentsGenerationMode;
  active_id?: number | null;
  served_id?: number | null;
  latest_id?: number | null;
  backup_limit?: number;
  sha256?: string;
  updated_at?: string | null;
  size_bytes?: number;
  content?: string;
  builder_state?: AgentPolicyComposition | null;
  builder_catalog?: AgentPolicyCatalog;
  versions: AgentsVersionMeta[];
  pruned_count?: number;
}

export interface AgentsVersion extends AgentsVersionMeta {
  content: string;
  builder_state?: AgentPolicyComposition | null;
}

export interface AgentsManagedFeatureSection {
  present: boolean;
  reason: string;
  count?: number;
  sha256?: string;
  transport?: "mcp" | "native";
}

export interface AgentsRenderedDocument {
  status: "ok" | "missing" | string;
  host_id: number;
  host_fqdn: string;
  engine: "codex" | "claude" | string;
  version_id?: number;
  sha256?: string;
  base_sha256?: string;
  managed_sha256?: string | null;
  policy_sha256?: string | null;
  features_sha256?: string | null;
  updated_at?: string | null;
  size_bytes?: number;
  content?: string;
  sections?: Record<string, AgentsManagedFeatureSection>;
  /** Highlightable blocks in document order; preview-only, absent on the serve path. */
  provenance?: AgentPolicyProvenanceEntry[];
  /** Policy sections each security axis currently contributes text to. */
  axis_sections?: Record<string, string[]>;
}

export interface AgentsStoreResult {
  status: string;
  version_id?: number | null;
  sha256?: string;
  updated_at?: string | null;
  size_bytes?: number;
  pruned_count?: number;
}

export interface AgentPolicyComposeResult {
  composition: AgentPolicyComposition;
  content: string;
  sha256: string;
  size_bytes: number;
  /**
   * Base-only: composing knows nothing of a host or a posture, so it describes
   * the module and custom-instruction blocks and no others. The policy and
   * feature blocks are described by the render endpoint, which is the only one
   * that produces them.
   */
  provenance?: AgentPolicyProvenanceEntry[];
}

/** One highlightable block of a rendered document, as the server emitted it. */
export interface AgentPolicyProvenanceEntry {
  key: string;
  label: string;
  group: "policy" | "module" | "custom" | "feature" | "legacy";
  headings: string[];
}

// Claude collection artifacts (subagents / commands / output-styles)

export interface ArtifactView {
  id: number | string;
  kind: string;
  slug: string;
  sha256: string;
  display_name: string;
  description: string | null;
  model: string | null;
  frontmatter: Record<string, unknown>;
  body: string;
  source_host_id?: number | string | null;
  engine?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
  deleted_at?: string | null;
}

export interface ArtifactListResponse {
  kind: string;
  artifacts: ArtifactView[];
}

export interface ArtifactStorePayload {
  slug: string;
  description?: string | null;
  model?: string | null;
  color?: string | null;
  argument_hint?: string | null;
  tools?: string[];
  allowed_tools?: string[];
  body?: string | null;
}

export interface ArtifactStoreResult {
  status: string;
  kind: string;
  slug: string;
  sha256: string;
  updated_at?: string | null;
}

export interface ArtifactDeleteResult {
  deleted: string;
  kind: string;
}

// Claude fleet settings (settings.json sub-blocks)

export interface ClaudePermissions {
  allow?: string[];
  ask?: string[];
  deny?: string[];
}

export interface ClaudeStatusLine {
  type?: string;
  command?: string;
  [key: string]: unknown;
}

export interface ClaudeHookEntry {
  matcher?: string;
  commands?: string[];
  [key: string]: unknown;
}

export type ClaudeHooks = Record<string, ClaudeHookEntry[]>;

export interface ClaudeConfigSettings {
  model?: string;
  /** Fleet-wide Claude reasoning level, managed by the model-defaults endpoint. */
  effortLevel?: string;
  env?: Record<string, string>;
  permissions?: ClaudePermissions;
  /** Fleet default permission mode → rendered as `permissions.defaultMode`. */
  permissionMode?: string;
  statusLine?: ClaudeStatusLine;
  hooks?: ClaudeHooks;
  advisorModel?: string;
  [key: string]: unknown;
}

/** Mirrors `AdminFetchResult` in api/src/services/client-config.ts. */
export interface ClaudeConfigResponse {
  status: string;
  sha256?: string;
  updated_at?: string | null;
  size_bytes?: number;
  content?: string;
  settings?: ClaudeConfigSettings;
}

/**
 * Mirrors `StoreResult` in api/src/services/client-config.ts. Unlike every
 * other store endpoint, the save verb rides on `change` — `status` is always
 * `"ok"`, since a failed store throws instead of returning.
 */
export interface ClaudeConfigStoreResult {
  status: "ok";
  sha256: string;
  updated_at?: string | null;
  size_bytes?: number;
  content?: string;
  settings?: ClaudeConfigSettings;
  change: "created" | "updated" | "unchanged";
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
  browseros_mcp_enabled: boolean;
  last_cron_check: string | null;
  reverse_dns_mode: string | null;
  lane_preference: string | null;
  model_override: string | null;
  reasoning_effort_override: string | null;
  claude_model_override: string | null;
  claude_reasoning_effort_override: string | null;
  engines: string;
  /** Structured on current servers; optional while an older host-list payload is cached or served. */
  engines_list?: HostEngine[] | string[];
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
  users: Array<{
    user_id?: number | string;
    username?: string;
    [key: string]: unknown;
  }>;
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

export interface InsecureFleetWindow {
  open: boolean;
  until: string | null;
  opened_at: string | null;
}

export interface InsecureSummaryResponse {
  count: number;
  active: number;
  hosts: HostInsecureWindowItem[];
  domains: InsecureDomainAllowItem[];
  domains_active: number;
  fleet_window?: InsecureFleetWindow;
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
  host: Record<string, unknown> & {
    id: number;
    fqdn?: string;
    api_key?: string;
  };
  installer: InstallerInfo;
}

export interface HostInstallerResponse {
  host: HostDetail;
  installer: InstallerInfo;
}

export interface HostInstallerPayload {
  engines?: HostEngine[] | string[];
  curl_insecure?: boolean;
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

// logs feature ↓
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
  engine?: string | null;
  params?: unknown;
}

/** A row from `/admin/logs` (admin audit trail). */
export interface AdminAuditLogRow {
  id: number | string;
  host_id: number | null;
  action: string;
  details?: unknown;
  created_at?: string | null;
  engine?: string | null;
}

/** Minimal host shape used by the logs host-FQDN map. */
export interface HostFqdnSummary {
  id: number | string;
  fqdn?: string | null;
  hostname?: string | null;
  display_name?: string | null;
}

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
}

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

export interface ApiKeysInChatValue {
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

export type ModelDefaultsEngine = "codex" | "claude";

export interface ModelDefaultsCatalogEntry {
  model: string;
  persistent_efforts: string[];
  default_effort: string | null;
}

export interface ModelDefaultsValue {
  engine: ModelDefaultsEngine;
  model: string;
  reasoning_effort: string | null;
  catalog: ModelDefaultsCatalogEntry[];
}

export interface ModelDefaultsUpdate {
  model: string;
  reasoning_effort?: string | null;
}

export interface ClaudeVersionLockValue {
  locked_version: string | null;
  locked_at: string | null;
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
  claude_available_client?: {
    version?: string | null;
    url?: string | null;
    [key: string]: unknown;
  } | null;
  claude_versions?: CodexVersionsSummary | null;
}

export type ScalingReasoningEffort =
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max"
  | "ultra";
export type ScalingLane = "normal" | "spark";

export interface ScalingTierRule {
  at_percent: number;
  lane?: ScalingLane;
  reasoning_effort?: ScalingReasoningEffort;
  model?: string | null;
}

export interface ScalingRules {
  enabled: boolean;
  tiers: ScalingTierRule[];
}

export interface ScalingStatus {
  enabled: boolean;
  rules: ScalingRules | null;
  active_tier?: ScalingTierRule | null;
  [key: string]: unknown;
}

// users feature ↓
/** Mirrors `VALID_ACCESS_LEVELS` in api/src/services/admin-auth.ts. */
export const USER_ROLES = [
  "owner",
  "admin",
  "viewer",
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

// ── Fleet secrets store ──────────────────────────────────────────────────────

/**
 * A secret's metadata. Structurally incapable of carrying a value: the backend
 * DTO is typed on a shape with no ciphertext field, and the plaintext is only
 * ever returned by the dedicated reveal endpoint.
 */
export interface AdminSecret {
  id: number;
  slug: string;
  name: string;
  description: string | null;
  engine: "codex" | "claude" | null;
  /** Host that created it over MCP; null means an operator did, via this UI. */
  source_host_id: number | null;
  source_engine: "codex" | "claude" | null;
  tags: string[];
  created_at: string;
  updated_at: string;
  last_rotated_at: string | null;
  deleted_at: string | null;
}

export interface AdminSecretListResponse {
  secrets: AdminSecret[];
}

export interface AdminSecretResponse {
  secret: AdminSecret;
}

/** `rotated` is true only when an update genuinely changed the stored value. */
export interface AdminSecretUpdateResponse extends AdminSecretResponse {
  rotated: boolean;
}

export interface AdminSecretRevealResponse extends AdminSecretResponse {
  value: string;
}

export interface AdminSecretsModuleState {
  enabled: boolean;
  updated_at: string | null;
  count: number;
}

export interface CreateSecretPayload {
  slug: string;
  name: string;
  value: string;
  description?: string | null;
  engine?: "codex" | "claude" | null;
  tags?: string[];
}

/** `slug` is deliberately absent: the backend rejects a rename with a 400. */
export interface UpdateSecretPayload {
  name?: string;
  value?: string;
  description?: string | null;
  engine?: "codex" | "claude" | null;
  tags?: string[];
}
