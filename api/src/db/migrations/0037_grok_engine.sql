-- Grok host state and durable single-owner OAuth refresh fencing.
SET @grok_ddl = IF(EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='hosts' AND column_name='grok_client_version'), 'SELECT 1', 'ALTER TABLE hosts ADD COLUMN grok_client_version VARCHAR(64) NULL');
PREPARE grok_stmt FROM @grok_ddl; EXECUTE grok_stmt; DEALLOCATE PREPARE grok_stmt;
SET @grok_ddl = IF(EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='hosts' AND column_name='grok_client_version_override'), 'SELECT 1', 'ALTER TABLE hosts ADD COLUMN grok_client_version_override VARCHAR(64) NULL');
PREPARE grok_stmt FROM @grok_ddl; EXECUTE grok_stmt; DEALLOCATE PREPARE grok_stmt;
SET @grok_ddl = IF(EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='hosts' AND column_name='grok_wrapper_version'), 'SELECT 1', 'ALTER TABLE hosts ADD COLUMN grok_wrapper_version VARCHAR(64) NULL');
PREPARE grok_stmt FROM @grok_ddl; EXECUTE grok_stmt; DEALLOCATE PREPARE grok_stmt;
SET @grok_ddl = IF(EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='hosts' AND column_name='grok_auth_digest'), 'SELECT 1', 'ALTER TABLE hosts ADD COLUMN grok_auth_digest VARCHAR(128) NULL');
PREPARE grok_stmt FROM @grok_ddl; EXECUTE grok_stmt; DEALLOCATE PREPARE grok_stmt;
SET @grok_ddl = IF(EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='hosts' AND column_name='grok_model_override'), 'SELECT 1', 'ALTER TABLE hosts ADD COLUMN grok_model_override VARCHAR(128) NULL');
PREPARE grok_stmt FROM @grok_ddl; EXECUTE grok_stmt; DEALLOCATE PREPARE grok_stmt;
SET @grok_ddl = IF(EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='hosts' AND column_name='grok_reasoning_effort_override'), 'SELECT 1', 'ALTER TABLE hosts ADD COLUMN grok_reasoning_effort_override VARCHAR(32) NULL');
PREPARE grok_stmt FROM @grok_ddl; EXECUTE grok_stmt; DEALLOCATE PREPARE grok_stmt;
SET @grok_ddl = IF(EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='hosts' AND column_name='grok_last_refresh'), 'SELECT 1', 'ALTER TABLE hosts ADD COLUMN grok_last_refresh VARCHAR(100) NULL');
PREPARE grok_stmt FROM @grok_ddl; EXECUTE grok_stmt; DEALLOCATE PREPARE grok_stmt;

CREATE TABLE IF NOT EXISTS grok_auth_refresh_state (
 account_id BIGINT UNSIGNED NOT NULL PRIMARY KEY,
 state VARCHAR(24) NOT NULL DEFAULT 'idle', attempt_id VARCHAR(64) NULL,
 base_payload_id BIGINT UNSIGNED NULL, base_generation BIGINT UNSIGNED NULL,
 pending_payload_id BIGINT UNSIGNED NULL, response_enc LONGTEXT NULL,
 next_attempt_at VARCHAR(100) NULL, error_code VARCHAR(100) NULL,
 started_at VARCHAR(100) NULL, updated_at VARCHAR(100) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
