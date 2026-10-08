-- Durable schedules and immutable execution snapshots; no foreign keys, like
-- the bus. Deleted schedules retain their history and never resume new work.
CREATE TABLE IF NOT EXISTS agent_schedules (
 id CHAR(36) NOT NULL PRIMARY KEY,
 name VARCHAR(120) NOT NULL,
 target_address_id CHAR(36) NOT NULL,
 prompt_enc LONGTEXT NOT NULL,
 kind VARCHAR(16) NOT NULL,
 at_time VARCHAR(100) NULL,
 cron_expression VARCHAR(120) NULL,
 interval_minutes INT UNSIGNED NULL,
 timezone VARCHAR(100) NOT NULL,
 enabled TINYINT UNSIGNED NOT NULL DEFAULT 1,
 persistent TINYINT UNSIGNED NOT NULL DEFAULT 0,
 progress_timeout_seconds INT UNSIGNED NULL,
 next_due_at VARCHAR(100) NULL,
 version INT UNSIGNED NOT NULL DEFAULT 1,
 created_by VARCHAR(191) NOT NULL,
 updated_by VARCHAR(191) NOT NULL,
 deleted_at VARCHAR(100) NULL,
 created_at VARCHAR(100) NOT NULL,
 updated_at VARCHAR(100) NOT NULL,
 KEY idx_agent_schedules_due (enabled, next_due_at),
 KEY idx_agent_schedules_target (target_address_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS agent_schedule_runs (
 id CHAR(36) NOT NULL PRIMARY KEY,
 schedule_id CHAR(36) NOT NULL,
 target_address_id CHAR(36) NOT NULL,
 prompt_enc LONGTEXT NOT NULL,
 persistent TINYINT UNSIGNED NOT NULL DEFAULT 0,
 progress_timeout_seconds INT UNSIGNED NULL,
 retry_seconds INT UNSIGNED NOT NULL,
 due_at VARCHAR(100) NOT NULL,
 status VARCHAR(32) NOT NULL DEFAULT 'waiting',
 message_id CHAR(36) NULL,
 recovery_count INT UNSIGNED NOT NULL DEFAULT 0,
 next_attempt_at VARCHAR(100) NOT NULL,
 last_error VARCHAR(100) NULL,
 created_at VARCHAR(100) NOT NULL,
 updated_at VARCHAR(100) NOT NULL,
 UNIQUE KEY uq_agent_schedule_run_due (schedule_id, due_at),
 UNIQUE KEY uq_agent_schedule_run_message (message_id),
 KEY idx_agent_schedule_runs_status (status, next_attempt_at),
 KEY idx_agent_schedule_runs_schedule (schedule_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
-- UUID joins must use the same collation as existing bus tables.
SET @bus_collation := (SELECT TABLE_COLLATION FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'agent_bus_addresses');
SET @ddl := CONCAT('ALTER TABLE agent_schedules CONVERT TO CHARACTER SET utf8mb4 COLLATE ', @bus_collation);
PREPARE align_schedule FROM @ddl; EXECUTE align_schedule; DEALLOCATE PREPARE align_schedule;
SET @ddl := CONCAT('ALTER TABLE agent_schedule_runs CONVERT TO CHARACTER SET utf8mb4 COLLATE ', @bus_collation);
PREPARE align_runs FROM @ddl; EXECUTE align_runs; DEALLOCATE PREPARE align_runs;
