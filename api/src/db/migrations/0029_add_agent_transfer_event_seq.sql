-- Give the transfer audit trail a monotonic order.
--
-- `agent_transfer_events` ordered by `created_at`, which `nowIso()` writes at
-- second precision. 0028 accepted that, on the reasoning that two events one
-- second apart tell the same story either way round. The first real trail
-- disproved it: a chunked upload rendered as
--
--   appended  1000 bytes
--   sealed    1000 bytes at offset 2000     <- before the chunk it follows
--   appended  1000 bytes at offset 1000
--
-- which does not describe anything that happened. A reader cannot tell a
-- display artefact from an out-of-order write, and the whole value of this
-- table is that somebody believes what it says.
--
-- `seq` is a plain AUTO_INCREMENT, so MySQL orders the rows and nothing in the
-- service has to allocate. It is a UNIQUE KEY rather than the primary key: the
-- CHAR(36) id stays the identity, matching every other table added since 0025,
-- and MySQL only requires an auto-increment column to be *a* key.
--
-- Existing rows are backfilled by the ALTER itself. Their relative order is
-- whatever MySQL chooses, which is no worse than the created_at order they had.
--
-- Idempotent via an information_schema guard behind PREPARE/EXECUTE: MySQL has
-- no `ADD COLUMN IF NOT EXISTS`, and the runner re-applies every shipped file
-- against an already-migrated schema.

SET @col_exists := (
    SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'agent_transfer_events'
      AND COLUMN_NAME = 'seq'
);
SET @ddl := IF(
    @col_exists = 0,
    'ALTER TABLE agent_transfer_events
        ADD COLUMN seq BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        ADD UNIQUE KEY uq_agent_transfer_events_seq (seq)',
    'SELECT 1'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
