CREATE TABLE IF NOT EXISTS quota_emulation_states (
  account_id BIGINT UNSIGNED NOT NULL PRIMARY KEY,
  engine VARCHAR(16) NOT NULL,
  period_reset_at VARCHAR(100) NOT NULL,
  observed_at VARCHAR(100) NOT NULL,
  last_used_percent DOUBLE NOT NULL,
  started_at VARCHAR(100) NULL,
  resets_at VARCHAR(100) NULL,
  window_hours INT NOT NULL,
  consumed_percent DOUBLE NOT NULL DEFAULT 0,
  valid TINYINT NOT NULL DEFAULT 1
);

SET @has_quota_emulation_wait = (SELECT COUNT(*) FROM information_schema.columns
 WHERE table_schema = DATABASE() AND table_name = 'agent_bus_messages' AND column_name = 'quota_emulation_wait');
SET @quota_emulation_wait_ddl = IF(@has_quota_emulation_wait = 0,
 'ALTER TABLE agent_bus_messages ADD COLUMN quota_emulation_wait JSON NULL', 'SELECT 1');
PREPARE quota_emulation_wait_stmt FROM @quota_emulation_wait_ddl;
EXECUTE quota_emulation_wait_stmt;
DEALLOCATE PREPARE quota_emulation_wait_stmt;
