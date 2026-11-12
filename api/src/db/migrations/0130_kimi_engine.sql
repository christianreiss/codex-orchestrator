-- Kimi host state and durable single-owner OAuth refresh fencing.
SET @kimi_ddl = IF(EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='hosts' AND column_name='kimi_client_version'), 'SELECT 1', 'ALTER TABLE hosts ADD COLUMN kimi_client_version VARCHAR(64) NULL');
PREPARE kimi_stmt FROM @kimi_ddl; EXECUTE kimi_stmt; DEALLOCATE PREPARE kimi_stmt;
SET @kimi_ddl = IF(EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='hosts' AND column_name='kimi_client_version_override'), 'SELECT 1', 'ALTER TABLE hosts ADD COLUMN kimi_client_version_override VARCHAR(64) NULL');
PREPARE kimi_stmt FROM @kimi_ddl; EXECUTE kimi_stmt; DEALLOCATE PREPARE kimi_stmt;
SET @kimi_ddl = IF(EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='hosts' AND column_name='kimi_wrapper_version'), 'SELECT 1', 'ALTER TABLE hosts ADD COLUMN kimi_wrapper_version VARCHAR(64) NULL');
PREPARE kimi_stmt FROM @kimi_ddl; EXECUTE kimi_stmt; DEALLOCATE PREPARE kimi_stmt;
SET @kimi_ddl = IF(EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='hosts' AND column_name='kimi_auth_digest'), 'SELECT 1', 'ALTER TABLE hosts ADD COLUMN kimi_auth_digest VARCHAR(128) NULL');
PREPARE kimi_stmt FROM @kimi_ddl; EXECUTE kimi_stmt; DEALLOCATE PREPARE kimi_stmt;
SET @kimi_ddl = IF(EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='hosts' AND column_name='kimi_model_override'), 'SELECT 1', 'ALTER TABLE hosts ADD COLUMN kimi_model_override VARCHAR(128) NULL');
PREPARE kimi_stmt FROM @kimi_ddl; EXECUTE kimi_stmt; DEALLOCATE PREPARE kimi_stmt;
SET @kimi_ddl = IF(EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='hosts' AND column_name='kimi_reasoning_effort_override'), 'SELECT 1', 'ALTER TABLE hosts ADD COLUMN kimi_reasoning_effort_override VARCHAR(32) NULL');
PREPARE kimi_stmt FROM @kimi_ddl; EXECUTE kimi_stmt; DEALLOCATE PREPARE kimi_stmt;
SET @kimi_ddl = IF(EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='hosts' AND column_name='kimi_last_refresh'), 'SELECT 1', 'ALTER TABLE hosts ADD COLUMN kimi_last_refresh VARCHAR(100) NULL');
PREPARE kimi_stmt FROM @kimi_ddl; EXECUTE kimi_stmt; DEALLOCATE PREPARE kimi_stmt;

CREATE TABLE IF NOT EXISTS kimi_auth_refresh_state (
 account_id BIGINT UNSIGNED NOT NULL PRIMARY KEY,
 state VARCHAR(24) NOT NULL DEFAULT 'idle', attempt_id VARCHAR(64) NULL,
 base_payload_id BIGINT UNSIGNED NULL, base_generation BIGINT UNSIGNED NULL,
 pending_payload_id BIGINT UNSIGNED NULL, response_enc LONGTEXT NULL,
 next_attempt_at VARCHAR(100) NULL, error_code VARCHAR(100) NULL,
 started_at VARCHAR(100) NULL, updated_at VARCHAR(100) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS kimi_usage_snapshots (
 account_id BIGINT UNSIGNED NOT NULL PRIMARY KEY,
 plan_name VARCHAR(128) NULL,
 plan_fetched_at VARCHAR(100) NULL,
 plan_error_code VARCHAR(48) NULL,
 five_hour_used_percent DOUBLE NULL,
 five_hour_resets_at VARCHAR(100) NULL,
 weekly_used_percent DOUBLE NULL,
 weekly_resets_at VARCHAR(100) NULL,
 month_total_used_percent DOUBLE NULL,
 month_total_resets_at VARCHAR(100) NULL,
 month_code_used_percent DOUBLE NULL,
 month_code_resets_at VARCHAR(100) NULL,
 extra_usage_json TEXT NULL,
 fetched_at VARCHAR(100) NULL,
 checked_at VARCHAR(100) NOT NULL,
 error_code VARCHAR(48) NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

INSERT IGNORE INTO versions (name, version, updated_at) VALUES ('api_surface_backend_kimi', 'kimi', DATE_FORMAT(UTC_TIMESTAMP(), '%Y-%m-%dT%H:%i:%sZ')), ('kimi_api_disabled', '1', DATE_FORMAT(UTC_TIMESTAMP(), '%Y-%m-%dT%H:%i:%sZ'));
