-- Test-only baseline schema. NOT a migration — the runner never sees this file
-- and it carries no ledger version. It exists so an empty MySQL becomes a valid
-- starting point for `npm run test:db`: 0003 and 0006 carry foreign keys to
-- `coord_projects`/`hosts`, so the migrations evolve an existing schema and
-- cannot build one from nothing. See `src/db/README.md`.
--
-- Generated from `src/db/schema.ts`, not hand-written. Regenerate after any
-- schema change, from `api/`, with:
--
--   npx drizzle-kit generate --dialect=mysql --schema=./src/db/schema.ts --out=/tmp/baseline
--   { sed -n '1,/^$/p' test/fixtures/schema-baseline.sql;          \
--     sed 's/--> statement-breakpoint//' /tmp/baseline/0000_*.sql; \
--   } > /tmp/baseline/schema-baseline.sql
--   mv /tmp/baseline/schema-baseline.sql test/fixtures/schema-baseline.sql
--
-- The `sed` drops drizzle's own statement separator, which is not SQL and is not
-- a MySQL comment either (`--` only opens one when whitespace follows); what is
-- left is plain semicolon-terminated SQL that `splitSqlStatements` handles like
-- any migration. Nothing else is edited.
--
-- The file therefore has the same blind spots as the mirror: drizzle-orm's
-- mysql-core can express neither FULLTEXT indexes nor foreign keys, so a
-- database built from it is exactly the "push-built" database 0003 and 0006
-- carry their backstops for — which is what makes the real-DB suites meaningful
-- against it.

CREATE TABLE `admin_events` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`type` varchar(64) NOT NULL,
	`host_id` bigint unsigned,
	`payload` json,
	`created_at` varchar(100) NOT NULL,
	CONSTRAINT `admin_events_id` PRIMARY KEY(`id`)
);

CREATE TABLE `admin_passkeys` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`user_id` bigint unsigned NOT NULL,
	`credential_id` varbinary(1024) NOT NULL,
	`credential_id_hash` char(64) NOT NULL,
	`public_key_pem` text NOT NULL,
	`cose_alg` int NOT NULL,
	`sign_count` bigint unsigned NOT NULL DEFAULT 0,
	`name` varchar(255) NOT NULL DEFAULT '',
	`transports` varchar(255),
	`aaguid` char(36),
	`created_at` varchar(100) NOT NULL,
	`last_used_at` varchar(100),
	CONSTRAINT `admin_passkeys_id` PRIMARY KEY(`id`),
	CONSTRAINT `credential_id_hash` UNIQUE(`credential_id_hash`)
);

CREATE TABLE `admin_password_resets` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`user_id` bigint unsigned NOT NULL,
	`token_hash` char(64) NOT NULL,
	`expires_at` varchar(100) NOT NULL,
	`used_at` varchar(100),
	`created_at` varchar(100) NOT NULL,
	CONSTRAINT `admin_password_resets_id` PRIMARY KEY(`id`),
	CONSTRAINT `token_hash` UNIQUE(`token_hash`)
);

CREATE TABLE `admin_sessions` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`user_id` bigint unsigned NOT NULL,
	`token_hash` char(64) NOT NULL,
	`ip` varchar(64),
	`user_agent` varchar(255),
	`created_at` varchar(100) NOT NULL,
	`last_seen_at` varchar(100) NOT NULL,
	`expires_at` varchar(100) NOT NULL,
	CONSTRAINT `admin_sessions_id` PRIMARY KEY(`id`),
	CONSTRAINT `token_hash` UNIQUE(`token_hash`)
);

CREATE TABLE `admin_users` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`name` varchar(255) NOT NULL,
	`username` varchar(64) NOT NULL,
	`email` varchar(255) NOT NULL,
	`password_hash` varchar(255) NOT NULL,
	`access_level` varchar(32) NOT NULL,
	`active` tinyint NOT NULL DEFAULT 1,
	`last_login_at` varchar(100),
	`created_at` varchar(100) NOT NULL,
	`updated_at` varchar(100) NOT NULL,
	CONSTRAINT `admin_users_id` PRIMARY KEY(`id`),
	CONSTRAINT `username` UNIQUE(`username`),
	CONSTRAINT `email` UNIQUE(`email`)
);

CREATE TABLE `admin_webauthn_challenges` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`challenge` char(64) NOT NULL,
	`user_id` bigint unsigned,
	`type` varchar(16) NOT NULL,
	`expires_at` varchar(100) NOT NULL,
	`created_at` varchar(100) NOT NULL,
	CONSTRAINT `admin_webauthn_challenges_id` PRIMARY KEY(`id`),
	CONSTRAINT `challenge` UNIQUE(`challenge`)
);

CREATE TABLE `agent_bus_addresses` (
	`id` char(36) NOT NULL,
	`address` varchar(48) NOT NULL,
	`display_alias` varchar(96),
	`host_id` bigint unsigned NOT NULL,
	`engine` varchar(16) NOT NULL,
	`username` varchar(255) NOT NULL,
	`cwd` varchar(1024) NOT NULL,
	`cwd_hash` char(64) NOT NULL,
	`enabled` tinyint NOT NULL DEFAULT 1,
	`current_session_id` char(36),
	`last_upstream_session_id` varchar(255),
	`binding_generation` int unsigned NOT NULL DEFAULT 1,
	`continuity` varchar(16) NOT NULL DEFAULT 'native',
	`adapter_protocol` varchar(32),
	`adapter_capabilities` json,
	`readiness` varchar(24) NOT NULL DEFAULT 'offline',
	`receive_heartbeat_at` varchar(100),
	`last_seen_at` varchar(100) NOT NULL,
	`archived_at` varchar(100),
	`created_at` varchar(100) NOT NULL,
	`updated_at` varchar(100) NOT NULL,
	CONSTRAINT `agent_bus_addresses_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_agent_bus_addresses_address` UNIQUE(`address`),
	CONSTRAINT `uq_agent_bus_addresses_alias` UNIQUE(`display_alias`),
	CONSTRAINT `uq_agent_bus_addresses_session` UNIQUE(`current_session_id`)
);

CREATE TABLE `agent_bus_conversations` (
	`id` char(36) NOT NULL,
	`address_a_id` char(36) NOT NULL,
	`address_b_id` char(36) NOT NULL,
	`created_by_address_id` char(36) NOT NULL,
	`next_sequence` bigint unsigned NOT NULL DEFAULT 1,
	`status` varchar(16) NOT NULL DEFAULT 'open',
	`last_activity_at` varchar(100) NOT NULL,
	`canceled_by` varchar(191),
	`cancel_reason` varchar(255),
	`canceled_at` varchar(100),
	`created_at` varchar(100) NOT NULL,
	`updated_at` varchar(100) NOT NULL,
	CONSTRAINT `agent_bus_conversations_id` PRIMARY KEY(`id`)
);

CREATE TABLE `agent_bus_messages` (
	`id` char(36) NOT NULL,
	`dispatch_order` bigint unsigned AUTO_INCREMENT NOT NULL,
	`conversation_id` char(36) NOT NULL,
	`sequence` bigint unsigned NOT NULL,
	`reply_to_message_id` char(36),
	`redrive_of_message_id` char(36),
	`sender_address_id` char(36) NOT NULL,
	`sender_session_id` char(36),
	`target_address_id` char(36) NOT NULL,
	`source_engine` varchar(16) NOT NULL,
	`target_engine` varchar(16) NOT NULL,
	`kind` varchar(16) NOT NULL DEFAULT 'message',
	`content_enc` longtext NOT NULL,
	`content_bytes` int unsigned NOT NULL,
	`client_message_id` char(36) NOT NULL,
	`status` varchar(16) NOT NULL DEFAULT 'queued',
	`attempts` int unsigned NOT NULL DEFAULT 0,
	`next_attempt_at` varchar(100) NOT NULL,
	`lease_owner` varchar(191),
	`lease_until` varchar(100),
	`claim_id` char(36),
	`relay_generation` int unsigned,
	`target_binding_generation` int unsigned,
	`delivery_session_id` char(36),
	`delivery_upstream_session_id` varchar(255),
	`expires_at` varchar(100) NOT NULL,
	`last_error_code` varchar(64),
	`last_error_enc` longtext,
	`cancel_requested_at` varchar(100),
	`accepted_at` varchar(100),
	`completed_at` varchar(100),
	`ambiguous_at` varchar(100),
	`dead_at` varchar(100),
	`expired_at` varchar(100),
	`canceled_at` varchar(100),
	`created_at` varchar(100) NOT NULL,
	`updated_at` varchar(100) NOT NULL,
	CONSTRAINT `agent_bus_messages_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_agent_bus_messages_dispatch_order` UNIQUE(`dispatch_order`),
	CONSTRAINT `uq_agent_bus_messages_sender_client` UNIQUE(`sender_address_id`,`client_message_id`),
	CONSTRAINT `uq_agent_bus_messages_conversation_sequence` UNIQUE(`conversation_id`,`sequence`)
);

CREATE TABLE `agent_bus_relays` (
	`id` char(36) NOT NULL,
	`host_id` bigint unsigned NOT NULL,
	`username` varchar(255) NOT NULL,
	`instance_id` char(36) NOT NULL,
	`generation` int unsigned NOT NULL DEFAULT 1,
	`token_hash` char(64),
	`token_expires_at` varchar(100),
	`host_auth_fingerprint` char(64) NOT NULL,
	`wrapper_version` varchar(64) NOT NULL,
	`capabilities` json,
	`status` varchar(16) NOT NULL DEFAULT 'active',
	`heartbeat_at` varchar(100) NOT NULL,
	`stop_requested_at` varchar(100),
	`stopped_at` varchar(100),
	`created_at` varchar(100) NOT NULL,
	`updated_at` varchar(100) NOT NULL,
	CONSTRAINT `agent_bus_relays_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_agent_bus_relays_host_user` UNIQUE(`host_id`,`username`)
);

CREATE TABLE `agent_events` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`session_id` char(36) NOT NULL,
	`client_event_id` varchar(64) NOT NULL,
	`event_type` varchar(32) NOT NULL,
	`source` varchar(24) NOT NULL,
	`payload_enc` longtext NOT NULL,
	`created_at` varchar(100) NOT NULL,
	CONSTRAINT `agent_events_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_agent_events_session_client` UNIQUE(`session_id`,`client_event_id`)
);

CREATE TABLE `agent_messages` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`message_id` char(36) NOT NULL,
	`session_id` char(36) NOT NULL,
	`portal_user_id` bigint unsigned NOT NULL,
	`kind` varchar(16) NOT NULL DEFAULT 'message',
	`prompt_id` char(36),
	`client_message_id` char(36) NOT NULL,
	`content_enc` longtext NOT NULL,
	`status` varchar(16) NOT NULL DEFAULT 'queued',
	`attempts` int unsigned NOT NULL DEFAULT 0,
	`next_attempt_at` varchar(100) NOT NULL,
	`lease_owner` varchar(191),
	`lease_until` varchar(100),
	`upstream_id` varchar(255),
	`last_error` text,
	`accepted_at` varchar(100),
	`canceled_at` varchar(100),
	`created_at` varchar(100) NOT NULL,
	`updated_at` varchar(100) NOT NULL,
	CONSTRAINT `agent_messages_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_agent_messages_message_id` UNIQUE(`message_id`),
	CONSTRAINT `uq_agent_messages_session_client` UNIQUE(`session_id`,`client_message_id`)
);

CREATE TABLE `agent_portal_browser_sessions` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`user_id` bigint unsigned NOT NULL,
	`token_hash` char(64) NOT NULL,
	`ip` varchar(64),
	`user_agent` varchar(255),
	`expires_at` varchar(100) NOT NULL,
	`last_seen_at` varchar(100) NOT NULL,
	`created_at` varchar(100) NOT NULL,
	`revoked_at` varchar(100),
	CONSTRAINT `agent_portal_browser_sessions_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_agent_portal_browser_sessions_token` UNIQUE(`token_hash`)
);

CREATE TABLE `agent_portal_users` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`display_name` varchar(255) NOT NULL,
	`enabled` tinyint NOT NULL DEFAULT 1,
	`public_id` char(32) NOT NULL,
	`token_hash` char(64) NOT NULL,
	`token_enc` longtext NOT NULL,
	`created_at` varchar(100) NOT NULL,
	`updated_at` varchar(100) NOT NULL,
	`last_used_at` varchar(100),
	`disabled_at` varchar(100),
	`rotated_at` varchar(100),
	`deleted_at` varchar(100),
	CONSTRAINT `agent_portal_users_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_agent_portal_users_public_id` UNIQUE(`public_id`),
	CONSTRAINT `uq_agent_portal_users_token_hash` UNIQUE(`token_hash`)
);

CREATE TABLE `agent_prompts` (
	`id` char(36) NOT NULL,
	`session_id` char(36) NOT NULL,
	`event_id` bigint unsigned,
	`question_enc` longtext NOT NULL,
	`options_enc` longtext,
	`status` varchar(16) NOT NULL DEFAULT 'open',
	`answered_by_user_id` bigint unsigned,
	`answer_message_id` char(36),
	`version` int unsigned NOT NULL DEFAULT 1,
	`created_at` varchar(100) NOT NULL,
	`answered_at` varchar(100),
	`expires_at` varchar(100),
	CONSTRAINT `agent_prompts_id` PRIMARY KEY(`id`)
);

CREATE TABLE `agent_sessions` (
	`id` char(36) NOT NULL,
	`host_id` bigint unsigned NOT NULL,
	`engine` varchar(16) NOT NULL,
	`username` varchar(255) NOT NULL,
	`cwd` varchar(1024) NOT NULL,
	`upstream_session_id` varchar(255),
	`agent_bus_address_id` char(36),
	`invocation_kind` varchar(24) NOT NULL,
	`status` varchar(24) NOT NULL DEFAULT 'starting',
	`relay_enabled` tinyint NOT NULL DEFAULT 0,
	`relay_heartbeat_at` varchar(100),
	`active_turn_id` varchar(255),
	`adapter_protocol` varchar(32),
	`adapter_capabilities` json,
	`receive_heartbeat_at` varchar(100),
	`binding_generation` int unsigned NOT NULL DEFAULT 0,
	`host_auth_fingerprint` char(64) NOT NULL,
	`bridge_token_hash` char(64) NOT NULL,
	`bridge_expires_at` varchar(100) NOT NULL,
	`started_at` varchar(100) NOT NULL,
	`heartbeat_at` varchar(100) NOT NULL,
	`ended_at` varchar(100),
	`expires_at` varchar(100),
	`created_at` varchar(100) NOT NULL,
	`updated_at` varchar(100) NOT NULL,
	CONSTRAINT `agent_sessions_id` PRIMARY KEY(`id`)
);

CREATE TABLE `agents_document_state` (
	`id` tinyint NOT NULL,
	`mode` varchar(16) NOT NULL,
	`active_document_id` bigint unsigned,
	`created_at` varchar(100) NOT NULL,
	`updated_at` varchar(100) NOT NULL,
	`engine` varchar(16) NOT NULL DEFAULT 'codex',
	CONSTRAINT `agents_document_state_id` PRIMARY KEY(`id`)
);

CREATE TABLE `agents_documents` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`sha256` char(64) NOT NULL,
	`body` longtext NOT NULL,
	`source_host_id` bigint unsigned,
	`created_at` varchar(100) NOT NULL,
	`updated_at` varchar(100) NOT NULL,
	`engine` varchar(16) NOT NULL DEFAULT 'codex',
	CONSTRAINT `agents_documents_id` PRIMARY KEY(`id`)
);

CREATE TABLE `auth_canonical_heads` (
	`engine` varchar(16) NOT NULL,
	`payload_id` bigint unsigned NOT NULL,
	`generation` bigint unsigned NOT NULL,
	`updated_at` varchar(100) NOT NULL,
	CONSTRAINT `auth_canonical_heads_engine` PRIMARY KEY(`engine`)
);

CREATE TABLE `auth_entries` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`payload_id` bigint unsigned NOT NULL,
	`target` varchar(255) NOT NULL,
	`token` text NOT NULL,
	`token_type` varchar(32) DEFAULT 'bearer',
	`organization` varchar(255),
	`project` varchar(255),
	`api_base` varchar(255),
	`meta` json,
	`created_at` varchar(100) NOT NULL,
	CONSTRAINT `auth_entries_id` PRIMARY KEY(`id`),
	CONSTRAINT `uniq_entry_target` UNIQUE(`payload_id`,`target`)
);

CREATE TABLE `auth_payloads` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`last_refresh` varchar(100) NOT NULL,
	`sha256` char(64) NOT NULL,
	`source_host_id` bigint unsigned,
	`created_at` varchar(100) NOT NULL,
	`body` longtext,
	`verification_state` varchar(16) NOT NULL DEFAULT 'pending',
	`verification_checked_at` varchar(100),
	`verification_reason` varchar(500),
	`engine` varchar(16) NOT NULL DEFAULT 'codex',
	`generation` bigint unsigned,
	`source_kind` varchar(32) NOT NULL DEFAULT 'legacy',
	`parent_payload_id` bigint unsigned,
	`credential_kind` varchar(32),
	`fingerprint_kid` varchar(191),
	`access_fingerprint` char(64),
	`refresh_fingerprint` char(64),
	`pair_fingerprint` char(64),
	`credential_issued_at` varchar(100),
	`access_expires_at` varchar(100),
	`refresh_expires_at` varchar(100),
	`superseded_at` varchar(100),
	`purge_after` varchar(100),
	CONSTRAINT `auth_payloads_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_auth_payloads_engine_generation` UNIQUE(`engine`,`generation`)
);

CREATE TABLE `auth_seed_tokens` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`token` char(64) NOT NULL,
	`token_enc` longtext,
	`base_url` varchar(255),
	`engine` varchar(16) NOT NULL DEFAULT 'codex',
	`expires_at` varchar(100) NOT NULL,
	`used_at` varchar(100),
	`created_at` varchar(100) NOT NULL,
	CONSTRAINT `auth_seed_tokens_id` PRIMARY KEY(`id`),
	CONSTRAINT `token` UNIQUE(`token`)
);

CREATE TABLE `chatgpt_usage_snapshots` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`host_id` bigint unsigned,
	`status` varchar(16) NOT NULL,
	`plan_type` varchar(64),
	`rate_allowed` tinyint,
	`rate_limit_reached` tinyint,
	`primary_used_percent` int unsigned,
	`primary_limit_seconds` bigint unsigned,
	`primary_reset_after_seconds` bigint unsigned,
	`primary_reset_at` varchar(100),
	`secondary_used_percent` int unsigned,
	`secondary_limit_seconds` bigint unsigned,
	`secondary_reset_after_seconds` bigint unsigned,
	`secondary_reset_at` varchar(100),
	`spark_limit_name` varchar(128),
	`spark_metered_feature` varchar(128),
	`spark_rate_allowed` tinyint,
	`spark_rate_limit_reached` tinyint,
	`spark_primary_used_percent` int unsigned,
	`spark_primary_limit_seconds` bigint unsigned,
	`spark_primary_reset_after_seconds` bigint unsigned,
	`spark_primary_reset_at` varchar(100),
	`spark_secondary_used_percent` int unsigned,
	`spark_secondary_limit_seconds` bigint unsigned,
	`spark_secondary_reset_after_seconds` bigint unsigned,
	`spark_secondary_reset_at` varchar(100),
	`has_credits` tinyint,
	`unlimited` tinyint,
	`credit_balance` varchar(128),
	`approx_local_messages` text,
	`approx_cloud_messages` text,
	`raw` longtext,
	`error` text,
	`fetched_at` varchar(100) NOT NULL,
	`next_eligible_at` varchar(100) NOT NULL,
	`created_at` varchar(100) NOT NULL,
	CONSTRAINT `chatgpt_usage_snapshots_id` PRIMARY KEY(`id`)
);

CREATE TABLE `claude_artifacts` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`kind` varchar(32) NOT NULL,
	`slug` varchar(255) NOT NULL,
	`sha256` char(64) NOT NULL,
	`display_name` varchar(255),
	`description` text,
	`model` varchar(128),
	`frontmatter` json,
	`body` longtext NOT NULL,
	`source_host_id` bigint unsigned,
	`created_at` varchar(100) NOT NULL,
	`updated_at` varchar(100) NOT NULL,
	`deleted_at` varchar(100),
	`engine` varchar(16),
	CONSTRAINT `claude_artifacts_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_claude_artifacts_kind_slug` UNIQUE(`kind`,`slug`)
);

CREATE TABLE `cli_auth_requests` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`request_id` char(64) NOT NULL,
	`request_id_enc` longtext,
	`user_code` char(9) NOT NULL,
	`user_code_hash` char(64) NOT NULL,
	`fqdn` varchar(255) NOT NULL,
	`secure` tinyint NOT NULL DEFAULT 1,
	`status` varchar(16) NOT NULL DEFAULT 'pending',
	`approved_by_user_id` bigint unsigned,
	`host_id` bigint unsigned,
	`api_key_enc` longtext,
	`ip` varchar(64),
	`user_agent` varchar(255),
	`expires_at` varchar(100) NOT NULL,
	`created_at` varchar(100) NOT NULL,
	`approved_at` varchar(100),
	`consumed_at` varchar(100),
	`engine` varchar(16) NOT NULL DEFAULT 'codex',
	CONSTRAINT `cli_auth_requests_id` PRIMARY KEY(`id`),
	CONSTRAINT `request_id` UNIQUE(`request_id`)
);

CREATE TABLE `client_config_documents` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`sha256` char(64) NOT NULL,
	`body` longtext NOT NULL,
	`settings` json,
	`source_host_id` bigint unsigned,
	`created_at` varchar(100) NOT NULL,
	`updated_at` varchar(100) NOT NULL,
	`engine` varchar(16) NOT NULL DEFAULT 'codex',
	CONSTRAINT `client_config_documents_id` PRIMARY KEY(`id`)
);

CREATE TABLE `coord_project_events` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`project_id` bigint unsigned NOT NULL,
	`seq` bigint unsigned NOT NULL,
	`event_type` varchar(64) NOT NULL,
	`action` varchar(64) NOT NULL,
	`entity_type` varchar(64),
	`entity_id` varchar(64),
	`payload_json` json,
	`source_host_id` bigint unsigned,
	`created_at` varchar(100) NOT NULL,
	CONSTRAINT `coord_project_events_id` PRIMARY KEY(`id`),
	CONSTRAINT `uniq_coord_project_event_seq` UNIQUE(`project_id`,`seq`)
);

CREATE TABLE `coord_project_feedback` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`project_id` bigint unsigned NOT NULL,
	`type` varchar(32) NOT NULL,
	`title` varchar(255) NOT NULL,
	`body` longtext NOT NULL,
	`status` varchar(32) NOT NULL DEFAULT 'open',
	`source_host_id` bigint unsigned,
	`created_at` varchar(100) NOT NULL,
	`updated_at` varchar(100) NOT NULL,
	CONSTRAINT `coord_project_feedback_id` PRIMARY KEY(`id`)
);

CREATE TABLE `coord_project_files` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`project_id` bigint unsigned NOT NULL,
	`stored_name` varchar(255) NOT NULL,
	`description` text,
	`content` longtext NOT NULL,
	`content_sha256` char(64) NOT NULL,
	`mime_type` varchar(255),
	`source_host_id` bigint unsigned,
	`created_at` varchar(100) NOT NULL,
	`updated_at` varchar(100) NOT NULL,
	CONSTRAINT `coord_project_files_id` PRIMARY KEY(`id`),
	CONSTRAINT `uniq_coord_project_file_name` UNIQUE(`project_id`,`stored_name`)
);

CREATE TABLE `coord_project_memories` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`project_id` bigint unsigned NOT NULL,
	`memory_key` varchar(128) NOT NULL,
	`content` longtext NOT NULL,
	`metadata` json,
	`tags` json,
	`tags_text` text,
	`source_host_id` bigint unsigned,
	`created_at` varchar(100) NOT NULL,
	`updated_at` varchar(100) NOT NULL,
	CONSTRAINT `coord_project_memories_id` PRIMARY KEY(`id`),
	CONSTRAINT `uniq_coord_project_memory_key` UNIQUE(`project_id`,`memory_key`)
);

CREATE TABLE `coord_project_notes` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`project_id` bigint unsigned NOT NULL,
	`header` varchar(255) NOT NULL,
	`body` longtext NOT NULL,
	`source_host_id` bigint unsigned,
	`created_at` varchar(100) NOT NULL,
	`updated_at` varchar(100) NOT NULL,
	CONSTRAINT `coord_project_notes_id` PRIMARY KEY(`id`)
);

CREATE TABLE `coord_project_todos` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`project_id` bigint unsigned NOT NULL,
	`title` varchar(255) NOT NULL,
	`detail` longtext NOT NULL,
	`done` tinyint NOT NULL DEFAULT 0,
	`done_at` varchar(100),
	`source_host_id` bigint unsigned,
	`created_at` varchar(100) NOT NULL,
	`updated_at` varchar(100) NOT NULL,
	CONSTRAINT `coord_project_todos_id` PRIMARY KEY(`id`)
);

CREATE TABLE `coord_projects` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`slug` varchar(255) NOT NULL,
	`about_json` json,
	`roster_markdown` longtext,
	`latest_event_seq` bigint unsigned NOT NULL DEFAULT 0,
	`created_at` varchar(100) NOT NULL,
	`updated_at` varchar(100) NOT NULL,
	`archived_at` varchar(100),
	CONSTRAINT `coord_projects_id` PRIMARY KEY(`id`),
	CONSTRAINT `slug` UNIQUE(`slug`)
);

CREATE TABLE `dashboard_graph_claude_quota_snapshots` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`snapshot_at` varchar(100) NOT NULL,
	`created_at` varchar(100) NOT NULL,
	CONSTRAINT `dashboard_graph_claude_quota_snapshots_id` PRIMARY KEY(`id`)
);

CREATE TABLE `dashboard_graph_quota_snapshots` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`fetched_at` varchar(100) NOT NULL,
	`primary_used_percent` int unsigned,
	`primary_limit_seconds` bigint unsigned,
	`secondary_used_percent` int unsigned,
	`secondary_limit_seconds` bigint unsigned,
	`spark_primary_used_percent` int unsigned,
	`spark_primary_limit_seconds` bigint unsigned,
	`spark_secondary_used_percent` int unsigned,
	`spark_secondary_limit_seconds` bigint unsigned,
	`created_at` varchar(100) NOT NULL,
	`updated_at` varchar(100) NOT NULL DEFAULT '1970-01-01T00:00:00Z',
	CONSTRAINT `dashboard_graph_quota_snapshots_id` PRIMARY KEY(`id`),
	CONSTRAINT `uniq_dashboard_graph_quota_fetched` UNIQUE(`fetched_at`)
);

CREATE TABLE `host_auth_digests` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`host_id` bigint unsigned NOT NULL,
	`digest` varchar(128) NOT NULL,
	`last_seen` varchar(100) NOT NULL,
	`created_at` varchar(100) NOT NULL,
	`engine` varchar(16) NOT NULL DEFAULT 'codex',
	CONSTRAINT `host_auth_digests_id` PRIMARY KEY(`id`),
	CONSTRAINT `unique_host_digest` UNIQUE(`host_id`,`engine`,`digest`)
);

CREATE TABLE `host_auth_states` (
	`host_id` bigint unsigned NOT NULL,
	`payload_id` bigint unsigned NOT NULL,
	`seen_digest` char(64) NOT NULL,
	`seen_at` varchar(100) NOT NULL,
	`engine` varchar(16) NOT NULL DEFAULT 'codex',
	CONSTRAINT `host_auth_states_host_id_engine_pk` PRIMARY KEY(`host_id`,`engine`)
);

CREATE TABLE `host_users` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`host_id` bigint unsigned NOT NULL,
	`username` varchar(255) NOT NULL,
	`hostname` varchar(255),
	`first_seen` varchar(100) NOT NULL,
	`last_seen` varchar(100) NOT NULL,
	CONSTRAINT `host_users_id` PRIMARY KEY(`id`),
	CONSTRAINT `uniq_host_user` UNIQUE(`host_id`,`username`)
);

CREATE TABLE `hosts` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`fqdn` varchar(255) NOT NULL,
	`api_key` char(64) NOT NULL,
	`api_key_hash` char(64),
	`api_key_enc` longtext,
	`status` varchar(32) NOT NULL DEFAULT 'active',
	`secure` tinyint NOT NULL DEFAULT 1,
	`allow_roaming_ips` tinyint NOT NULL DEFAULT 0,
	`reverse_dns_mode` tinyint,
	`last_refresh` varchar(100),
	`auth_digest` varchar(128),
	`ip4` varchar(64),
	`ip6` varchar(64),
	`client_version` varchar(64),
	`client_version_override` varchar(64),
	`wrapper_version` varchar(64),
	`agents_document_id_override` bigint unsigned,
	`api_calls` bigint unsigned NOT NULL DEFAULT 0,
	`insecure_enabled_until` datetime,
	`insecure_grace_until` datetime,
	`insecure_window_minutes` int,
	`curl_insecure` tinyint NOT NULL DEFAULT 0,
	`browseros_mcp_enabled` tinyint NOT NULL DEFAULT 0,
	`agent_messaging_enabled` tinyint NOT NULL DEFAULT 0,
	`expires_at` varchar(100),
	`vip` tinyint NOT NULL DEFAULT 0,
	`lane_preference` varchar(16),
	`model_override` varchar(128),
	`reasoning_effort_override` varchar(32),
	`auto_update_override` tinyint,
	`last_cron_check` varchar(100),
	`scaling_exempt` tinyint NOT NULL DEFAULT 0,
	`engines` varchar(32) NOT NULL DEFAULT 'codex',
	`claude_client_version` varchar(64),
	`claude_client_version_override` varchar(64),
	`claude_wrapper_version` varchar(64),
	`claude_auth_digest` varchar(128),
	`claude_model_override` varchar(128),
	`claude_reasoning_effort_override` varchar(32),
	`claude_last_refresh` varchar(100),
	`config_version` bigint unsigned NOT NULL DEFAULT 0,
	`config_baked_at` varchar(40),
	`wrapper_track` varchar(16) NOT NULL DEFAULT 'v2',
	`created_at` varchar(100) NOT NULL,
	`updated_at` varchar(100) NOT NULL,
	CONSTRAINT `hosts_id` PRIMARY KEY(`id`),
	CONSTRAINT `fqdn` UNIQUE(`fqdn`),
	CONSTRAINT `api_key` UNIQUE(`api_key`),
	CONSTRAINT `api_key_hash` UNIQUE(`api_key_hash`)
);

CREATE TABLE `insecure_auth_requests` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`host_id` bigint unsigned NOT NULL,
	`status` varchar(24) NOT NULL,
	`request_ip` varchar(64),
	`requested_at` varchar(100) NOT NULL,
	`resolved_at` varchar(100),
	`updated_at` varchar(100) NOT NULL,
	`engine` varchar(16) NOT NULL DEFAULT 'codex',
	CONSTRAINT `insecure_auth_requests_id` PRIMARY KEY(`id`)
);

CREATE TABLE `insecure_domain_allows` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`domain` varchar(255) NOT NULL,
	`window_minutes` int NOT NULL,
	`enabled_until` varchar(100),
	`revoked_at` varchar(100),
	`created_at` varchar(100) NOT NULL,
	`updated_at` varchar(100) NOT NULL,
	CONSTRAINT `insecure_domain_allows_id` PRIMARY KEY(`id`),
	CONSTRAINT `idx_insecure_domain_allows_domain` UNIQUE(`domain`)
);

CREATE TABLE `install_tokens` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`token` char(64) NOT NULL,
	`token_enc` longtext,
	`host_id` bigint unsigned NOT NULL,
	`fqdn` varchar(255) NOT NULL,
	`api_key` char(64) NOT NULL,
	`api_key_enc` longtext,
	`base_url` varchar(255),
	`expires_at` varchar(100) NOT NULL,
	`used_at` varchar(100),
	`created_at` varchar(100) NOT NULL,
	`engine` varchar(16) NOT NULL DEFAULT 'codex',
	CONSTRAINT `install_tokens_id` PRIMARY KEY(`id`),
	CONSTRAINT `token` UNIQUE(`token`)
);

CREATE TABLE `ip_rate_limits` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`ip` varchar(64) NOT NULL,
	`bucket` varchar(64) NOT NULL,
	`count` int unsigned NOT NULL DEFAULT 0,
	`reset_at` varchar(100) NOT NULL,
	`last_hit` varchar(100) NOT NULL,
	`created_at` varchar(100) NOT NULL,
	CONSTRAINT `ip_rate_limits_id` PRIMARY KEY(`id`),
	CONSTRAINT `uniq_ip_bucket` UNIQUE(`ip`,`bucket`)
);

CREATE TABLE `logs` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`host_id` bigint unsigned,
	`action` varchar(64) NOT NULL,
	`details` longtext,
	`created_at` varchar(100) NOT NULL,
	`engine` varchar(16),
	CONSTRAINT `logs_id` PRIMARY KEY(`id`)
);

CREATE TABLE `mcp_access_logs` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`host_id` bigint unsigned,
	`client_ip` varchar(64),
	`method` varchar(64) NOT NULL,
	`name` varchar(128),
	`success` tinyint NOT NULL DEFAULT 0,
	`error_code` int,
	`error_message` text,
	`created_at` varchar(100) NOT NULL,
	`engine` varchar(16),
	CONSTRAINT `mcp_access_logs_id` PRIMARY KEY(`id`)
);

CREATE TABLE `mcp_memories` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`host_id` bigint unsigned NOT NULL,
	`memory_key` varchar(128) NOT NULL,
	`content` longtext NOT NULL,
	`metadata` json,
	`tags` json,
	`tags_text` text,
	`created_at` varchar(100) NOT NULL,
	`updated_at` varchar(100) NOT NULL,
	`deleted_at` varchar(100),
	`summary` text,
	`engine` varchar(16),
	CONSTRAINT `mcp_memories_id` PRIMARY KEY(`id`),
	CONSTRAINT `uniq_memories_host_key` UNIQUE(`host_id`,`memory_key`)
);

CREATE TABLE `mcp_session_tokens` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`token` char(64) NOT NULL,
	`token_enc` longtext,
	`host_id` bigint unsigned NOT NULL,
	`expires_at` varchar(100) NOT NULL,
	`last_used_at` varchar(100),
	`created_at` varchar(100) NOT NULL,
	`updated_at` varchar(100) NOT NULL,
	CONSTRAINT `mcp_session_tokens_id` PRIMARY KEY(`id`),
	CONSTRAINT `token` UNIQUE(`token`)
);

CREATE TABLE `openai_api_keys` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`name` varchar(255) NOT NULL,
	`key_prefix` varchar(20) NOT NULL,
	`key_hash` char(64) NOT NULL,
	`key_enc` longtext,
	`admin_user_id` bigint unsigned,
	`rate_limit_rpm` int unsigned NOT NULL DEFAULT 60,
	`is_active` tinyint NOT NULL DEFAULT 1,
	`use_count` bigint unsigned NOT NULL DEFAULT 0,
	`last_used_at` varchar(100),
	`expires_at` varchar(100),
	`created_at` varchar(100) NOT NULL,
	`updated_at` varchar(100) NOT NULL DEFAULT '',
	`engine` varchar(16) NOT NULL DEFAULT 'codex',
	CONSTRAINT `openai_api_keys_id` PRIMARY KEY(`id`),
	CONSTRAINT `key_hash` UNIQUE(`key_hash`)
);

CREATE TABLE `schema_migrations` (
	`version` varchar(32) NOT NULL,
	`name` varchar(191) NOT NULL,
	`checksum` char(64) NOT NULL,
	`statements` int unsigned NOT NULL DEFAULT 0,
	`duration_ms` int unsigned NOT NULL DEFAULT 0,
	`applied_at` varchar(100) NOT NULL,
	`applied_by` varchar(191),
	CONSTRAINT `schema_migrations_version` PRIMARY KEY(`version`)
);

CREATE TABLE `secrets` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`slug` varchar(96) NOT NULL,
	`name` varchar(255) NOT NULL,
	`description` text,
	`value_enc` longtext NOT NULL,
	`engine` varchar(16),
	`source_host_id` bigint unsigned,
	`source_engine` varchar(16),
	`tags` json,
	`tags_text` text,
	`created_at` varchar(100) NOT NULL,
	`updated_at` varchar(100) NOT NULL,
	`last_rotated_at` varchar(100),
	`deleted_at` varchar(100),
	CONSTRAINT `secrets_id` PRIMARY KEY(`id`),
	CONSTRAINT `uniq_secrets_slug` UNIQUE(`slug`)
);

CREATE TABLE `shared_memories` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`slug` varchar(160) NOT NULL,
	`title` varchar(255) NOT NULL,
	`summary` text,
	`content` longtext NOT NULL,
	`content_sha256` char(64) NOT NULL,
	`content_length` int unsigned NOT NULL DEFAULT 0,
	`chunk_count` int unsigned NOT NULL DEFAULT 0,
	`revision` int unsigned NOT NULL DEFAULT 1,
	`metadata` json,
	`tags` json,
	`tags_text` text,
	`source_host_id` bigint unsigned,
	`source_engine` varchar(16),
	`created_at` varchar(100) NOT NULL,
	`updated_at` varchar(100) NOT NULL,
	`deleted_at` varchar(100),
	CONSTRAINT `shared_memories_id` PRIMARY KEY(`id`),
	CONSTRAINT `uniq_shared_memories_slug` UNIQUE(`slug`)
);

CREATE TABLE `shared_memory_chunks` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`memory_id` bigint unsigned NOT NULL,
	`revision` int unsigned NOT NULL,
	`ordinal` int unsigned NOT NULL,
	`heading` varchar(255),
	`content` text NOT NULL,
	`char_start` int unsigned NOT NULL,
	`char_end` int unsigned NOT NULL,
	`tags_text` text,
	`created_at` varchar(100) NOT NULL,
	CONSTRAINT `shared_memory_chunks_id` PRIMARY KEY(`id`),
	CONSTRAINT `uniq_shared_memory_chunk` UNIQUE(`memory_id`,`revision`,`ordinal`)
);

CREATE TABLE `shared_memory_revisions` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`memory_id` bigint unsigned NOT NULL,
	`revision` int unsigned NOT NULL,
	`op` varchar(16) NOT NULL,
	`content_sha256` char(64) NOT NULL,
	`content_length` int unsigned NOT NULL DEFAULT 0,
	`delta_length` int NOT NULL DEFAULT 0,
	`source_host_id` bigint unsigned,
	`source_engine` varchar(16),
	`note` varchar(255),
	`prev_content` longtext,
	`created_at` varchar(100) NOT NULL,
	CONSTRAINT `shared_memory_revisions_id` PRIMARY KEY(`id`),
	CONSTRAINT `uniq_shared_memory_revision` UNIQUE(`memory_id`,`revision`)
);

CREATE TABLE `skill_files` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`skill_id` bigint unsigned NOT NULL,
	`path` varchar(512) NOT NULL,
	`sha256` char(64) NOT NULL,
	`content` longtext NOT NULL,
	`created_at` varchar(100) NOT NULL,
	`updated_at` varchar(100) NOT NULL,
	CONSTRAINT `skill_files_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_skill_files_skill_path` UNIQUE(`skill_id`,`path`)
);

CREATE TABLE `skills` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`slug` varchar(255) NOT NULL,
	`sha256` char(64) NOT NULL,
	`display_name` varchar(255),
	`description` text,
	`manifest` longtext NOT NULL,
	`source_host_id` bigint unsigned,
	`source_type` varchar(64),
	`source_repository` varchar(512),
	`source_path` varchar(512),
	`source_revision` char(40),
	`source_license` varchar(64),
	`bundle_sha256` char(64),
	`created_at` varchar(100) NOT NULL,
	`updated_at` varchar(100) NOT NULL,
	`deleted_at` varchar(100),
	`engine` varchar(16),
	CONSTRAINT `skills_id` PRIMARY KEY(`id`),
	CONSTRAINT `slug` UNIQUE(`slug`)
);

CREATE TABLE `versions` (
	`name` varchar(191) NOT NULL,
	`version` longtext NOT NULL,
	`updated_at` varchar(100) NOT NULL,
	CONSTRAINT `versions_name` PRIMARY KEY(`name`)
);

CREATE TABLE `wrapper_signing_keys` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`algo` varchar(32) NOT NULL DEFAULT 'ed25519',
	`public_key` text NOT NULL,
	`private_key_enc` longtext,
	`active` tinyint NOT NULL DEFAULT 1,
	`created_at` varchar(40) NOT NULL,
	`rotated_at` varchar(40),
	CONSTRAINT `wrapper_signing_keys_id` PRIMARY KEY(`id`)
);

CREATE TABLE `wrapper_v2_binaries` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`engine` varchar(16) NOT NULL,
	`os` varchar(32) NOT NULL,
	`arch` varchar(32) NOT NULL,
	`version` varchar(64) NOT NULL,
	`sha256` char(64) NOT NULL,
	`size_bytes` bigint unsigned NOT NULL DEFAULT 0,
	`signature` text,
	`published_at` varchar(40) NOT NULL,
	`uploaded_by` varchar(255),
	CONSTRAINT `wrapper_v2_binaries_id` PRIMARY KEY(`id`),
	CONSTRAINT `uniq_v2_bin_target` UNIQUE(`engine`,`os`,`arch`,`version`)
);

CREATE INDEX `idx_admin_events_host` ON `admin_events` (`host_id`);
CREATE INDEX `idx_admin_events_type` ON `admin_events` (`type`);
CREATE INDEX `idx_admin_events_created_at` ON `admin_events` (`created_at`);
CREATE INDEX `idx_admin_passkeys_user` ON `admin_passkeys` (`user_id`);
CREATE INDEX `idx_admin_password_resets_user` ON `admin_password_resets` (`user_id`);
CREATE INDEX `idx_admin_password_resets_expires` ON `admin_password_resets` (`expires_at`);
CREATE INDEX `idx_admin_sessions_user` ON `admin_sessions` (`user_id`);
CREATE INDEX `idx_admin_sessions_expires` ON `admin_sessions` (`expires_at`);
CREATE INDEX `idx_admin_users_access` ON `admin_users` (`access_level`);
CREATE INDEX `idx_admin_users_active` ON `admin_users` (`active`);
CREATE INDEX `idx_admin_webauthn_challenges_expires` ON `admin_webauthn_challenges` (`expires_at`);
CREATE INDEX `idx_agent_bus_addresses_discovery` ON `agent_bus_addresses` (`enabled`,`archived_at`,`engine`,`host_id`);
CREATE INDEX `idx_agent_bus_addresses_native` ON `agent_bus_addresses` (`host_id`,`engine`,`username`,`last_upstream_session_id`);
CREATE INDEX `idx_agent_bus_addresses_cwd` ON `agent_bus_addresses` (`host_id`,`engine`,`username`,`cwd_hash`);
CREATE INDEX `idx_agent_bus_conversations_a` ON `agent_bus_conversations` (`address_a_id`,`status`,`last_activity_at`);
CREATE INDEX `idx_agent_bus_conversations_b` ON `agent_bus_conversations` (`address_b_id`,`status`,`last_activity_at`);
CREATE INDEX `idx_agent_bus_conversations_status` ON `agent_bus_conversations` (`status`,`last_activity_at`);
CREATE INDEX `idx_agent_bus_messages_dispatch` ON `agent_bus_messages` (`target_address_id`,`status`,`next_attempt_at`,`dispatch_order`);
CREATE INDEX `idx_agent_bus_messages_conversation` ON `agent_bus_messages` (`conversation_id`,`sequence`);
CREATE INDEX `idx_agent_bus_messages_status` ON `agent_bus_messages` (`status`,`updated_at`);
CREATE INDEX `idx_agent_bus_messages_expiry` ON `agent_bus_messages` (`status`,`expires_at`);
CREATE INDEX `idx_agent_bus_messages_reply` ON `agent_bus_messages` (`reply_to_message_id`);
CREATE INDEX `idx_agent_bus_messages_redrive` ON `agent_bus_messages` (`redrive_of_message_id`);
CREATE INDEX `idx_agent_bus_relays_status` ON `agent_bus_relays` (`status`,`heartbeat_at`);
CREATE INDEX `idx_agent_bus_relays_expiry` ON `agent_bus_relays` (`token_expires_at`);
CREATE INDEX `idx_agent_events_session_cursor` ON `agent_events` (`session_id`,`id`);
CREATE INDEX `idx_agent_events_type` ON `agent_events` (`event_type`,`created_at`);
CREATE INDEX `idx_agent_messages_dispatch` ON `agent_messages` (`session_id`,`status`,`next_attempt_at`,`id`);
CREATE INDEX `idx_agent_messages_user` ON `agent_messages` (`portal_user_id`,`status`);
CREATE INDEX `idx_agent_portal_browser_sessions_user` ON `agent_portal_browser_sessions` (`user_id`);
CREATE INDEX `idx_agent_portal_browser_sessions_expires` ON `agent_portal_browser_sessions` (`expires_at`);
CREATE INDEX `idx_agent_portal_users_enabled` ON `agent_portal_users` (`enabled`);
CREATE INDEX `idx_agent_portal_users_deleted` ON `agent_portal_users` (`deleted_at`);
CREATE INDEX `idx_agent_prompts_session_status` ON `agent_prompts` (`session_id`,`status`);
CREATE INDEX `idx_agent_prompts_expires` ON `agent_prompts` (`expires_at`);
CREATE INDEX `idx_agent_sessions_status` ON `agent_sessions` (`status`,`heartbeat_at`);
CREATE INDEX `idx_agent_sessions_host` ON `agent_sessions` (`host_id`,`engine`);
CREATE INDEX `idx_agent_sessions_expiry` ON `agent_sessions` (`expires_at`);
CREATE INDEX `idx_agent_sessions_address` ON `agent_sessions` (`agent_bus_address_id`,`status`,`heartbeat_at`);
CREATE INDEX `idx_agents_document_state_updated_at` ON `agents_document_state` (`updated_at`);
CREATE INDEX `idx_agents_documents_updated_at` ON `agents_documents` (`updated_at`);
CREATE INDEX `idx_agents_documents_engine` ON `agents_documents` (`engine`);
CREATE INDEX `idx_entries_payload` ON `auth_entries` (`payload_id`);
CREATE INDEX `idx_auth_payloads_last_refresh` ON `auth_payloads` (`last_refresh`);
CREATE INDEX `idx_auth_payloads_created_at` ON `auth_payloads` (`created_at`);
CREATE INDEX `idx_auth_payloads_verification_state` ON `auth_payloads` (`verification_state`,`created_at`);
CREATE INDEX `idx_auth_payloads_engine` ON `auth_payloads` (`engine`);
CREATE INDEX `idx_auth_payloads_pair_fingerprint` ON `auth_payloads` (`engine`,`pair_fingerprint`);
CREATE INDEX `idx_auth_payloads_purge_after` ON `auth_payloads` (`purge_after`);
CREATE INDEX `idx_auth_seed_tokens_expires_at` ON `auth_seed_tokens` (`expires_at`);
CREATE INDEX `idx_chatgpt_usage_host` ON `chatgpt_usage_snapshots` (`host_id`);
CREATE INDEX `idx_chatgpt_usage_fetched` ON `chatgpt_usage_snapshots` (`fetched_at`);
CREATE INDEX `idx_claude_artifacts_kind` ON `claude_artifacts` (`kind`);
CREATE INDEX `idx_claude_artifacts_updated_at` ON `claude_artifacts` (`updated_at`);
CREATE INDEX `idx_claude_artifacts_engine` ON `claude_artifacts` (`engine`);
CREATE INDEX `idx_cli_auth_user_code` ON `cli_auth_requests` (`user_code_hash`);
CREATE INDEX `idx_cli_auth_expires` ON `cli_auth_requests` (`expires_at`);
CREATE INDEX `idx_cli_auth_status` ON `cli_auth_requests` (`status`);
CREATE INDEX `idx_client_config_documents_updated_at` ON `client_config_documents` (`updated_at`);
CREATE INDEX `idx_client_config_engine` ON `client_config_documents` (`engine`);
CREATE INDEX `idx_coord_project_events_project` ON `coord_project_events` (`project_id`);
CREATE INDEX `idx_coord_project_events_created_at` ON `coord_project_events` (`created_at`);
CREATE INDEX `idx_coord_project_feedback_project` ON `coord_project_feedback` (`project_id`);
CREATE INDEX `idx_coord_project_feedback_updated_at` ON `coord_project_feedback` (`updated_at`);
CREATE INDEX `idx_coord_project_files_project` ON `coord_project_files` (`project_id`);
CREATE INDEX `idx_coord_project_files_updated_at` ON `coord_project_files` (`updated_at`);
CREATE INDEX `idx_coord_project_memories_project` ON `coord_project_memories` (`project_id`);
CREATE INDEX `idx_coord_project_memories_updated_at` ON `coord_project_memories` (`updated_at`);
CREATE INDEX `idx_coord_project_notes_project` ON `coord_project_notes` (`project_id`);
CREATE INDEX `idx_coord_project_notes_updated_at` ON `coord_project_notes` (`updated_at`);
CREATE INDEX `idx_coord_project_todos_project` ON `coord_project_todos` (`project_id`);
CREATE INDEX `idx_coord_project_todos_updated_at` ON `coord_project_todos` (`updated_at`);
CREATE INDEX `idx_coord_project_todos_done` ON `coord_project_todos` (`done`);
CREATE INDEX `idx_coord_projects_updated_at` ON `coord_projects` (`updated_at`);
CREATE INDEX `idx_coord_projects_archived_at` ON `coord_projects` (`archived_at`);
CREATE INDEX `idx_snapshot` ON `dashboard_graph_claude_quota_snapshots` (`snapshot_at`);
CREATE INDEX `idx_dashboard_graph_quota_updated` ON `dashboard_graph_quota_snapshots` (`updated_at`);
CREATE INDEX `idx_auth_digest_host` ON `host_auth_digests` (`host_id`);
CREATE INDEX `idx_auth_digest_host_engine` ON `host_auth_digests` (`host_id`,`engine`);
CREATE INDEX `idx_host_users_host` ON `host_users` (`host_id`);
CREATE INDEX `idx_hosts_updated_at` ON `hosts` (`updated_at`);
CREATE INDEX `idx_hosts_expires_at` ON `hosts` (`expires_at`);
CREATE INDEX `idx_hosts_wrapper_track` ON `hosts` (`wrapper_track`);
CREATE INDEX `idx_insecure_auth_requests_host` ON `insecure_auth_requests` (`host_id`);
CREATE INDEX `idx_insecure_auth_requests_status` ON `insecure_auth_requests` (`status`);
CREATE INDEX `idx_insecure_auth_requests_requested_at` ON `insecure_auth_requests` (`requested_at`);
CREATE INDEX `idx_insecure_domain_allows_enabled_until` ON `insecure_domain_allows` (`enabled_until`);
CREATE INDEX `idx_insecure_domain_allows_revoked_at` ON `insecure_domain_allows` (`revoked_at`);
CREATE INDEX `idx_install_tokens_host` ON `install_tokens` (`host_id`);
CREATE INDEX `idx_install_tokens_expires_at` ON `install_tokens` (`expires_at`);
CREATE INDEX `idx_rate_limits_reset_at` ON `ip_rate_limits` (`reset_at`);
CREATE INDEX `idx_logs_host` ON `logs` (`host_id`);
CREATE INDEX `idx_logs_created_at` ON `logs` (`created_at`);
CREATE INDEX `idx_mcp_logs_host` ON `mcp_access_logs` (`host_id`);
CREATE INDEX `idx_mcp_logs_method` ON `mcp_access_logs` (`method`);
CREATE INDEX `idx_mcp_logs_created_at` ON `mcp_access_logs` (`created_at`);
CREATE INDEX `idx_memories_host` ON `mcp_memories` (`host_id`);
CREATE INDEX `idx_mcp_session_tokens_host` ON `mcp_session_tokens` (`host_id`);
CREATE INDEX `idx_mcp_session_tokens_expires_at` ON `mcp_session_tokens` (`expires_at`);
CREATE INDEX `idx_openai_keys_active` ON `openai_api_keys` (`is_active`);
CREATE INDEX `idx_openai_keys_prefix` ON `openai_api_keys` (`key_prefix`);
CREATE INDEX `idx_openai_keys_admin` ON `openai_api_keys` (`admin_user_id`);
CREATE INDEX `idx_openai_keys_engine` ON `openai_api_keys` (`engine`);
CREATE INDEX `idx_secrets_engine` ON `secrets` (`engine`);
CREATE INDEX `idx_secrets_updated_at` ON `secrets` (`updated_at`);
CREATE INDEX `idx_secrets_deleted_at` ON `secrets` (`deleted_at`);
CREATE INDEX `idx_secrets_source_host` ON `secrets` (`source_host_id`);
CREATE INDEX `idx_shared_memories_updated_at` ON `shared_memories` (`updated_at`);
CREATE INDEX `idx_shared_memories_deleted_at` ON `shared_memories` (`deleted_at`);
CREATE INDEX `idx_shared_memory_chunks_memory` ON `shared_memory_chunks` (`memory_id`,`revision`);
CREATE INDEX `idx_shared_memory_revisions_memory` ON `shared_memory_revisions` (`memory_id`);
CREATE INDEX `idx_skill_files_skill` ON `skill_files` (`skill_id`);
CREATE INDEX `idx_skills_updated_at` ON `skills` (`updated_at`);
CREATE INDEX `idx_skills_engine` ON `skills` (`engine`);
CREATE INDEX `idx_wrapper_signing_keys_active` ON `wrapper_signing_keys` (`active`);
CREATE INDEX `idx_v2_bin_engine_version` ON `wrapper_v2_binaries` (`engine`,`version`);
