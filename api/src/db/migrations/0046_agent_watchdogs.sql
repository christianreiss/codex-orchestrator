-- One durable watchdog per native-session task. Recovery reuses the schedule bus.
CREATE TABLE IF NOT EXISTS agent_watchdogs (
 id CHAR(36) NOT NULL PRIMARY KEY,
 target_address_id CHAR(36) NOT NULL,
 native_session_id VARCHAR(255) NOT NULL,
 session_id CHAR(36) NOT NULL,
 task_key VARCHAR(255) NOT NULL,
 message_id CHAR(36) NULL,
 schedule_id CHAR(36) NOT NULL,
 continuation_sha CHAR(64) NOT NULL,
 status VARCHAR(32) NOT NULL DEFAULT 'watching',
 deadline_at VARCHAR(100) NOT NULL,
 progress_timeout_seconds INT UNSIGNED NOT NULL,
 last_progress_at VARCHAR(100) NOT NULL,
 last_error VARCHAR(100) NULL,
 version INT UNSIGNED NOT NULL DEFAULT 1,
 created_by VARCHAR(191) NOT NULL,
 created_at VARCHAR(100) NOT NULL,
 updated_at VARCHAR(100) NOT NULL,
 UNIQUE KEY uq_agent_watchdog_task (target_address_id, native_session_id, task_key),
 UNIQUE KEY uq_agent_watchdog_schedule (schedule_id),
 KEY idx_agent_watchdog_status (status, deadline_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
SET @bus_collation := (SELECT TABLE_COLLATION FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'agent_bus_addresses');
SET @ddl := CONCAT('ALTER TABLE agent_watchdogs CONVERT TO CHARACTER SET utf8mb4 COLLATE ', @bus_collation);
PREPARE align_watchdogs FROM @ddl; EXECUTE align_watchdogs; DEALLOCATE PREPARE align_watchdogs;
