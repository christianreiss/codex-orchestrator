-- Let a project file hold bytes, not just text.
--
-- `coord_project_files.content` is LONGTEXT and every path treats it as a UTF-8
-- string. There has never been a binary option, and the workaround was already
-- in production data before this column existed: the `dns_switch_work` project
-- carries `context/evidence-20260921.tar.gz.base64`, an agent's hand-encoded
-- tarball stored as `text/plain`. That works, but nothing knows it happened —
-- `content_sha256` is the digest of the base64 text rather than of the archive,
-- and `size_bytes` reports the 172 KB envelope rather than the 129 KB file. A
-- reader cannot verify the artifact against a sha taken anywhere else.
--
-- `content_encoding` records what `content` actually holds. 'utf8' is the
-- existing behaviour and the default, so every current row is already correct
-- and needs no backfill; 'base64' means the body is an encoding of bytes, and
-- the service computes the digest and the size over the DECODED bytes.
--
-- The column, not the mime type, is what decides this. A mime type is a caller's
-- claim about what the bytes mean and is NULL on most rows; the encoding is a
-- fact about the column, and conflating the two is how you end up sha256-ing
-- base64 text because somebody wrote `application/pdf`.
--
-- Idempotent via an information_schema guard behind PREPARE/EXECUTE: MySQL has
-- no `ADD COLUMN IF NOT EXISTS`, and the runner re-applies every shipped file
-- against an already-migrated schema.

SET @col_exists := (
    SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'coord_project_files'
      AND COLUMN_NAME = 'content_encoding'
);
SET @ddl := IF(
    @col_exists = 0,
    'ALTER TABLE coord_project_files
        ADD COLUMN content_encoding VARCHAR(16) NOT NULL DEFAULT ''utf8'' AFTER content',
    'SELECT 1'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
