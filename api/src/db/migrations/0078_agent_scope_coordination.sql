-- Session scopes, durable room events and resource claims. Additive and rerunnable.

CREATE TABLE IF NOT EXISTS `agent_resource_claims` (
	`id` char(36) NOT NULL,
	`session_id` char(36) NOT NULL,
	`generation` int unsigned NOT NULL,
	`request_id` char(36) NOT NULL,
	`purpose` varchar(1000) NOT NULL,
	`resources` json NOT NULL,
	`state` varchar(24) NOT NULL,
	`blockers` json NOT NULL,
	`replied_at` varchar(100),
	`expires_at` varchar(100) NOT NULL,
	`created_at` varchar(100) NOT NULL,
	`updated_at` varchar(100) NOT NULL,
	CONSTRAINT `agent_resource_claims_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_resource_claim_request` UNIQUE(`session_id`,`request_id`)
);

CREATE TABLE IF NOT EXISTS `agent_scope_bindings` (
	`repository_key` varchar(191) NOT NULL,
	`project_slug` varchar(191) NOT NULL,
	`updated_at` varchar(100) NOT NULL,
	CONSTRAINT `agent_scope_bindings_repository_key` PRIMARY KEY(`repository_key`)
);

CREATE TABLE IF NOT EXISTS `agent_scope_events` (
	`id` char(36) NOT NULL,
	`scope_id` char(36) NOT NULL,
	`sequence` bigint unsigned NOT NULL,
	`kind` varchar(32) NOT NULL,
	`actor` varchar(191) NOT NULL,
	`request_id` char(36) NOT NULL,
	`body_enc` longtext NOT NULL,
	`dispatched` tinyint NOT NULL DEFAULT 0,
	`created_at` varchar(100) NOT NULL,
	CONSTRAINT `agent_scope_events_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_scope_event_seq` UNIQUE(`scope_id`,`sequence`),
	CONSTRAINT `uq_scope_event_request` UNIQUE(`scope_id`,`actor`,`request_id`)
);

CREATE TABLE IF NOT EXISTS `agent_scope_members` (
	`id` char(36) NOT NULL,
	`scope_id` char(36) NOT NULL,
	`session_id` char(36) NOT NULL,
	`generation` int unsigned NOT NULL,
	`protocol` int unsigned NOT NULL DEFAULT 0,
	`context_hash` char(64) NOT NULL DEFAULT '',
	`state` varchar(16) NOT NULL,
	`joined_at` varchar(100) NOT NULL,
	`updated_at` varchar(100) NOT NULL,
	CONSTRAINT `agent_scope_members_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_agent_scope_member` UNIQUE(`scope_id`,`session_id`)
);

CREATE TABLE IF NOT EXISTS `agent_scopes` (
	`id` char(36) NOT NULL,
	`scope_key` varchar(191) NOT NULL,
	`kind` varchar(16) NOT NULL,
	`title` varchar(255) NOT NULL,
	`sequence` bigint unsigned NOT NULL DEFAULT 0,
	`created_at` varchar(100) NOT NULL,
	CONSTRAINT `agent_scopes_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_agent_scopes_key` UNIQUE(`scope_key`)
);
