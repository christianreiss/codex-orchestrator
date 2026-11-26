-- Real provider API keys (OpenAI, Anthropic, xAI, Moonshot) for the gateway
-- surfaces' upstream source. Server-side only: never leased to hosts, never
-- served through /auth or the MCP secrets store. The key lives only as a
-- secretbox envelope (key_enc) plus a SHA-256 for per-provider dedupe; the
-- admin API returns key_hint and never the value. sort_order is the failover
-- order inside one provider. Idempotent: CREATE TABLE IF NOT EXISTS.
CREATE TABLE IF NOT EXISTS provider_api_keys (
  id bigint unsigned NOT NULL AUTO_INCREMENT,
  provider varchar(16) NOT NULL,
  label varchar(255) NOT NULL,
  key_enc longtext NOT NULL,
  key_hash char(64) NOT NULL,
  key_hint varchar(32) NOT NULL,
  base_url varchar(512) NULL,
  sort_order int NOT NULL DEFAULT 0,
  state varchar(16) NOT NULL DEFAULT 'active',
  verification_state varchar(16) NOT NULL DEFAULT 'unverified',
  verification_checked_at varchar(100) NULL,
  verification_reason varchar(255) NULL,
  last_used_at varchar(100) NULL,
  last_error_at varchar(100) NULL,
  last_error_status int NULL,
  last_error_reason varchar(255) NULL,
  created_by_admin_user_id bigint unsigned NULL,
  created_at varchar(100) NOT NULL,
  updated_at varchar(100) NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_provider_api_keys_hash (provider, key_hash),
  KEY idx_provider_api_keys_order (provider, sort_order)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Per-gateway-key source override: NULL follows the surface default
-- (versions row api_surface_source_<surface>), 'emulated' or 'upstream' pins it.
SET @oak_source_exists=(SELECT COUNT(*) FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='openai_api_keys' AND column_name='source');
SET @oak_source_ddl=IF(@oak_source_exists=0,'ALTER TABLE openai_api_keys ADD COLUMN source VARCHAR(16) NULL','SELECT 1');
PREPARE oak_source_stmt FROM @oak_source_ddl;
EXECUTE oak_source_stmt;
DEALLOCATE PREPARE oak_source_stmt;
