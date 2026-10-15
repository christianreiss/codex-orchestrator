-- NULL keeps legacy keys on the endpoint default; assigned keys route independently.
SET @has_key_backend = (SELECT COUNT(*) FROM information_schema.columns
  WHERE table_schema = DATABASE() AND table_name = 'openai_api_keys' AND column_name = 'backend_engine');
SET @key_backend_ddl = IF(@has_key_backend = 0,
  'ALTER TABLE openai_api_keys ADD COLUMN backend_engine VARCHAR(16) NULL', 'SELECT 1');
PREPARE key_backend_stmt FROM @key_backend_ddl;
EXECUTE key_backend_stmt;
DEALLOCATE PREPARE key_backend_stmt;
