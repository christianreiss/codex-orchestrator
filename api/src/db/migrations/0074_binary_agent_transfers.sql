-- Binary uploads declare their complete size/hash before receiving bytes.
-- Reserve quota at creation, and retain size_bytes as the durable resume offset.
SET @has_transfer_size = (SELECT COUNT(*) FROM information_schema.columns
 WHERE table_schema = DATABASE() AND table_name = 'agent_transfers' AND column_name = 'expected_size_bytes');
SET @transfer_size_ddl = IF(@has_transfer_size = 0,
 'ALTER TABLE agent_transfers ADD COLUMN expected_size_bytes BIGINT UNSIGNED NULL', 'SELECT 1');
PREPARE transfer_size_stmt FROM @transfer_size_ddl;
EXECUTE transfer_size_stmt;
DEALLOCATE PREPARE transfer_size_stmt;
SET @has_transfer_hash = (SELECT COUNT(*) FROM information_schema.columns
 WHERE table_schema = DATABASE() AND table_name = 'agent_transfers' AND column_name = 'expected_sha256');
SET @transfer_hash_ddl = IF(@has_transfer_hash = 0,
 'ALTER TABLE agent_transfers ADD COLUMN expected_sha256 CHAR(64) NULL', 'SELECT 1');
PREPARE transfer_hash_stmt FROM @transfer_hash_ddl;
EXECUTE transfer_hash_stmt;
DEALLOCATE PREPARE transfer_hash_stmt;
-- A short row lock serializes quota reservations and commits across API workers.
-- No network I/O takes place under this lock.
INSERT IGNORE INTO versions (name, version, updated_at)
 VALUES ('agent_transfers_write_lock', '1', DATE_FORMAT(UTC_TIMESTAMP(), '%Y-%m-%dT%H:%i:%sZ'));
