-- Fresh installations select User feedback mode; outbound publication remains opt-in.
INSERT INTO versions (name, version, updated_at) VALUES ('feedback_mode', 'user', '2026-10-20T00:00:00.000Z') ON DUPLICATE KEY UPDATE name = VALUES(name);

CREATE INDEX `control_plane_outbox_due` ON `control_plane_outbox` (`status`,`available_at`);

CREATE TABLE `kimi_auth_refresh_state` (
	`account_id` bigint unsigned NOT NULL,
	`state` varchar(24) NOT NULL DEFAULT 'idle',
	`attempt_id` varchar(64),
	`base_payload_id` bigint unsigned,
	`base_generation` bigint unsigned,
	`pending_payload_id` bigint unsigned,
	`response_enc` longtext,
	`next_attempt_at` varchar(100),
	`error_code` varchar(100),
	`started_at` varchar(100),
	`updated_at` varchar(100) NOT NULL,
	CONSTRAINT `kimi_auth_refresh_state_account_id` PRIMARY KEY(`account_id`)
);

CREATE TABLE `kimi_usage_snapshots` (
  `account_id` BIGINT UNSIGNED NOT NULL PRIMARY KEY,
  `plan_name` VARCHAR(128) NULL,
  `plan_fetched_at` VARCHAR(100) NULL,
  `plan_error_code` VARCHAR(48) NULL,
  `five_hour_used_percent` DOUBLE NULL,
  `five_hour_resets_at` VARCHAR(100) NULL,
  `weekly_used_percent` DOUBLE NULL,
  `weekly_resets_at` VARCHAR(100) NULL,
  `month_total_used_percent` DOUBLE NULL,
  `month_total_resets_at` VARCHAR(100) NULL,
  `month_code_used_percent` DOUBLE NULL,
  `month_code_resets_at` VARCHAR(100) NULL,
  `extra_usage_json` TEXT NULL,
  `fetched_at` VARCHAR(100) NULL,
  `checked_at` VARCHAR(100) NOT NULL,
  `error_code` VARCHAR(48) NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- A newly provisioned host needs a release target before its first native install.
-- Grok and Kimi already follow their native release channels by default.
INSERT INTO versions (name, version, updated_at) VALUES ('client_version_codex', 'latest', '2026-11-21T00:00:00.000Z'), ('client_version_claude', 'latest', '2026-11-21T00:00:00.000Z') ON DUPLICATE KEY UPDATE name = VALUES(name);
