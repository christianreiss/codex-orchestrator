-- Working credentials are fleet-wide. Keep source_engine for provenance only.
-- Removing the obsolete scope preserves encrypted values, ownership and audit.
SET @ddl := IF((SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='secrets' AND INDEX_NAME='idx_secrets_engine') > 0,
  'ALTER TABLE secrets DROP INDEX idx_secrets_engine', 'SELECT 1');
PREPARE secrets_scope FROM @ddl;
EXECUTE secrets_scope;
DEALLOCATE PREPARE secrets_scope;

SET @ddl := IF((SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='secrets' AND COLUMN_NAME='engine') > 0,
  'ALTER TABLE secrets DROP COLUMN engine', 'SELECT 1');
PREPARE secrets_scope FROM @ddl;
EXECUTE secrets_scope;
DEALLOCATE PREPARE secrets_scope;
