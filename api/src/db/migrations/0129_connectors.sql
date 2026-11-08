-- OAuth credentials are hashes; payloads contain metadata and immutable consent only.
CREATE TABLE IF NOT EXISTS connector_records (
  id varchar(160) NOT NULL PRIMARY KEY,
  kind varchar(24) NOT NULL,
  body_json mediumtext NOT NULL,
  expires_at varchar(100) NULL,
  created_at varchar(100) NOT NULL,
  KEY idx_connector_records_kind (kind),
  KEY idx_connector_records_expiry (expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
-- Permanent provenance fence: removing OAuth metadata must never turn a queued
-- connector request into an ordinary unrestricted fleet request.
SET @connector_origin_exists = (SELECT COUNT(*) FROM information_schema.columns
 WHERE table_schema = DATABASE() AND table_name = 'agent_bus_messages' AND column_name = 'connector_grant_id');
SET @connector_origin_ddl = IF(@connector_origin_exists = 0,
 'ALTER TABLE agent_bus_messages ADD COLUMN connector_grant_id CHAR(36) NULL', 'SELECT 1');
PREPARE connector_origin_stmt FROM @connector_origin_ddl;
EXECUTE connector_origin_stmt;
DEALLOCATE PREPARE connector_origin_stmt;
