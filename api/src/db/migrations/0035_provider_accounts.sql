-- Independent provider account heads; the old per-engine head is a stable
-- compatibility pointer for wrappers predating account-aware synchronization.
CREATE TABLE IF NOT EXISTS provider_accounts (
 id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
 engine VARCHAR(16) NOT NULL, label VARCHAR(191) NOT NULL,
 identity_key VARCHAR(191) NULL, state VARCHAR(16) NOT NULL DEFAULT 'enabled',
 payload_id BIGINT UNSIGNED NULL, generation BIGINT UNSIGNED NULL,
 last_selected_at VARCHAR(100) NULL, created_at VARCHAR(100) NOT NULL,
 updated_at VARCHAR(100) NOT NULL,
 UNIQUE KEY uq_provider_account_identity (engine, identity_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE IF NOT EXISTS provider_account_sessions (
 id VARCHAR(64) NOT NULL PRIMARY KEY, host_id BIGINT UNSIGNED NOT NULL,
 engine VARCHAR(16) NOT NULL, scope_id VARCHAR(64) NOT NULL,
 account_id BIGINT UNSIGNED NOT NULL, expires_at VARCHAR(100) NOT NULL,
 created_at VARCHAR(100) NOT NULL,
 INDEX idx_account_session_active (account_id, expires_at),
 INDEX idx_account_session_scope (host_id, engine, scope_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

SET @account_ddl = IF(EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='auth_payloads' AND column_name='account_id'), 'SELECT 1', 'ALTER TABLE auth_payloads ADD COLUMN account_id BIGINT UNSIGNED NULL');
PREPARE account_stmt FROM @account_ddl; EXECUTE account_stmt; DEALLOCATE PREPARE account_stmt;

SET @account_ddl = IF(EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='chatgpt_usage_snapshots' AND column_name='account_id'), 'SELECT 1', 'ALTER TABLE chatgpt_usage_snapshots ADD COLUMN account_id BIGINT UNSIGNED NULL');
PREPARE account_stmt FROM @account_ddl; EXECUTE account_stmt; DEALLOCATE PREPARE account_stmt;

SET @account_ddl = IF(NOT EXISTS(SELECT 1 FROM information_schema.tables WHERE table_schema=DATABASE() AND table_name='claude_usage_snapshots') OR EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='claude_usage_snapshots' AND column_name='account_id'), 'SELECT 1', 'ALTER TABLE claude_usage_snapshots ADD COLUMN account_id BIGINT UNSIGNED NULL');
PREPARE account_stmt FROM @account_ddl; EXECUTE account_stmt; DEALLOCATE PREPARE account_stmt;

SET @account_ddl = IF(EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='auth_seed_tokens' AND column_name='account_id'), 'SELECT 1', 'ALTER TABLE auth_seed_tokens ADD COLUMN account_id BIGINT UNSIGNED NULL');
PREPARE account_stmt FROM @account_ddl; EXECUTE account_stmt; DEALLOCATE PREPARE account_stmt;

-- Attribute only the current head, not every historical login or usage reading.
INSERT INTO provider_accounts (engine,label,payload_id,generation,created_at,updated_at)
 SELECT h.engine, CONCAT(IF(h.engine='claude','Claude','ChatGPT'),' 1'),h.payload_id,h.generation,h.updated_at,h.updated_at
 FROM auth_canonical_heads h
 WHERE NOT EXISTS (SELECT 1 FROM provider_accounts a WHERE a.engine=h.engine);
UPDATE auth_payloads p JOIN provider_accounts a ON a.payload_id=p.id
 SET p.account_id=a.id WHERE p.account_id IS NULL;

SET @account_ddl = IF((SELECT COUNT(*) FROM information_schema.statistics WHERE table_schema=DATABASE() AND table_name='auth_payloads' AND index_name='uq_auth_payloads_engine_generation' AND column_name='account_id') > 0, 'SELECT 1', 'ALTER TABLE auth_payloads DROP INDEX uq_auth_payloads_engine_generation, ADD UNIQUE KEY uq_auth_payloads_engine_generation (engine,account_id,generation)');
PREPARE account_stmt FROM @account_ddl; EXECUTE account_stmt; DEALLOCATE PREPARE account_stmt;
