-- External skill provenance and auxiliary bundle files.
--
-- Source-owned skills remain ordinary `skills` rows so the existing MCP and
-- Claude bootstrap delivery paths see them without a parallel registry. The
-- nullable provenance columns distinguish those read-only rows from locally
-- authored skills. `bundle_sha256` fingerprints the complete manifest + files
-- bundle, while `skills.sha256` remains the manifest-only digest.

DROP PROCEDURE IF EXISTS add_skill_provenance_column;
DELIMITER //
CREATE PROCEDURE add_skill_provenance_column(IN p_column_name VARCHAR(191), IN ddl TEXT)
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = DATABASE() AND table_name = 'skills' AND column_name = p_column_name
  ) THEN
    SET @skill_provenance_ddl = ddl;
    PREPARE skill_provenance_stmt FROM @skill_provenance_ddl;
    EXECUTE skill_provenance_stmt;
    DEALLOCATE PREPARE skill_provenance_stmt;
  END IF;
END//
DELIMITER ;

CALL add_skill_provenance_column('source_type', 'ALTER TABLE skills ADD COLUMN source_type VARCHAR(64) NULL');
CALL add_skill_provenance_column('source_repository', 'ALTER TABLE skills ADD COLUMN source_repository VARCHAR(512) NULL');
CALL add_skill_provenance_column('source_path', 'ALTER TABLE skills ADD COLUMN source_path VARCHAR(512) NULL');
CALL add_skill_provenance_column('source_revision', 'ALTER TABLE skills ADD COLUMN source_revision CHAR(40) NULL');
CALL add_skill_provenance_column('source_license', 'ALTER TABLE skills ADD COLUMN source_license VARCHAR(64) NULL');
CALL add_skill_provenance_column('bundle_sha256', 'ALTER TABLE skills ADD COLUMN bundle_sha256 CHAR(64) NULL');
DROP PROCEDURE add_skill_provenance_column;

CREATE TABLE IF NOT EXISTS skill_files (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    skill_id BIGINT UNSIGNED NOT NULL,
    path VARCHAR(512) NOT NULL,
    sha256 CHAR(64) NOT NULL,
    content LONGTEXT NOT NULL,
    created_at VARCHAR(100) NOT NULL,
    updated_at VARCHAR(100) NOT NULL,
    PRIMARY KEY (id),
    UNIQUE KEY uq_skill_files_skill_path (skill_id, path),
    INDEX idx_skill_files_skill (skill_id),
    CONSTRAINT fk_skill_files_skill FOREIGN KEY (skill_id) REFERENCES skills(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- `schema.ts`/Drizzle cannot express foreign keys. A test or development DB
-- created from the schema baseline therefore already has `skill_files` when
-- this migration runs, but not the cascade needed to avoid orphaned files.
DELETE f FROM skill_files f LEFT JOIN skills s ON s.id = f.skill_id WHERE s.id IS NULL;

SET @needs_skill_files_fk := (
  SELECT COUNT(*) = 0
    FROM information_schema.TABLE_CONSTRAINTS
   WHERE TABLE_SCHEMA = DATABASE()
     AND TABLE_NAME = 'skill_files'
     AND CONSTRAINT_NAME = 'fk_skill_files_skill'
     AND CONSTRAINT_TYPE = 'FOREIGN KEY'
);
SET @ddl := IF(
  @needs_skill_files_fk,
  'ALTER TABLE skill_files ADD CONSTRAINT fk_skill_files_skill FOREIGN KEY (skill_id) REFERENCES skills(id) ON DELETE CASCADE',
  'DO 0'
);
PREPARE add_skill_files_fk FROM @ddl;
EXECUTE add_skill_files_fk;
DEALLOCATE PREPARE add_skill_files_fk;

-- Durable singleton/lock row for the managed source. Runtime mutations take a
-- SELECT ... FOR UPDATE lock on this primary key, so API processes serialize
-- enable/disable/refresh and always re-read the latest committed state.
INSERT IGNORE INTO versions (name, version, updated_at) VALUES (
  'skill_source_mattpocock_state',
  '{"source":"github:mattpocock/skills","repository":"https://github.com/mattpocock/skills","ref":"main","enabled":false,"auto_update":true,"status":"disabled","revision":null,"upstream_version":null,"skill_count":0,"file_count":0,"last_checked_at":null,"last_synced_at":null,"last_error":null}',
  '1970-01-01T00:00:00.000Z'
);
