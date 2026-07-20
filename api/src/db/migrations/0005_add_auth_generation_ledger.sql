DROP PROCEDURE IF EXISTS add_auth_generation_column;
DELIMITER //
CREATE PROCEDURE add_auth_generation_column(IN p_column_name VARCHAR(191), IN ddl TEXT)
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = DATABASE() AND table_name = 'auth_payloads' AND column_name = p_column_name
  ) THEN
    SET @auth_generation_ddl = ddl;
    PREPARE auth_generation_stmt FROM @auth_generation_ddl;
    EXECUTE auth_generation_stmt;
    DEALLOCATE PREPARE auth_generation_stmt;
  END IF;
END//
DELIMITER ;

CALL add_auth_generation_column('generation', 'ALTER TABLE auth_payloads ADD COLUMN generation BIGINT UNSIGNED NULL');
CALL add_auth_generation_column('source_kind', 'ALTER TABLE auth_payloads ADD COLUMN source_kind VARCHAR(32) NOT NULL DEFAULT ''legacy''');
CALL add_auth_generation_column('parent_payload_id', 'ALTER TABLE auth_payloads ADD COLUMN parent_payload_id BIGINT UNSIGNED NULL');
CALL add_auth_generation_column('credential_kind', 'ALTER TABLE auth_payloads ADD COLUMN credential_kind VARCHAR(32) NULL');
CALL add_auth_generation_column('fingerprint_kid', 'ALTER TABLE auth_payloads ADD COLUMN fingerprint_kid VARCHAR(191) NULL');
CALL add_auth_generation_column('access_fingerprint', 'ALTER TABLE auth_payloads ADD COLUMN access_fingerprint CHAR(64) NULL');
CALL add_auth_generation_column('refresh_fingerprint', 'ALTER TABLE auth_payloads ADD COLUMN refresh_fingerprint CHAR(64) NULL');
CALL add_auth_generation_column('pair_fingerprint', 'ALTER TABLE auth_payloads ADD COLUMN pair_fingerprint CHAR(64) NULL');
CALL add_auth_generation_column('credential_issued_at', 'ALTER TABLE auth_payloads ADD COLUMN credential_issued_at VARCHAR(100) NULL');
CALL add_auth_generation_column('access_expires_at', 'ALTER TABLE auth_payloads ADD COLUMN access_expires_at VARCHAR(100) NULL');
CALL add_auth_generation_column('refresh_expires_at', 'ALTER TABLE auth_payloads ADD COLUMN refresh_expires_at VARCHAR(100) NULL');
CALL add_auth_generation_column('superseded_at', 'ALTER TABLE auth_payloads ADD COLUMN superseded_at VARCHAR(100) NULL');
CALL add_auth_generation_column('purge_after', 'ALTER TABLE auth_payloads ADD COLUMN purge_after VARCHAR(100) NULL');
DROP PROCEDURE add_auth_generation_column;

DROP PROCEDURE IF EXISTS add_auth_generation_index;
DELIMITER //
CREATE PROCEDURE add_auth_generation_index(IN p_index_name VARCHAR(191), IN ddl TEXT)
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.statistics
    WHERE table_schema = DATABASE() AND table_name = 'auth_payloads' AND index_name = p_index_name
  ) THEN
    SET @auth_generation_ddl = ddl;
    PREPARE auth_generation_stmt FROM @auth_generation_ddl;
    EXECUTE auth_generation_stmt;
    DEALLOCATE PREPARE auth_generation_stmt;
  END IF;
END//
DELIMITER ;

CALL add_auth_generation_index(
  'uq_auth_payloads_engine_generation',
  'CREATE UNIQUE INDEX uq_auth_payloads_engine_generation ON auth_payloads (engine, generation)'
);
CALL add_auth_generation_index(
  'idx_auth_payloads_pair_fingerprint',
  'CREATE INDEX idx_auth_payloads_pair_fingerprint ON auth_payloads (engine, pair_fingerprint)'
);
CALL add_auth_generation_index(
  'idx_auth_payloads_purge_after',
  'CREATE INDEX idx_auth_payloads_purge_after ON auth_payloads (purge_after)'
);
DROP PROCEDURE add_auth_generation_index;

CREATE TABLE IF NOT EXISTS auth_canonical_heads (
  engine VARCHAR(16) NOT NULL,
  payload_id BIGINT UNSIGNED NOT NULL,
  generation BIGINT UNSIGNED NOT NULL,
  updated_at VARCHAR(100) NOT NULL,
  PRIMARY KEY (engine),
  UNIQUE KEY uq_auth_canonical_heads_payload (payload_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
