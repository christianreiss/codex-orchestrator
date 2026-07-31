-- Make a shared-memory REPLACE recoverable.
--
-- The recoverability of this substrate was inverted. A soft delete keeps the body
-- on the row (only chunks are dropped), so it can be brought back; a replace
-- overwrites `content` in place and the revision ledger stores metadata only
-- ("Attribution, not rollback" -- 0006). So deletion was the safe operation and
-- UPDATE was the destructive one.
--
-- That was tolerable while nothing ever updated a record: across 9354 sessions,
-- shared_memory_delete was called zero times and no document was ever revised in
-- a later session. It stops being tolerable now, because the managed AGENTS.md
-- block explicitly tells agents to rewrite a slug when they find it contradicts
-- reality. Encouraging corrections without a way back would turn one confused
-- agent into permanent data loss.
--
-- Storing the PRIOR body (not the new one) means the newest revision row carries
-- what the document looked like before the write that created it, which is
-- exactly what a restore needs. Pruning is left to the application so this
-- migration stays a pure column add and can run online.
SET @needs_prev_content := (
  SELECT COUNT(*) = 0
    FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE()
     AND TABLE_NAME = 'shared_memory_revisions'
     AND COLUMN_NAME = 'prev_content'
);
SET @ddl := IF(
  @needs_prev_content,
  'ALTER TABLE shared_memory_revisions ADD COLUMN prev_content LONGTEXT NULL AFTER note',
  'DO 0'
);
PREPARE add_prev_content FROM @ddl;
EXECUTE add_prev_content;
DEALLOCATE PREPARE add_prev_content;
