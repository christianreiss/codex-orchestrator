-- Durable workflows. Additive and idempotent; historical actors are retained.
CREATE TABLE IF NOT EXISTS `workflow_mutations` (
	`id` char(36) NOT NULL,
	`actor_key` varchar(160) NOT NULL,
	`operation` varchar(40) NOT NULL,
	`client_request_id` char(36) NOT NULL,
	`payload_hash` char(64) NOT NULL,
	`response` json,
	`secret_response` text,
	`created_at` varchar(100) NOT NULL,
	CONSTRAINT `workflow_mutations_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_workflow_mutations_request` UNIQUE(`actor_key`,`operation`,`client_request_id`)
);

CREATE TABLE IF NOT EXISTS `workflow_run_evaluations` (
	`run_id` char(36) NOT NULL,
	`version` int NOT NULL DEFAULT 1,
	`status` varchar(16) NOT NULL DEFAULT 'pending',
	`draft` json,
	`applied_version` int,
	`actor` json,
	`finalized_at` varchar(100),
	`created_at` varchar(100) NOT NULL,
	`updated_at` varchar(100) NOT NULL,
	CONSTRAINT `workflow_run_evaluations_run_id` PRIMARY KEY(`run_id`),
	INDEX `idx_workflow_evaluations_pending` (`status`,`updated_at`)
);

CREATE TABLE IF NOT EXISTS `workflow_run_events` (
	`id` char(36) NOT NULL,
	`run_id` char(36) NOT NULL,
	`sequence` int NOT NULL,
	`type` varchar(64) NOT NULL,
	`actor` json NOT NULL,
	`detail` json NOT NULL,
	`created_at` varchar(100) NOT NULL,
	CONSTRAINT `workflow_run_events_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_workflow_event_seq` UNIQUE(`run_id`,`sequence`)
);

CREATE TABLE IF NOT EXISTS `workflow_run_invitations` (
	`id` char(36) NOT NULL,
	`run_id` char(36) NOT NULL,
	`inviter_address_id` char(36) NOT NULL,
	`target_address_id` char(36) NOT NULL,
	`target_session_id` char(36) NOT NULL,
	`target_binding_generation` int NOT NULL,
	`target` json NOT NULL,
	`reason` text NOT NULL,
	`task_ids` json NOT NULL,
	`status` varchar(16) NOT NULL,
	`message_id` char(36),
	`expires_at` varchar(100) NOT NULL,
	`created_at` varchar(100) NOT NULL,
	`updated_at` varchar(100) NOT NULL,
	CONSTRAINT `workflow_run_invitations_id` PRIMARY KEY(`id`),
	INDEX `idx_workflow_invites_target` (`target_address_id`,`status`),
	INDEX `idx_workflow_invites_run` (`run_id`,`status`)
);

CREATE TABLE IF NOT EXISTS `workflow_run_members` (
	`id` char(36) NOT NULL,
	`run_id` char(36) NOT NULL,
	`agent_address_id` char(36) NOT NULL,
	`session_id` char(36) NOT NULL,
	`binding_generation` int NOT NULL,
	`status` varchar(16) NOT NULL,
	`actor` json NOT NULL,
	`reason` text,
	`created_at` varchar(100) NOT NULL,
	`updated_at` varchar(100) NOT NULL,
	CONSTRAINT `workflow_run_members_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_workflow_members_agent` UNIQUE(`run_id`,`agent_address_id`),
	INDEX `idx_workflow_members_agent` (`agent_address_id`,`status`)
);

CREATE TABLE IF NOT EXISTS `workflow_run_tasks` (
	`id` char(36) NOT NULL,
	`run_id` char(36) NOT NULL,
	`task_id` varchar(64) NOT NULL,
	`position` int NOT NULL,
	`title` varchar(255) NOT NULL,
	`status` varchar(16) NOT NULL DEFAULT 'pending',
	`version` int NOT NULL DEFAULT 1,
	`attempt_no` int NOT NULL DEFAULT 0,
	`claim_owner_address_id` char(36),
	`claim_session_id` char(36),
	`claim_binding_generation` int,
	`claim_generation` int NOT NULL DEFAULT 0,
	`claim_token_hash` char(64),
	`claim_lease_until` varchar(100),
	`claim_recovery` tinyint NOT NULL DEFAULT 0,
	`skip_reason` varchar(32),
	`reason` text,
	`outputs` json,
	`evidence` json,
	`created_at` varchar(100) NOT NULL,
	`updated_at` varchar(100) NOT NULL,
	CONSTRAINT `workflow_run_tasks_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_workflow_run_task` UNIQUE(`run_id`,`task_id`),
	INDEX `idx_workflow_tasks_claim` (`claim_owner_address_id`,`claim_lease_until`),
	INDEX `idx_workflow_tasks_run` (`run_id`,`position`)
);

CREATE TABLE IF NOT EXISTS `workflow_runs` (
	`id` char(36) NOT NULL,
	`workflow_id` char(36) NOT NULL,
	`workflow_version_id` char(36) NOT NULL,
	`workflow_version` int NOT NULL,
	`workflow_sha256` char(64) NOT NULL,
	`title` varchar(255) NOT NULL,
	`inputs` json NOT NULL,
	`status` varchar(16) NOT NULL,
	`outcome` varchar(16),
	`version` int NOT NULL DEFAULT 1,
	`event_sequence` int NOT NULL DEFAULT 0,
	`coordinator_address_id` char(36),
	`coordinator_generation` int NOT NULL DEFAULT 0,
	`coordinator_lease_until` varchar(100),
	`cancel_requested` tinyint NOT NULL DEFAULT 0,
	`communication_group_id` char(36),
	`communication` json,
	`summary` text,
	`criteria` json,
	`results` json,
	`open_items` json,
	`report` json,
	`actor` json NOT NULL,
	`started_at` varchar(100),
	`finished_at` varchar(100),
	`completed_at` varchar(100),
	`created_at` varchar(100) NOT NULL,
	`updated_at` varchar(100) NOT NULL,
	CONSTRAINT `workflow_runs_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_workflow_runs_group` UNIQUE(`communication_group_id`),
	INDEX `idx_workflow_runs_workflow` (`workflow_id`,`created_at`),
	INDEX `idx_workflow_runs_status` (`status`,`updated_at`)
);

CREATE TABLE IF NOT EXISTS `workflow_task_attempts` (
	`id` char(36) NOT NULL,
	`run_id` char(36) NOT NULL,
	`task_id` varchar(64) NOT NULL,
	`attempt_no` int NOT NULL,
	`status` varchar(16) NOT NULL,
	`actor` json NOT NULL,
	`execution_host` varchar(255),
	`summary` text,
	`outputs` json,
	`evidence` json,
	`error` text,
	`started_at` varchar(100) NOT NULL,
	`ended_at` varchar(100),
	CONSTRAINT `workflow_task_attempts_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_workflow_attempt_number` UNIQUE(`run_id`,`task_id`,`attempt_no`)
);

CREATE TABLE IF NOT EXISTS `workflow_versions` (
	`id` char(36) NOT NULL,
	`workflow_id` char(36) NOT NULL,
	`version` int NOT NULL,
	`previous_version_id` char(36),
	`document` json NOT NULL,
	`sha256` char(64) NOT NULL,
	`reason` text NOT NULL,
	`diff` json NOT NULL,
	`source_run_id` char(36),
	`actor` json NOT NULL,
	`created_at` varchar(100) NOT NULL,
	CONSTRAINT `workflow_versions_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_workflow_versions_number` UNIQUE(`workflow_id`,`version`)
);

CREATE TABLE IF NOT EXISTS `workflows` (
	`id` char(36) NOT NULL,
	`slug` varchar(64) NOT NULL,
	`status` varchar(16) NOT NULL DEFAULT 'active',
	`current_version` int NOT NULL DEFAULT 1,
	`current_version_id` char(36) NOT NULL,
	`control_version` int NOT NULL DEFAULT 1,
	`title` varchar(255) NOT NULL,
	`summary` text NOT NULL,
	`actor` json NOT NULL,
	`created_at` varchar(100) NOT NULL,
	`updated_at` varchar(100) NOT NULL,
	CONSTRAINT `workflows_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_workflows_slug` UNIQUE(`slug`),
	INDEX `idx_workflows_status` (`status`,`updated_at`)
);

