-- Cached Grok settings plan, with freshness independent of quota polling.
SET @ddl := IF((SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'grok_usage_snapshots' AND COLUMN_NAME = 'plan_name') = 0,
  'ALTER TABLE grok_usage_snapshots ADD COLUMN plan_name VARCHAR(128) NULL', 'DO 0');
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
SET @ddl := IF((SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'grok_usage_snapshots' AND COLUMN_NAME = 'plan_fetched_at') = 0,
  'ALTER TABLE grok_usage_snapshots ADD COLUMN plan_fetched_at VARCHAR(100) NULL', 'DO 0');
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
SET @ddl := IF((SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'grok_usage_snapshots' AND COLUMN_NAME = 'plan_error_code') = 0,
  'ALTER TABLE grok_usage_snapshots ADD COLUMN plan_error_code VARCHAR(48) NULL', 'DO 0');
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
