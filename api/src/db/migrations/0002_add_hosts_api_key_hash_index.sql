-- MySQL has no `ADD INDEX IF NOT EXISTS`, and the migration runner may be asked
-- to re-apply a file (`migrate.js --reapply 0002`) or may meet a database that
-- already carries the index, so guard the ALTER instead of letting it die with
-- ER_DUP_KEYNAME. Same information_schema pattern as 0003/0006.
SET @needs_api_key_hash_index := (
  SELECT COUNT(*) = 0
    FROM information_schema.STATISTICS
   WHERE TABLE_SCHEMA = DATABASE()
     AND TABLE_NAME = 'hosts'
     AND INDEX_NAME = 'api_key_hash'
);
SET @ddl := IF(
  @needs_api_key_hash_index,
  'ALTER TABLE hosts ADD UNIQUE INDEX api_key_hash (api_key_hash)',
  'DO 0'
);
PREPARE add_api_key_hash_index FROM @ddl;
EXECUTE add_api_key_hash_index;
DEALLOCATE PREPARE add_api_key_hash_index;
