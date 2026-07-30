/**
 * Drizzle schema mirror of the cumulative MySQL schema produced by the legacy
 * PHP migrations under ../src/Migrations/. Every column, index, FK, and default
 * matches the production schema 1:1 so this code can read existing rows
 * verbatim.
 *
 * Timestamps are stored as VARCHAR(100) ISO 8601 strings everywhere except:
 *   - hosts.insecure_enabled_until / insecure_grace_until (real DATETIME)
 * Booleans are TINYINT(1). SHA-256 digests are CHAR(64). Encrypted blobs use
 * the `*_enc` LONGTEXT convention and hold an `sbox:v1:…` envelope.
 */

import {
  mysqlTable,
  bigint,
  varchar,
  text,
  longtext,
  tinyint,
  char,
  int,
  datetime,
  json,
  varbinary,
  index,
  uniqueIndex,
  primaryKey,
} from 'drizzle-orm/mysql-core';

// ────────────────────────────────────────────────────────────────────────────
// hosts
// ────────────────────────────────────────────────────────────────────────────

export const hosts = mysqlTable(
  'hosts',
  {
    id: bigint('id', { mode: 'number', unsigned: true }).primaryKey().autoincrement(),
    fqdn: varchar('fqdn', { length: 255 }).notNull(),
    apiKey: char('api_key', { length: 64 }).notNull(),
    apiKeyHash: char('api_key_hash', { length: 64 }),
    apiKeyEnc: longtext('api_key_enc'),
    status: varchar('status', { length: 32 }).notNull().default('active'),
    secure: tinyint('secure').notNull().default(1),
    allowRoamingIps: tinyint('allow_roaming_ips').notNull().default(0),
    reverseDnsMode: tinyint('reverse_dns_mode'),
    lastRefresh: varchar('last_refresh', { length: 100 }),
    authDigest: varchar('auth_digest', { length: 128 }),
    ip4: varchar('ip4', { length: 64 }),
    ip6: varchar('ip6', { length: 64 }),
    clientVersion: varchar('client_version', { length: 64 }),
    clientVersionOverride: varchar('client_version_override', { length: 64 }),
    wrapperVersion: varchar('wrapper_version', { length: 64 }),
    agentsDocumentIdOverride: bigint('agents_document_id_override', { mode: 'number', unsigned: true }),
    apiCalls: bigint('api_calls', { mode: 'number', unsigned: true }).notNull().default(0),
    insecureEnabledUntil: datetime('insecure_enabled_until'),
    insecureGraceUntil: datetime('insecure_grace_until'),
    insecureWindowMinutes: int('insecure_window_minutes'),
    curlInsecure: tinyint('curl_insecure').notNull().default(0),
    browserosMcpEnabled: tinyint('browseros_mcp_enabled').notNull().default(0),
    expiresAt: varchar('expires_at', { length: 100 }),
    vip: tinyint('vip').notNull().default(0),
    lanePreference: varchar('lane_preference', { length: 16 }),
    modelOverride: varchar('model_override', { length: 128 }),
    reasoningEffortOverride: varchar('reasoning_effort_override', { length: 32 }),
    autoUpdateOverride: tinyint('auto_update_override'),
    lastCronCheck: varchar('last_cron_check', { length: 100 }),
    scalingExempt: tinyint('scaling_exempt').notNull().default(0),
    engines: varchar('engines', { length: 32 }).notNull().default('codex'),
    claudeClientVersion: varchar('claude_client_version', { length: 64 }),
    claudeClientVersionOverride: varchar('claude_client_version_override', { length: 64 }),
    claudeWrapperVersion: varchar('claude_wrapper_version', { length: 64 }),
    claudeAuthDigest: varchar('claude_auth_digest', { length: 128 }),
    claudeModelOverride: varchar('claude_model_override', { length: 128 }),
    claudeReasoningEffortOverride: varchar('claude_reasoning_effort_override', { length: 32 }),
    claudeLastRefresh: varchar('claude_last_refresh', { length: 100 }),
    configVersion: bigint('config_version', { mode: 'number', unsigned: true }).notNull().default(0),
    configBakedAt: varchar('config_baked_at', { length: 40 }),
    wrapperTrack: varchar('wrapper_track', { length: 16 }).notNull().default('v2'),
    createdAt: varchar('created_at', { length: 100 }).notNull(),
    updatedAt: varchar('updated_at', { length: 100 }).notNull(),
  },
  (t) => ({
    fqdnUnique: uniqueIndex('fqdn').on(t.fqdn),
    apiKeyUnique: uniqueIndex('api_key').on(t.apiKey),
    apiKeyHashUnique: uniqueIndex('api_key_hash').on(t.apiKeyHash),
    updatedAtIdx: index('idx_hosts_updated_at').on(t.updatedAt),
    expiresAtIdx: index('idx_hosts_expires_at').on(t.expiresAt),
    wrapperTrackIdx: index('idx_hosts_wrapper_track').on(t.wrapperTrack),
  }),
);

// ────────────────────────────────────────────────────────────────────────────
// host_auth_digests
// ────────────────────────────────────────────────────────────────────────────

export const hostAuthDigests = mysqlTable(
  'host_auth_digests',
  {
    id: bigint('id', { mode: 'number', unsigned: true }).primaryKey().autoincrement(),
    hostId: bigint('host_id', { mode: 'number', unsigned: true }).notNull(),
    digest: varchar('digest', { length: 128 }).notNull(),
    lastSeen: varchar('last_seen', { length: 100 }).notNull(),
    createdAt: varchar('created_at', { length: 100 }).notNull(),
    engine: varchar('engine', { length: 16 }).notNull().default('codex'),
  },
  (t) => ({
    uniqueHostDigest: uniqueIndex('unique_host_digest').on(t.hostId, t.engine, t.digest),
    hostIdx: index('idx_auth_digest_host').on(t.hostId),
    hostEngineIdx: index('idx_auth_digest_host_engine').on(t.hostId, t.engine),
  }),
);

// ────────────────────────────────────────────────────────────────────────────
// host_users
// ────────────────────────────────────────────────────────────────────────────

export const hostUsers = mysqlTable(
  'host_users',
  {
    id: bigint('id', { mode: 'number', unsigned: true }).primaryKey().autoincrement(),
    hostId: bigint('host_id', { mode: 'number', unsigned: true }).notNull(),
    username: varchar('username', { length: 255 }).notNull(),
    hostname: varchar('hostname', { length: 255 }),
    firstSeen: varchar('first_seen', { length: 100 }).notNull(),
    lastSeen: varchar('last_seen', { length: 100 }).notNull(),
  },
  (t) => ({
    uniqHostUser: uniqueIndex('uniq_host_user').on(t.hostId, t.username),
    hostIdx: index('idx_host_users_host').on(t.hostId),
  }),
);

// ────────────────────────────────────────────────────────────────────────────
// auth_payloads / auth_entries / host_auth_states
// ────────────────────────────────────────────────────────────────────────────

export const authPayloads = mysqlTable(
  'auth_payloads',
  {
    id: bigint('id', { mode: 'number', unsigned: true }).primaryKey().autoincrement(),
    lastRefresh: varchar('last_refresh', { length: 100 }).notNull(),
    sha256: char('sha256', { length: 64 }).notNull(),
    sourceHostId: bigint('source_host_id', { mode: 'number', unsigned: true }),
    createdAt: varchar('created_at', { length: 100 }).notNull(),
    body: longtext('body'),
    verificationState: varchar('verification_state', { length: 16 }).notNull().default('pending'),
    verificationCheckedAt: varchar('verification_checked_at', { length: 100 }),
    verificationReason: varchar('verification_reason', { length: 500 }),
    engine: varchar('engine', { length: 16 }).notNull().default('codex'),
    generation: bigint('generation', { mode: 'number', unsigned: true }),
    sourceKind: varchar('source_kind', { length: 32 }).notNull().default('legacy'),
    parentPayloadId: bigint('parent_payload_id', { mode: 'number', unsigned: true }),
    credentialKind: varchar('credential_kind', { length: 32 }),
    fingerprintKid: varchar('fingerprint_kid', { length: 191 }),
    accessFingerprint: char('access_fingerprint', { length: 64 }),
    refreshFingerprint: char('refresh_fingerprint', { length: 64 }),
    pairFingerprint: char('pair_fingerprint', { length: 64 }),
    credentialIssuedAt: varchar('credential_issued_at', { length: 100 }),
    accessExpiresAt: varchar('access_expires_at', { length: 100 }),
    refreshExpiresAt: varchar('refresh_expires_at', { length: 100 }),
    supersededAt: varchar('superseded_at', { length: 100 }),
    purgeAfter: varchar('purge_after', { length: 100 }),
  },
  (t) => ({
    lastRefreshIdx: index('idx_auth_payloads_last_refresh').on(t.lastRefresh),
    createdAtIdx: index('idx_auth_payloads_created_at').on(t.createdAt),
    verificationStateIdx: index('idx_auth_payloads_verification_state').on(
      t.verificationState,
      t.createdAt,
    ),
    engineIdx: index('idx_auth_payloads_engine').on(t.engine),
    generationIdx: uniqueIndex('uq_auth_payloads_engine_generation').on(t.engine, t.generation),
    pairFingerprintIdx: index('idx_auth_payloads_pair_fingerprint').on(t.engine, t.pairFingerprint),
    purgeAfterIdx: index('idx_auth_payloads_purge_after').on(t.purgeAfter),
  }),
);

export const authCanonicalHeads = mysqlTable('auth_canonical_heads', {
  engine: varchar('engine', { length: 16 }).primaryKey(),
  payloadId: bigint('payload_id', { mode: 'number', unsigned: true }).notNull(),
  generation: bigint('generation', { mode: 'number', unsigned: true }).notNull(),
  updatedAt: varchar('updated_at', { length: 100 }).notNull(),
});

export const authEntries = mysqlTable(
  'auth_entries',
  {
    id: bigint('id', { mode: 'number', unsigned: true }).primaryKey().autoincrement(),
    payloadId: bigint('payload_id', { mode: 'number', unsigned: true }).notNull(),
    target: varchar('target', { length: 255 }).notNull(),
    token: text('token').notNull(),
    tokenType: varchar('token_type', { length: 32 }).default('bearer'),
    organization: varchar('organization', { length: 255 }),
    project: varchar('project', { length: 255 }),
    apiBase: varchar('api_base', { length: 255 }),
    meta: json('meta'),
    createdAt: varchar('created_at', { length: 100 }).notNull(),
  },
  (t) => ({
    payloadIdx: index('idx_entries_payload').on(t.payloadId),
    uniqEntryTarget: uniqueIndex('uniq_entry_target').on(t.payloadId, t.target),
  }),
);

export const hostAuthStates = mysqlTable(
  'host_auth_states',
  {
    hostId: bigint('host_id', { mode: 'number', unsigned: true }).notNull(),
    payloadId: bigint('payload_id', { mode: 'number', unsigned: true }).notNull(),
    seenDigest: char('seen_digest', { length: 64 }).notNull(),
    seenAt: varchar('seen_at', { length: 100 }).notNull(),
    engine: varchar('engine', { length: 16 }).notNull().default('codex'),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.hostId, t.engine] }),
  }),
);

// ────────────────────────────────────────────────────────────────────────────
// install_tokens / auth_seed_tokens
// ────────────────────────────────────────────────────────────────────────────

export const installTokens = mysqlTable(
  'install_tokens',
  {
    id: bigint('id', { mode: 'number', unsigned: true }).primaryKey().autoincrement(),
    token: char('token', { length: 64 }).notNull(),
    tokenEnc: longtext('token_enc'),
    hostId: bigint('host_id', { mode: 'number', unsigned: true }).notNull(),
    fqdn: varchar('fqdn', { length: 255 }).notNull(),
    apiKey: char('api_key', { length: 64 }).notNull(),
    apiKeyEnc: longtext('api_key_enc'),
    baseUrl: varchar('base_url', { length: 255 }),
    expiresAt: varchar('expires_at', { length: 100 }).notNull(),
    usedAt: varchar('used_at', { length: 100 }),
    createdAt: varchar('created_at', { length: 100 }).notNull(),
    engine: varchar('engine', { length: 16 }).notNull().default('codex'),
  },
  (t) => ({
    tokenUnique: uniqueIndex('token').on(t.token),
    hostIdx: index('idx_install_tokens_host').on(t.hostId),
    expiresIdx: index('idx_install_tokens_expires_at').on(t.expiresAt),
  }),
);

export const authSeedTokens = mysqlTable(
  'auth_seed_tokens',
  {
    id: bigint('id', { mode: 'number', unsigned: true }).primaryKey().autoincrement(),
    token: char('token', { length: 64 }).notNull(),
    tokenEnc: longtext('token_enc'),
    baseUrl: varchar('base_url', { length: 255 }),
    engine: varchar('engine', { length: 16 }).notNull().default('codex'),
    expiresAt: varchar('expires_at', { length: 100 }).notNull(),
    usedAt: varchar('used_at', { length: 100 }),
    createdAt: varchar('created_at', { length: 100 }).notNull(),
  },
  (t) => ({
    tokenUnique: uniqueIndex('token').on(t.token),
    expiresIdx: index('idx_auth_seed_tokens_expires_at').on(t.expiresAt),
  }),
);

// ────────────────────────────────────────────────────────────────────────────
// cli_auth_requests
// ────────────────────────────────────────────────────────────────────────────

export const cliAuthRequests = mysqlTable(
  'cli_auth_requests',
  {
    id: bigint('id', { mode: 'number', unsigned: true }).primaryKey().autoincrement(),
    requestId: char('request_id', { length: 64 }).notNull(),
    requestIdEnc: longtext('request_id_enc'),
    userCode: char('user_code', { length: 9 }).notNull(),
    userCodeHash: char('user_code_hash', { length: 64 }).notNull(),
    fqdn: varchar('fqdn', { length: 255 }).notNull(),
    secure: tinyint('secure').notNull().default(1),
    status: varchar('status', { length: 16 }).notNull().default('pending'),
    approvedByUserId: bigint('approved_by_user_id', { mode: 'number', unsigned: true }),
    hostId: bigint('host_id', { mode: 'number', unsigned: true }),
    apiKeyEnc: longtext('api_key_enc'),
    ip: varchar('ip', { length: 64 }),
    userAgent: varchar('user_agent', { length: 255 }),
    expiresAt: varchar('expires_at', { length: 100 }).notNull(),
    createdAt: varchar('created_at', { length: 100 }).notNull(),
    approvedAt: varchar('approved_at', { length: 100 }),
    consumedAt: varchar('consumed_at', { length: 100 }),
    engine: varchar('engine', { length: 16 }).notNull().default('codex'),
  },
  (t) => ({
    requestIdUnique: uniqueIndex('request_id').on(t.requestId),
    userCodeIdx: index('idx_cli_auth_user_code').on(t.userCodeHash),
    expiresIdx: index('idx_cli_auth_expires').on(t.expiresAt),
    statusIdx: index('idx_cli_auth_status').on(t.status),
  }),
);

// ────────────────────────────────────────────────────────────────────────────
// skills
// ────────────────────────────────────────────────────────────────────────────

export const skills = mysqlTable(
  'skills',
  {
    id: bigint('id', { mode: 'number', unsigned: true }).primaryKey().autoincrement(),
    slug: varchar('slug', { length: 255 }).notNull(),
    sha256: char('sha256', { length: 64 }).notNull(),
    displayName: varchar('display_name', { length: 255 }),
    description: text('description'),
    manifest: longtext('manifest').notNull(),
    sourceHostId: bigint('source_host_id', { mode: 'number', unsigned: true }),
    sourceType: varchar('source_type', { length: 64 }),
    sourceRepository: varchar('source_repository', { length: 512 }),
    sourcePath: varchar('source_path', { length: 512 }),
    sourceRevision: char('source_revision', { length: 40 }),
    sourceLicense: varchar('source_license', { length: 64 }),
    bundleSha256: char('bundle_sha256', { length: 64 }),
    createdAt: varchar('created_at', { length: 100 }).notNull(),
    updatedAt: varchar('updated_at', { length: 100 }).notNull(),
    deletedAt: varchar('deleted_at', { length: 100 }),
    engine: varchar('engine', { length: 16 }),
  },
  (t) => ({
    slugUnique: uniqueIndex('slug').on(t.slug),
    updatedAtIdx: index('idx_skills_updated_at').on(t.updatedAt),
    engineIdx: index('idx_skills_engine').on(t.engine),
  }),
);

// Auxiliary files belonging to a skill bundle. Ordinary fleet-authored skills
// have no rows here; an external source may attach references/scripts/assets
// while the parent `skills.manifest` remains the canonical SKILL.md body.
export const skillFiles = mysqlTable(
  'skill_files',
  {
    id: bigint('id', { mode: 'number', unsigned: true }).primaryKey().autoincrement(),
    skillId: bigint('skill_id', { mode: 'number', unsigned: true }).notNull(),
    path: varchar('path', { length: 512 }).notNull(),
    sha256: char('sha256', { length: 64 }).notNull(),
    content: longtext('content').notNull(),
    createdAt: varchar('created_at', { length: 100 }).notNull(),
    updatedAt: varchar('updated_at', { length: 100 }).notNull(),
  },
  (t) => ({
    skillPathUnique: uniqueIndex('uq_skill_files_skill_path').on(t.skillId, t.path),
    skillIdx: index('idx_skill_files_skill').on(t.skillId),
  }),
);

// ────────────────────────────────────────────────────────────────────────────
// claude_artifacts — Claude-Code-native fleet collections (subagents,
// slash-commands, output-styles). One table discriminated by `kind`; shares the
// skills lifecycle (slug+sha256 dedup, soft-delete, If-None-Match retrieve).
// `body` is the canonical hashed content (full markdown incl. YAML frontmatter).
// ────────────────────────────────────────────────────────────────────────────

export const claudeArtifacts = mysqlTable(
  'claude_artifacts',
  {
    id: bigint('id', { mode: 'number', unsigned: true }).primaryKey().autoincrement(),
    kind: varchar('kind', { length: 32 }).notNull(), // 'subagent' | 'command' | 'output-style'
    slug: varchar('slug', { length: 255 }).notNull(),
    sha256: char('sha256', { length: 64 }).notNull(),
    displayName: varchar('display_name', { length: 255 }),
    description: text('description'),
    model: varchar('model', { length: 128 }), // per-artifact model, baked into body frontmatter at store time
    frontmatter: json('frontmatter'), // parsed frontmatter so the admin UI renders structured editors
    body: longtext('body').notNull(),
    sourceHostId: bigint('source_host_id', { mode: 'number', unsigned: true }),
    createdAt: varchar('created_at', { length: 100 }).notNull(),
    updatedAt: varchar('updated_at', { length: 100 }).notNull(),
    deletedAt: varchar('deleted_at', { length: 100 }),
    engine: varchar('engine', { length: 16 }), // nullable; null == all engines (matches skills)
  },
  (t) => ({
    kindSlugUnique: uniqueIndex('uq_claude_artifacts_kind_slug').on(t.kind, t.slug),
    kindIdx: index('idx_claude_artifacts_kind').on(t.kind),
    updatedAtIdx: index('idx_claude_artifacts_updated_at').on(t.updatedAt),
    engineIdx: index('idx_claude_artifacts_engine').on(t.engine),
  }),
);

// ────────────────────────────────────────────────────────────────────────────
// agents_documents / agents_document_state
// ────────────────────────────────────────────────────────────────────────────

export const agentsDocuments = mysqlTable(
  'agents_documents',
  {
    id: bigint('id', { mode: 'number', unsigned: true }).primaryKey().autoincrement(),
    sha256: char('sha256', { length: 64 }).notNull(),
    body: longtext('body').notNull(),
    sourceHostId: bigint('source_host_id', { mode: 'number', unsigned: true }),
    createdAt: varchar('created_at', { length: 100 }).notNull(),
    updatedAt: varchar('updated_at', { length: 100 }).notNull(),
    engine: varchar('engine', { length: 16 }).notNull().default('codex'),
  },
  (t) => ({
    updatedAtIdx: index('idx_agents_documents_updated_at').on(t.updatedAt),
    engineIdx: index('idx_agents_documents_engine').on(t.engine),
  }),
);

export const agentsDocumentState = mysqlTable(
  'agents_document_state',
  {
    id: tinyint('id').notNull().primaryKey(),
    mode: varchar('mode', { length: 16 }).notNull(),
    activeDocumentId: bigint('active_document_id', { mode: 'number', unsigned: true }),
    createdAt: varchar('created_at', { length: 100 }).notNull(),
    updatedAt: varchar('updated_at', { length: 100 }).notNull(),
    engine: varchar('engine', { length: 16 }).notNull().default('codex'),
  },
  (t) => ({
    updatedAtIdx: index('idx_agents_document_state_updated_at').on(t.updatedAt),
  }),
);

// ────────────────────────────────────────────────────────────────────────────
// client_config_documents
// ────────────────────────────────────────────────────────────────────────────

export const clientConfigDocuments = mysqlTable(
  'client_config_documents',
  {
    id: bigint('id', { mode: 'number', unsigned: true }).primaryKey().autoincrement(),
    sha256: char('sha256', { length: 64 }).notNull(),
    body: longtext('body').notNull(),
    settings: json('settings'),
    sourceHostId: bigint('source_host_id', { mode: 'number', unsigned: true }),
    createdAt: varchar('created_at', { length: 100 }).notNull(),
    updatedAt: varchar('updated_at', { length: 100 }).notNull(),
    engine: varchar('engine', { length: 16 }).notNull().default('codex'),
  },
  (t) => ({
    updatedAtIdx: index('idx_client_config_documents_updated_at').on(t.updatedAt),
    engineIdx: index('idx_client_config_engine').on(t.engine),
  }),
);

// ────────────────────────────────────────────────────────────────────────────
// mcp_memories
// ────────────────────────────────────────────────────────────────────────────

export const mcpMemories = mysqlTable(
  'mcp_memories',
  {
    id: bigint('id', { mode: 'number', unsigned: true }).primaryKey().autoincrement(),
    hostId: bigint('host_id', { mode: 'number', unsigned: true }).notNull(),
    memoryKey: varchar('memory_key', { length: 128 }).notNull(),
    content: longtext('content').notNull(),
    metadata: json('metadata'),
    tags: json('tags'),
    tagsText: text('tags_text'),
    createdAt: varchar('created_at', { length: 100 }).notNull(),
    updatedAt: varchar('updated_at', { length: 100 }).notNull(),
    deletedAt: varchar('deleted_at', { length: 100 }),
    summary: text('summary'),
    engine: varchar('engine', { length: 16 }),
  },
  (t) => ({
    uniqHostKey: uniqueIndex('uniq_memories_host_key').on(t.hostId, t.memoryKey),
    hostIdx: index('idx_memories_host').on(t.hostId),
  }),
);

// ────────────────────────────────────────────────────────────────────────────
// coord_projects + children
// ────────────────────────────────────────────────────────────────────────────

export const coordProjects = mysqlTable(
  'coord_projects',
  {
    id: bigint('id', { mode: 'number', unsigned: true }).primaryKey().autoincrement(),
    slug: varchar('slug', { length: 255 }).notNull(),
    aboutJson: json('about_json'),
    rosterMarkdown: longtext('roster_markdown'),
    latestEventSeq: bigint('latest_event_seq', { mode: 'number', unsigned: true }).notNull().default(0),
    createdAt: varchar('created_at', { length: 100 }).notNull(),
    updatedAt: varchar('updated_at', { length: 100 }).notNull(),
    archivedAt: varchar('archived_at', { length: 100 }),
  },
  (t) => ({
    slugUnique: uniqueIndex('slug').on(t.slug),
    updatedAtIdx: index('idx_coord_projects_updated_at').on(t.updatedAt),
    archivedAtIdx: index('idx_coord_projects_archived_at').on(t.archivedAt),
  }),
);

export const coordProjectNotes = mysqlTable(
  'coord_project_notes',
  {
    id: bigint('id', { mode: 'number', unsigned: true }).primaryKey().autoincrement(),
    projectId: bigint('project_id', { mode: 'number', unsigned: true }).notNull(),
    header: varchar('header', { length: 255 }).notNull(),
    body: longtext('body').notNull(),
    sourceHostId: bigint('source_host_id', { mode: 'number', unsigned: true }),
    createdAt: varchar('created_at', { length: 100 }).notNull(),
    updatedAt: varchar('updated_at', { length: 100 }).notNull(),
  },
  (t) => ({
    projectIdx: index('idx_coord_project_notes_project').on(t.projectId),
    updatedAtIdx: index('idx_coord_project_notes_updated_at').on(t.updatedAt),
  }),
);

export const coordProjectTodos = mysqlTable(
  'coord_project_todos',
  {
    id: bigint('id', { mode: 'number', unsigned: true }).primaryKey().autoincrement(),
    projectId: bigint('project_id', { mode: 'number', unsigned: true }).notNull(),
    title: varchar('title', { length: 255 }).notNull(),
    detail: longtext('detail').notNull(),
    done: tinyint('done').notNull().default(0),
    doneAt: varchar('done_at', { length: 100 }),
    sourceHostId: bigint('source_host_id', { mode: 'number', unsigned: true }),
    createdAt: varchar('created_at', { length: 100 }).notNull(),
    updatedAt: varchar('updated_at', { length: 100 }).notNull(),
  },
  (t) => ({
    projectIdx: index('idx_coord_project_todos_project').on(t.projectId),
    updatedAtIdx: index('idx_coord_project_todos_updated_at').on(t.updatedAt),
    doneIdx: index('idx_coord_project_todos_done').on(t.done),
  }),
);

export const coordProjectFiles = mysqlTable(
  'coord_project_files',
  {
    id: bigint('id', { mode: 'number', unsigned: true }).primaryKey().autoincrement(),
    projectId: bigint('project_id', { mode: 'number', unsigned: true }).notNull(),
    storedName: varchar('stored_name', { length: 255 }).notNull(),
    description: text('description'),
    content: longtext('content').notNull(),
    contentSha256: char('content_sha256', { length: 64 }).notNull(),
    mimeType: varchar('mime_type', { length: 255 }),
    sourceHostId: bigint('source_host_id', { mode: 'number', unsigned: true }),
    createdAt: varchar('created_at', { length: 100 }).notNull(),
    updatedAt: varchar('updated_at', { length: 100 }).notNull(),
  },
  (t) => ({
    uniqName: uniqueIndex('uniq_coord_project_file_name').on(t.projectId, t.storedName),
    projectIdx: index('idx_coord_project_files_project').on(t.projectId),
    updatedAtIdx: index('idx_coord_project_files_updated_at').on(t.updatedAt),
  }),
);

export const coordProjectFeedback = mysqlTable(
  'coord_project_feedback',
  {
    id: bigint('id', { mode: 'number', unsigned: true }).primaryKey().autoincrement(),
    projectId: bigint('project_id', { mode: 'number', unsigned: true }).notNull(),
    type: varchar('type', { length: 32 }).notNull(),
    title: varchar('title', { length: 255 }).notNull(),
    body: longtext('body').notNull(),
    status: varchar('status', { length: 32 }).notNull().default('open'),
    sourceHostId: bigint('source_host_id', { mode: 'number', unsigned: true }),
    createdAt: varchar('created_at', { length: 100 }).notNull(),
    updatedAt: varchar('updated_at', { length: 100 }).notNull(),
  },
  (t) => ({
    projectIdx: index('idx_coord_project_feedback_project').on(t.projectId),
    updatedAtIdx: index('idx_coord_project_feedback_updated_at').on(t.updatedAt),
  }),
);

/**
 * Durable memories bound to a project (cross-host), as opposed to `mcp_memories`
 * which is keyed on (host_id, memory_key) and therefore host-local.
 *
 * The FULLTEXT index `idx_coord_project_memories_search (content, tags_text)` is
 * NOT declared here: drizzle-orm's mysql-core exposes only index()/uniqueIndex()
 * and cannot express FULLTEXT. Nor are the FKs, which this mirror omits for every
 * coord_project_* table. Both live in
 * `migrations/0003_add_coord_project_memories.sql`, the source of truth for this
 * table's DDL — it also back-fills the index onto a table created from this
 * mirror by `drizzle-kit push`, which would otherwise leave `searchMemories`
 * permanently degraded to a LIKE scan.
 * (`mcp_memories.idx_memories_search` has no such record — it was declared inline
 * in the PHP migration deleted in d06f88b3 and now exists only in deployed DBs.)
 */
export const coordProjectMemories = mysqlTable(
  'coord_project_memories',
  {
    id: bigint('id', { mode: 'number', unsigned: true }).primaryKey().autoincrement(),
    projectId: bigint('project_id', { mode: 'number', unsigned: true }).notNull(),
    memoryKey: varchar('memory_key', { length: 128 }).notNull(),
    content: longtext('content').notNull(),
    metadata: json('metadata'),
    tags: json('tags'),
    tagsText: text('tags_text'),
    sourceHostId: bigint('source_host_id', { mode: 'number', unsigned: true }),
    createdAt: varchar('created_at', { length: 100 }).notNull(),
    updatedAt: varchar('updated_at', { length: 100 }).notNull(),
  },
  (t) => ({
    uniqKey: uniqueIndex('uniq_coord_project_memory_key').on(t.projectId, t.memoryKey),
    projectIdx: index('idx_coord_project_memories_project').on(t.projectId),
    updatedAtIdx: index('idx_coord_project_memories_updated_at').on(t.updatedAt),
  }),
);

export const coordProjectEvents = mysqlTable(
  'coord_project_events',
  {
    id: bigint('id', { mode: 'number', unsigned: true }).primaryKey().autoincrement(),
    projectId: bigint('project_id', { mode: 'number', unsigned: true }).notNull(),
    seq: bigint('seq', { mode: 'number', unsigned: true }).notNull(),
    eventType: varchar('event_type', { length: 64 }).notNull(),
    action: varchar('action', { length: 64 }).notNull(),
    entityType: varchar('entity_type', { length: 64 }),
    entityId: varchar('entity_id', { length: 64 }),
    payloadJson: json('payload_json'),
    sourceHostId: bigint('source_host_id', { mode: 'number', unsigned: true }),
    createdAt: varchar('created_at', { length: 100 }).notNull(),
  },
  (t) => ({
    uniqSeq: uniqueIndex('uniq_coord_project_event_seq').on(t.projectId, t.seq),
    projectIdx: index('idx_coord_project_events_project').on(t.projectId),
    createdAtIdx: index('idx_coord_project_events_created_at').on(t.createdAt),
  }),
);

// ────────────────────────────────────────────────────────────────────────────
// shared_memories + children
// ────────────────────────────────────────────────────────────────────────────

/**
 * Fleet-wide shared memory documents. Deliberately NOT scoped by host or
 * project: `mcp_memories` is keyed `(host_id, memory_key)` and
 * `coord_project_memories` is keyed `(project_id, memory_key)`, so neither can
 * hold a fact that every agent on every host should see. This table is the
 * third substrate — one corpus, addressed by `slug`, readable and writable from
 * any host and either engine. `source_host_id` / `source_engine` are provenance
 * only; do not filter reads by them.
 *
 * Bodies are large (1 MiB cap), so retrieval is chunk-based: the indexed unit is
 * `shared_memory_chunks`, not the document.
 *
 * As with `coord_project_memories`, the FULLTEXT indexes are NOT declared here
 * — drizzle-orm's mysql-core cannot express FULLTEXT. They (and the FKs) live in
 * `migrations/0006_add_shared_memories.sql`, which is the source of truth for
 * this table's DDL and also back-fills the indexes onto tables created from this
 * mirror by `drizzle-kit push`.
 */
export const sharedMemories = mysqlTable(
  'shared_memories',
  {
    id: bigint('id', { mode: 'number', unsigned: true }).primaryKey().autoincrement(),
    slug: varchar('slug', { length: 160 }).notNull(),
    title: varchar('title', { length: 255 }).notNull(),
    summary: text('summary'),
    content: longtext('content').notNull(),
    contentSha256: char('content_sha256', { length: 64 }).notNull(),
    contentLength: int('content_length', { unsigned: true }).notNull().default(0),
    chunkCount: int('chunk_count', { unsigned: true }).notNull().default(0),
    revision: int('revision', { unsigned: true }).notNull().default(1),
    metadata: json('metadata'),
    tags: json('tags'),
    tagsText: text('tags_text'),
    sourceHostId: bigint('source_host_id', { mode: 'number', unsigned: true }),
    sourceEngine: varchar('source_engine', { length: 16 }),
    createdAt: varchar('created_at', { length: 100 }).notNull(),
    updatedAt: varchar('updated_at', { length: 100 }).notNull(),
    deletedAt: varchar('deleted_at', { length: 100 }),
  },
  (t) => ({
    slugUnique: uniqueIndex('uniq_shared_memories_slug').on(t.slug),
    updatedAtIdx: index('idx_shared_memories_updated_at').on(t.updatedAt),
    deletedAtIdx: index('idx_shared_memories_deleted_at').on(t.deletedAt),
  }),
);

/**
 * Retrieval units for `shared_memories`. Chunks carry the document `revision`
 * they were derived from: a rewrite inserts the new revision's chunks and only
 * then deletes the superseded ones, and every read joins on
 * `chunk.revision = memory.revision`. That keeps a crash mid-rewrite from
 * serving a mix of old and new text without needing a transaction around a
 * potentially 500-row chunk rewrite.
 *
 * `char_start` / `char_end` are offsets into `shared_memories.content`, and the
 * chunks of one revision tile the document exactly (chunk 0 starts at 0, the
 * last ends at content_length), so a chunk range is also a byte range.
 */
export const sharedMemoryChunks = mysqlTable(
  'shared_memory_chunks',
  {
    id: bigint('id', { mode: 'number', unsigned: true }).primaryKey().autoincrement(),
    memoryId: bigint('memory_id', { mode: 'number', unsigned: true }).notNull(),
    revision: int('revision', { unsigned: true }).notNull(),
    ordinal: int('ordinal', { unsigned: true }).notNull(),
    heading: varchar('heading', { length: 255 }),
    content: text('content').notNull(),
    charStart: int('char_start', { unsigned: true }).notNull(),
    charEnd: int('char_end', { unsigned: true }).notNull(),
    tagsText: text('tags_text'),
    createdAt: varchar('created_at', { length: 100 }).notNull(),
  },
  (t) => ({
    uniqChunk: uniqueIndex('uniq_shared_memory_chunk').on(t.memoryId, t.revision, t.ordinal),
    memoryIdx: index('idx_shared_memory_chunks_memory').on(t.memoryId, t.revision),
  }),
);

/**
 * Metadata-only audit trail for `shared_memories`. Bodies are intentionally not
 * copied here — at 1 MiB per document a full-body history would dwarf the corpus
 * it describes. Rollback is not a feature of this table; attribution is.
 */
export const sharedMemoryRevisions = mysqlTable(
  'shared_memory_revisions',
  {
    id: bigint('id', { mode: 'number', unsigned: true }).primaryKey().autoincrement(),
    memoryId: bigint('memory_id', { mode: 'number', unsigned: true }).notNull(),
    revision: int('revision', { unsigned: true }).notNull(),
    op: varchar('op', { length: 16 }).notNull(),
    contentSha256: char('content_sha256', { length: 64 }).notNull(),
    contentLength: int('content_length', { unsigned: true }).notNull().default(0),
    deltaLength: int('delta_length').notNull().default(0),
    sourceHostId: bigint('source_host_id', { mode: 'number', unsigned: true }),
    sourceEngine: varchar('source_engine', { length: 16 }),
    note: varchar('note', { length: 255 }),
    createdAt: varchar('created_at', { length: 100 }).notNull(),
  },
  (t) => ({
    uniqRevision: uniqueIndex('uniq_shared_memory_revision').on(t.memoryId, t.revision),
    memoryIdx: index('idx_shared_memory_revisions_memory').on(t.memoryId),
  }),
);

// ────────────────────────────────────────────────────────────────────────────
// admin_*
// ────────────────────────────────────────────────────────────────────────────

export const adminUsers = mysqlTable(
  'admin_users',
  {
    id: bigint('id', { mode: 'number', unsigned: true }).primaryKey().autoincrement(),
    name: varchar('name', { length: 255 }).notNull(),
    username: varchar('username', { length: 64 }).notNull(),
    email: varchar('email', { length: 255 }).notNull(),
    passwordHash: varchar('password_hash', { length: 255 }).notNull(),
    accessLevel: varchar('access_level', { length: 32 }).notNull(),
    active: tinyint('active').notNull().default(1),
    lastLoginAt: varchar('last_login_at', { length: 100 }),
    createdAt: varchar('created_at', { length: 100 }).notNull(),
    updatedAt: varchar('updated_at', { length: 100 }).notNull(),
  },
  (t) => ({
    usernameUnique: uniqueIndex('username').on(t.username),
    emailUnique: uniqueIndex('email').on(t.email),
    accessIdx: index('idx_admin_users_access').on(t.accessLevel),
    activeIdx: index('idx_admin_users_active').on(t.active),
  }),
);

export const adminSessions = mysqlTable(
  'admin_sessions',
  {
    id: bigint('id', { mode: 'number', unsigned: true }).primaryKey().autoincrement(),
    userId: bigint('user_id', { mode: 'number', unsigned: true }).notNull(),
    tokenHash: char('token_hash', { length: 64 }).notNull(),
    ip: varchar('ip', { length: 64 }),
    userAgent: varchar('user_agent', { length: 255 }),
    createdAt: varchar('created_at', { length: 100 }).notNull(),
    lastSeenAt: varchar('last_seen_at', { length: 100 }).notNull(),
    expiresAt: varchar('expires_at', { length: 100 }).notNull(),
  },
  (t) => ({
    tokenHashUnique: uniqueIndex('token_hash').on(t.tokenHash),
    userIdx: index('idx_admin_sessions_user').on(t.userId),
    expiresIdx: index('idx_admin_sessions_expires').on(t.expiresAt),
  }),
);

export const adminPasswordResets = mysqlTable(
  'admin_password_resets',
  {
    id: bigint('id', { mode: 'number', unsigned: true }).primaryKey().autoincrement(),
    userId: bigint('user_id', { mode: 'number', unsigned: true }).notNull(),
    tokenHash: char('token_hash', { length: 64 }).notNull(),
    expiresAt: varchar('expires_at', { length: 100 }).notNull(),
    usedAt: varchar('used_at', { length: 100 }),
    createdAt: varchar('created_at', { length: 100 }).notNull(),
  },
  (t) => ({
    tokenHashUnique: uniqueIndex('token_hash').on(t.tokenHash),
    userIdx: index('idx_admin_password_resets_user').on(t.userId),
    expiresIdx: index('idx_admin_password_resets_expires').on(t.expiresAt),
  }),
);

export const adminPasskeys = mysqlTable(
  'admin_passkeys',
  {
    id: bigint('id', { mode: 'number', unsigned: true }).primaryKey().autoincrement(),
    userId: bigint('user_id', { mode: 'number', unsigned: true }).notNull(),
    credentialId: varbinary('credential_id', { length: 1024 }).notNull(),
    credentialIdHash: char('credential_id_hash', { length: 64 }).notNull(),
    publicKeyPem: text('public_key_pem').notNull(),
    coseAlg: int('cose_alg').notNull(),
    signCount: bigint('sign_count', { mode: 'number', unsigned: true }).notNull().default(0),
    name: varchar('name', { length: 255 }).notNull().default(''),
    transports: varchar('transports', { length: 255 }),
    aaguid: char('aaguid', { length: 36 }),
    createdAt: varchar('created_at', { length: 100 }).notNull(),
    lastUsedAt: varchar('last_used_at', { length: 100 }),
  },
  (t) => ({
    credentialIdHashUnique: uniqueIndex('credential_id_hash').on(t.credentialIdHash),
    userIdx: index('idx_admin_passkeys_user').on(t.userId),
  }),
);

export const adminWebauthnChallenges = mysqlTable(
  'admin_webauthn_challenges',
  {
    id: bigint('id', { mode: 'number', unsigned: true }).primaryKey().autoincrement(),
    challenge: char('challenge', { length: 64 }).notNull(),
    userId: bigint('user_id', { mode: 'number', unsigned: true }),
    type: varchar('type', { length: 16 }).notNull(),
    expiresAt: varchar('expires_at', { length: 100 }).notNull(),
    createdAt: varchar('created_at', { length: 100 }).notNull(),
  },
  (t) => ({
    challengeUnique: uniqueIndex('challenge').on(t.challenge),
    expiresIdx: index('idx_admin_webauthn_challenges_expires').on(t.expiresAt),
  }),
);

export const adminEvents = mysqlTable(
  'admin_events',
  {
    id: bigint('id', { mode: 'number', unsigned: true }).primaryKey().autoincrement(),
    type: varchar('type', { length: 64 }).notNull(),
    hostId: bigint('host_id', { mode: 'number', unsigned: true }),
    payload: json('payload'),
    createdAt: varchar('created_at', { length: 100 }).notNull(),
  },
  (t) => ({
    hostIdx: index('idx_admin_events_host').on(t.hostId),
    typeIdx: index('idx_admin_events_type').on(t.type),
    createdAtIdx: index('idx_admin_events_created_at').on(t.createdAt),
  }),
);

// ────────────────────────────────────────────────────────────────────────────
// insecure_* + token_usage_* + chatgpt + claude + dashboard graph tables
// ────────────────────────────────────────────────────────────────────────────

export const insecureAuthRequests = mysqlTable(
  'insecure_auth_requests',
  {
    id: bigint('id', { mode: 'number', unsigned: true }).primaryKey().autoincrement(),
    hostId: bigint('host_id', { mode: 'number', unsigned: true }).notNull(),
    status: varchar('status', { length: 24 }).notNull(),
    requestIp: varchar('request_ip', { length: 64 }),
    requestedAt: varchar('requested_at', { length: 100 }).notNull(),
    resolvedAt: varchar('resolved_at', { length: 100 }),
    updatedAt: varchar('updated_at', { length: 100 }).notNull(),
    engine: varchar('engine', { length: 16 }).notNull().default('codex'),
  },
  (t) => ({
    hostIdx: index('idx_insecure_auth_requests_host').on(t.hostId),
    statusIdx: index('idx_insecure_auth_requests_status').on(t.status),
    requestedAtIdx: index('idx_insecure_auth_requests_requested_at').on(t.requestedAt),
  }),
);

export const insecureDomainAllows = mysqlTable(
  'insecure_domain_allows',
  {
    id: bigint('id', { mode: 'number', unsigned: true }).primaryKey().autoincrement(),
    domain: varchar('domain', { length: 255 }).notNull(),
    windowMinutes: int('window_minutes').notNull(),
    enabledUntil: varchar('enabled_until', { length: 100 }),
    revokedAt: varchar('revoked_at', { length: 100 }),
    createdAt: varchar('created_at', { length: 100 }).notNull(),
    updatedAt: varchar('updated_at', { length: 100 }).notNull(),
  },
  (t) => ({
    domainUnique: uniqueIndex('idx_insecure_domain_allows_domain').on(t.domain),
    enabledUntilIdx: index('idx_insecure_domain_allows_enabled_until').on(t.enabledUntil),
    revokedAtIdx: index('idx_insecure_domain_allows_revoked_at').on(t.revokedAt),
  }),
);

export const chatgptUsageSnapshots = mysqlTable(
  'chatgpt_usage_snapshots',
  {
    id: bigint('id', { mode: 'number', unsigned: true }).primaryKey().autoincrement(),
    hostId: bigint('host_id', { mode: 'number', unsigned: true }),
    status: varchar('status', { length: 16 }).notNull(),
    planType: varchar('plan_type', { length: 64 }),
    rateAllowed: tinyint('rate_allowed'),
    rateLimitReached: tinyint('rate_limit_reached'),
    primaryUsedPercent: int('primary_used_percent', { unsigned: true }),
    primaryLimitSeconds: bigint('primary_limit_seconds', { mode: 'number', unsigned: true }),
    primaryResetAfterSeconds: bigint('primary_reset_after_seconds', { mode: 'number', unsigned: true }),
    primaryResetAt: varchar('primary_reset_at', { length: 100 }),
    secondaryUsedPercent: int('secondary_used_percent', { unsigned: true }),
    secondaryLimitSeconds: bigint('secondary_limit_seconds', { mode: 'number', unsigned: true }),
    secondaryResetAfterSeconds: bigint('secondary_reset_after_seconds', { mode: 'number', unsigned: true }),
    secondaryResetAt: varchar('secondary_reset_at', { length: 100 }),
    sparkLimitName: varchar('spark_limit_name', { length: 128 }),
    sparkMeteredFeature: varchar('spark_metered_feature', { length: 128 }),
    sparkRateAllowed: tinyint('spark_rate_allowed'),
    sparkRateLimitReached: tinyint('spark_rate_limit_reached'),
    sparkPrimaryUsedPercent: int('spark_primary_used_percent', { unsigned: true }),
    sparkPrimaryLimitSeconds: bigint('spark_primary_limit_seconds', { mode: 'number', unsigned: true }),
    sparkPrimaryResetAfterSeconds: bigint('spark_primary_reset_after_seconds', {
      mode: 'number',
      unsigned: true,
    }),
    sparkPrimaryResetAt: varchar('spark_primary_reset_at', { length: 100 }),
    sparkSecondaryUsedPercent: int('spark_secondary_used_percent', { unsigned: true }),
    sparkSecondaryLimitSeconds: bigint('spark_secondary_limit_seconds', {
      mode: 'number',
      unsigned: true,
    }),
    sparkSecondaryResetAfterSeconds: bigint('spark_secondary_reset_after_seconds', {
      mode: 'number',
      unsigned: true,
    }),
    sparkSecondaryResetAt: varchar('spark_secondary_reset_at', { length: 100 }),
    hasCredits: tinyint('has_credits'),
    unlimited: tinyint('unlimited'),
    creditBalance: varchar('credit_balance', { length: 128 }),
    approxLocalMessages: text('approx_local_messages'),
    approxCloudMessages: text('approx_cloud_messages'),
    raw: longtext('raw'),
    error: text('error'),
    fetchedAt: varchar('fetched_at', { length: 100 }).notNull(),
    nextEligibleAt: varchar('next_eligible_at', { length: 100 }).notNull(),
    createdAt: varchar('created_at', { length: 100 }).notNull(),
  },
  (t) => ({
    hostIdx: index('idx_chatgpt_usage_host').on(t.hostId),
    fetchedIdx: index('idx_chatgpt_usage_fetched').on(t.fetchedAt),
  }),
);

export const dashboardGraphQuotaSnapshots = mysqlTable(
  'dashboard_graph_quota_snapshots',
  {
    id: bigint('id', { mode: 'number', unsigned: true }).primaryKey().autoincrement(),
    fetchedAt: varchar('fetched_at', { length: 100 }).notNull(),
    primaryUsedPercent: int('primary_used_percent', { unsigned: true }),
    primaryLimitSeconds: bigint('primary_limit_seconds', { mode: 'number', unsigned: true }),
    secondaryUsedPercent: int('secondary_used_percent', { unsigned: true }),
    secondaryLimitSeconds: bigint('secondary_limit_seconds', { mode: 'number', unsigned: true }),
    sparkPrimaryUsedPercent: int('spark_primary_used_percent', { unsigned: true }),
    sparkPrimaryLimitSeconds: bigint('spark_primary_limit_seconds', { mode: 'number', unsigned: true }),
    sparkSecondaryUsedPercent: int('spark_secondary_used_percent', { unsigned: true }),
    sparkSecondaryLimitSeconds: bigint('spark_secondary_limit_seconds', {
      mode: 'number',
      unsigned: true,
    }),
    createdAt: varchar('created_at', { length: 100 }).notNull(),
    updatedAt: varchar('updated_at', { length: 100 }).notNull().default('1970-01-01T00:00:00Z'),
  },
  (t) => ({
    fetchedUnique: uniqueIndex('uniq_dashboard_graph_quota_fetched').on(t.fetchedAt),
    updatedIdx: index('idx_dashboard_graph_quota_updated').on(t.updatedAt),
  }),
);

// ────────────────────────────────────────────────────────────────────────────
// logs / rate limits / mcp / versions / openai keys / claude usage
// ────────────────────────────────────────────────────────────────────────────

export const logs = mysqlTable(
  'logs',
  {
    id: bigint('id', { mode: 'number', unsigned: true }).primaryKey().autoincrement(),
    hostId: bigint('host_id', { mode: 'number', unsigned: true }),
    action: varchar('action', { length: 64 }).notNull(),
    details: longtext('details'),
    createdAt: varchar('created_at', { length: 100 }).notNull(),
    engine: varchar('engine', { length: 16 }),
  },
  (t) => ({
    hostIdx: index('idx_logs_host').on(t.hostId),
    createdAtIdx: index('idx_logs_created_at').on(t.createdAt),
  }),
);

export const ipRateLimits = mysqlTable(
  'ip_rate_limits',
  {
    id: bigint('id', { mode: 'number', unsigned: true }).primaryKey().autoincrement(),
    ip: varchar('ip', { length: 64 }).notNull(),
    bucket: varchar('bucket', { length: 64 }).notNull(),
    count: int('count', { unsigned: true }).notNull().default(0),
    resetAt: varchar('reset_at', { length: 100 }).notNull(),
    lastHit: varchar('last_hit', { length: 100 }).notNull(),
    createdAt: varchar('created_at', { length: 100 }).notNull(),
  },
  (t) => ({
    uniqIpBucket: uniqueIndex('uniq_ip_bucket').on(t.ip, t.bucket),
    resetIdx: index('idx_rate_limits_reset_at').on(t.resetAt),
  }),
);

export const mcpAccessLogs = mysqlTable(
  'mcp_access_logs',
  {
    id: bigint('id', { mode: 'number', unsigned: true }).primaryKey().autoincrement(),
    hostId: bigint('host_id', { mode: 'number', unsigned: true }),
    clientIp: varchar('client_ip', { length: 64 }),
    method: varchar('method', { length: 64 }).notNull(),
    name: varchar('name', { length: 128 }),
    success: tinyint('success').notNull().default(0),
    errorCode: int('error_code'),
    errorMessage: text('error_message'),
    createdAt: varchar('created_at', { length: 100 }).notNull(),
    engine: varchar('engine', { length: 16 }),
  },
  (t) => ({
    hostIdx: index('idx_mcp_logs_host').on(t.hostId),
    methodIdx: index('idx_mcp_logs_method').on(t.method),
    createdAtIdx: index('idx_mcp_logs_created_at').on(t.createdAt),
  }),
);

export const mcpSessionTokens = mysqlTable(
  'mcp_session_tokens',
  {
    id: bigint('id', { mode: 'number', unsigned: true }).primaryKey().autoincrement(),
    token: char('token', { length: 64 }).notNull(),
    tokenEnc: longtext('token_enc'),
    hostId: bigint('host_id', { mode: 'number', unsigned: true }).notNull(),
    expiresAt: varchar('expires_at', { length: 100 }).notNull(),
    lastUsedAt: varchar('last_used_at', { length: 100 }),
    createdAt: varchar('created_at', { length: 100 }).notNull(),
    updatedAt: varchar('updated_at', { length: 100 }).notNull(),
  },
  (t) => ({
    tokenUnique: uniqueIndex('token').on(t.token),
    hostIdx: index('idx_mcp_session_tokens_host').on(t.hostId),
    expiresIdx: index('idx_mcp_session_tokens_expires_at').on(t.expiresAt),
  }),
);

export const versions = mysqlTable('versions', {
  name: varchar('name', { length: 191 }).primaryKey(),
  version: longtext('version').notNull(),
  updatedAt: varchar('updated_at', { length: 100 }).notNull(),
});

export const openaiApiKeys = mysqlTable(
  'openai_api_keys',
  {
    id: bigint('id', { mode: 'number', unsigned: true }).primaryKey().autoincrement(),
    name: varchar('name', { length: 255 }).notNull(),
    keyPrefix: varchar('key_prefix', { length: 20 }).notNull(),
    keyHash: char('key_hash', { length: 64 }).notNull(),
    keyEnc: longtext('key_enc'),
    adminUserId: bigint('admin_user_id', { mode: 'number', unsigned: true }),
    rateLimitRpm: int('rate_limit_rpm', { unsigned: true }).notNull().default(60),
    isActive: tinyint('is_active').notNull().default(1),
    useCount: bigint('use_count', { mode: 'number', unsigned: true }).notNull().default(0),
    lastUsedAt: varchar('last_used_at', { length: 100 }),
    expiresAt: varchar('expires_at', { length: 100 }),
    createdAt: varchar('created_at', { length: 100 }).notNull(),
    updatedAt: varchar('updated_at', { length: 100 }).notNull().default(''),
    engine: varchar('engine', { length: 16 }).notNull().default('codex'),
  },
  (t) => ({
    keyHashUnique: uniqueIndex('key_hash').on(t.keyHash),
    activeIdx: index('idx_openai_keys_active').on(t.isActive),
    prefixIdx: index('idx_openai_keys_prefix').on(t.keyPrefix),
    adminIdx: index('idx_openai_keys_admin').on(t.adminUserId),
    engineIdx: index('idx_openai_keys_engine').on(t.engine),
  }),
);

export const dashboardGraphClaudeQuotaSnapshots = mysqlTable(
  'dashboard_graph_claude_quota_snapshots',
  {
    id: bigint('id', { mode: 'number', unsigned: true }).primaryKey().autoincrement(),
    snapshotAt: varchar('snapshot_at', { length: 100 }).notNull(),
    createdAt: varchar('created_at', { length: 100 }).notNull(),
  },
  (t) => ({
    snapshotIdx: index('idx_snapshot').on(t.snapshotAt),
  }),
);

export const wrapperSigningKeys = mysqlTable(
  'wrapper_signing_keys',
  {
    id: bigint('id', { mode: 'number', unsigned: true }).primaryKey().autoincrement(),
    algo: varchar('algo', { length: 32 }).notNull().default('ed25519'),
    publicKey: text('public_key').notNull(),
    privateKeyEnc: longtext('private_key_enc'),
    active: tinyint('active').notNull().default(1),
    createdAt: varchar('created_at', { length: 40 }).notNull(),
    rotatedAt: varchar('rotated_at', { length: 40 }),
  },
  (t) => ({
    activeIdx: index('idx_wrapper_signing_keys_active').on(t.active),
  }),
);

export const wrapperV2Binaries = mysqlTable(
  'wrapper_v2_binaries',
  {
    id: bigint('id', { mode: 'number', unsigned: true }).primaryKey().autoincrement(),
    engine: varchar('engine', { length: 16 }).notNull(),
    os: varchar('os', { length: 32 }).notNull(),
    arch: varchar('arch', { length: 32 }).notNull(),
    version: varchar('version', { length: 64 }).notNull(),
    sha256: char('sha256', { length: 64 }).notNull(),
    sizeBytes: bigint('size_bytes', { mode: 'number', unsigned: true }).notNull().default(0),
    signature: text('signature'),
    publishedAt: varchar('published_at', { length: 40 }).notNull(),
    uploadedBy: varchar('uploaded_by', { length: 255 }),
  },
  (t) => ({
    uniqTarget: uniqueIndex('uniq_v2_bin_target').on(t.engine, t.os, t.arch, t.version),
    engineVersionIdx: index('idx_v2_bin_engine_version').on(t.engine, t.version),
  }),
);

// ────────────────────────────────────────────────────────────────────────────
// Agent portal — permanent per-user access, live sessions, durable events and
// ordered delivery. User-visible text and bearer material live only in the
// encrypted `*_enc` columns; hashes are used for lookup and comparison.
// ────────────────────────────────────────────────────────────────────────────

export const agentPortalUsers = mysqlTable(
  'agent_portal_users',
  {
    id: bigint('id', { mode: 'number', unsigned: true }).primaryKey().autoincrement(),
    displayName: varchar('display_name', { length: 255 }).notNull(),
    enabled: tinyint('enabled').notNull().default(1),
    publicId: char('public_id', { length: 32 }).notNull(),
    tokenHash: char('token_hash', { length: 64 }).notNull(),
    tokenEnc: longtext('token_enc').notNull(),
    createdAt: varchar('created_at', { length: 100 }).notNull(),
    updatedAt: varchar('updated_at', { length: 100 }).notNull(),
    lastUsedAt: varchar('last_used_at', { length: 100 }),
    disabledAt: varchar('disabled_at', { length: 100 }),
    rotatedAt: varchar('rotated_at', { length: 100 }),
    deletedAt: varchar('deleted_at', { length: 100 }),
  },
  (t) => ({
    publicIdUnique: uniqueIndex('uq_agent_portal_users_public_id').on(t.publicId),
    tokenHashUnique: uniqueIndex('uq_agent_portal_users_token_hash').on(t.tokenHash),
    enabledIdx: index('idx_agent_portal_users_enabled').on(t.enabled),
    deletedIdx: index('idx_agent_portal_users_deleted').on(t.deletedAt),
  }),
);

export const agentPortalBrowserSessions = mysqlTable(
  'agent_portal_browser_sessions',
  {
    id: bigint('id', { mode: 'number', unsigned: true }).primaryKey().autoincrement(),
    userId: bigint('user_id', { mode: 'number', unsigned: true }).notNull(),
    tokenHash: char('token_hash', { length: 64 }).notNull(),
    ip: varchar('ip', { length: 64 }),
    userAgent: varchar('user_agent', { length: 255 }),
    expiresAt: varchar('expires_at', { length: 100 }).notNull(),
    lastSeenAt: varchar('last_seen_at', { length: 100 }).notNull(),
    createdAt: varchar('created_at', { length: 100 }).notNull(),
    revokedAt: varchar('revoked_at', { length: 100 }),
  },
  (t) => ({
    tokenHashUnique: uniqueIndex('uq_agent_portal_browser_sessions_token').on(t.tokenHash),
    userIdx: index('idx_agent_portal_browser_sessions_user').on(t.userId),
    expiresIdx: index('idx_agent_portal_browser_sessions_expires').on(t.expiresAt),
  }),
);

export const agentSessions = mysqlTable(
  'agent_sessions',
  {
    id: char('id', { length: 36 }).primaryKey(),
    hostId: bigint('host_id', { mode: 'number', unsigned: true }).notNull(),
    engine: varchar('engine', { length: 16 }).notNull(),
    username: varchar('username', { length: 255 }).notNull(),
    cwd: varchar('cwd', { length: 1024 }).notNull(),
    upstreamSessionId: varchar('upstream_session_id', { length: 255 }),
    invocationKind: varchar('invocation_kind', { length: 24 }).notNull(),
    status: varchar('status', { length: 24 }).notNull().default('starting'),
    relayEnabled: tinyint('relay_enabled').notNull().default(0),
    relayHeartbeatAt: varchar('relay_heartbeat_at', { length: 100 }),
    activeTurnId: varchar('active_turn_id', { length: 255 }),
    hostAuthFingerprint: char('host_auth_fingerprint', { length: 64 }).notNull(),
    bridgeTokenHash: char('bridge_token_hash', { length: 64 }).notNull(),
    bridgeExpiresAt: varchar('bridge_expires_at', { length: 100 }).notNull(),
    startedAt: varchar('started_at', { length: 100 }).notNull(),
    heartbeatAt: varchar('heartbeat_at', { length: 100 }).notNull(),
    endedAt: varchar('ended_at', { length: 100 }),
    expiresAt: varchar('expires_at', { length: 100 }),
    createdAt: varchar('created_at', { length: 100 }).notNull(),
    updatedAt: varchar('updated_at', { length: 100 }).notNull(),
  },
  (t) => ({
    statusIdx: index('idx_agent_sessions_status').on(t.status, t.heartbeatAt),
    hostIdx: index('idx_agent_sessions_host').on(t.hostId, t.engine),
    expiryIdx: index('idx_agent_sessions_expiry').on(t.expiresAt),
  }),
);

export const agentEvents = mysqlTable(
  'agent_events',
  {
    id: bigint('id', { mode: 'number', unsigned: true }).primaryKey().autoincrement(),
    sessionId: char('session_id', { length: 36 }).notNull(),
    clientEventId: varchar('client_event_id', { length: 64 }).notNull(),
    eventType: varchar('event_type', { length: 32 }).notNull(),
    source: varchar('source', { length: 24 }).notNull(),
    payloadEnc: longtext('payload_enc').notNull(),
    createdAt: varchar('created_at', { length: 100 }).notNull(),
  },
  (t) => ({
    sessionCursorIdx: index('idx_agent_events_session_cursor').on(t.sessionId, t.id),
    clientEventUnique: uniqueIndex('uq_agent_events_session_client').on(t.sessionId, t.clientEventId),
    typeIdx: index('idx_agent_events_type').on(t.eventType, t.createdAt),
  }),
);

export const agentPrompts = mysqlTable(
  'agent_prompts',
  {
    id: char('id', { length: 36 }).primaryKey(),
    sessionId: char('session_id', { length: 36 }).notNull(),
    eventId: bigint('event_id', { mode: 'number', unsigned: true }),
    questionEnc: longtext('question_enc').notNull(),
    optionsEnc: longtext('options_enc'),
    status: varchar('status', { length: 16 }).notNull().default('open'),
    answeredByUserId: bigint('answered_by_user_id', { mode: 'number', unsigned: true }),
    answerMessageId: char('answer_message_id', { length: 36 }),
    version: int('version', { unsigned: true }).notNull().default(1),
    createdAt: varchar('created_at', { length: 100 }).notNull(),
    answeredAt: varchar('answered_at', { length: 100 }),
    expiresAt: varchar('expires_at', { length: 100 }),
  },
  (t) => ({
    sessionStatusIdx: index('idx_agent_prompts_session_status').on(t.sessionId, t.status),
    expiresIdx: index('idx_agent_prompts_expires').on(t.expiresAt),
  }),
);

export const agentMessages = mysqlTable(
  'agent_messages',
  {
    id: bigint('id', { mode: 'number', unsigned: true }).primaryKey().autoincrement(),
    messageId: char('message_id', { length: 36 }).notNull(),
    sessionId: char('session_id', { length: 36 }).notNull(),
    portalUserId: bigint('portal_user_id', { mode: 'number', unsigned: true }).notNull(),
    kind: varchar('kind', { length: 16 }).notNull().default('message'),
    promptId: char('prompt_id', { length: 36 }),
    clientMessageId: char('client_message_id', { length: 36 }).notNull(),
    contentEnc: longtext('content_enc').notNull(),
    status: varchar('status', { length: 16 }).notNull().default('queued'),
    attempts: int('attempts', { unsigned: true }).notNull().default(0),
    nextAttemptAt: varchar('next_attempt_at', { length: 100 }).notNull(),
    leaseOwner: varchar('lease_owner', { length: 191 }),
    leaseUntil: varchar('lease_until', { length: 100 }),
    upstreamId: varchar('upstream_id', { length: 255 }),
    lastError: text('last_error'),
    acceptedAt: varchar('accepted_at', { length: 100 }),
    canceledAt: varchar('canceled_at', { length: 100 }),
    createdAt: varchar('created_at', { length: 100 }).notNull(),
    updatedAt: varchar('updated_at', { length: 100 }).notNull(),
  },
  (t) => ({
    messageIdUnique: uniqueIndex('uq_agent_messages_message_id').on(t.messageId),
    clientIdUnique: uniqueIndex('uq_agent_messages_session_client').on(t.sessionId, t.clientMessageId),
    dispatchIdx: index('idx_agent_messages_dispatch').on(t.sessionId, t.status, t.nextAttemptAt, t.id),
    userIdx: index('idx_agent_messages_user').on(t.portalUserId, t.status),
  }),
);

// ────────────────────────────────────────────────────────────────────────────
// Migration ledger
// ────────────────────────────────────────────────────────────────────────────

/**
 * Written by `db/migrator.ts`, not by Drizzle. Mirrored here so the schema file
 * stays a complete picture of the database; nothing queries it through Drizzle.
 */
export const schemaMigrations = mysqlTable('schema_migrations', {
  version: varchar('version', { length: 32 }).primaryKey(),
  name: varchar('name', { length: 191 }).notNull(),
  checksum: char('checksum', { length: 64 }).notNull(),
  statements: int('statements', { unsigned: true }).notNull().default(0),
  durationMs: int('duration_ms', { unsigned: true }).notNull().default(0),
  appliedAt: varchar('applied_at', { length: 100 }).notNull(),
  appliedBy: varchar('applied_by', { length: 191 }),
});

// ────────────────────────────────────────────────────────────────────────────
// Inferred types
// ────────────────────────────────────────────────────────────────────────────

export type Host = typeof hosts.$inferSelect;
export type NewHost = typeof hosts.$inferInsert;
export type AdminUser = typeof adminUsers.$inferSelect;
export type AdminSession = typeof adminSessions.$inferSelect;
export type AdminPasskey = typeof adminPasskeys.$inferSelect;
export type AuthPayload = typeof authPayloads.$inferSelect;
export type AuthEntry = typeof authEntries.$inferSelect;
export type HostAuthState = typeof hostAuthStates.$inferSelect;
export type Skill = typeof skills.$inferSelect;
export type AgentPortalUser = typeof agentPortalUsers.$inferSelect;
export type AgentPortalBrowserSession = typeof agentPortalBrowserSessions.$inferSelect;
export type AgentSession = typeof agentSessions.$inferSelect;
export type AgentEvent = typeof agentEvents.$inferSelect;
export type AgentPrompt = typeof agentPrompts.$inferSelect;
export type AgentMessage = typeof agentMessages.$inferSelect;
export type ClaudeArtifact = typeof claudeArtifacts.$inferSelect;
export type AgentsDocument = typeof agentsDocuments.$inferSelect;
export type ClientConfigDocument = typeof clientConfigDocuments.$inferSelect;
export type CoordProject = typeof coordProjects.$inferSelect;
export type SharedMemory = typeof sharedMemories.$inferSelect;
export type SharedMemoryChunk = typeof sharedMemoryChunks.$inferSelect;
export type SharedMemoryRevision = typeof sharedMemoryRevisions.$inferSelect;
export type OpenaiApiKey = typeof openaiApiKeys.$inferSelect;
export type IpRateLimit = typeof ipRateLimits.$inferSelect;
export type Log = typeof logs.$inferSelect;
export type Version = typeof versions.$inferSelect;
export type SchemaMigration = typeof schemaMigrations.$inferSelect;
export type CliAuthRequest = typeof cliAuthRequests.$inferSelect;
