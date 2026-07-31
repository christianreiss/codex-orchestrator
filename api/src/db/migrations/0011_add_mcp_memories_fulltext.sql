-- Restore the FULLTEXT index behind `memory_search`.
--
-- `mcp_memories.idx_memories_search` was declared inline in the PHP migration
-- deleted in d06f88b3, so it exists only in databases descended from that
-- lineage. schema.ts records the gap in a comment, and `drizzle-kit push` cannot
-- express FULLTEXT, so any freshly provisioned database has the table without the
-- index. Its two sibling tables both ship an information_schema-guarded backstop
-- (0003 for coord_project_memories, 0006 for shared_memories); this one never
-- did, which is why it is the only memory search that could hard-fail.
--
-- Same guard idiom as 0003/0006: MySQL has no `ADD INDEX IF NOT EXISTS`, and
-- re-adding an existing FULLTEXT index is an error rather than a no-op, so the
-- statement is prepared conditionally. On a database that already has the index
-- this whole file is a no-op.
SET @needs_memories_ft := (
  SELECT COUNT(*) = 0
    FROM information_schema.STATISTICS
   WHERE TABLE_SCHEMA = DATABASE()
     AND TABLE_NAME = 'mcp_memories'
     AND INDEX_NAME = 'idx_memories_search'
);
SET @ddl := IF(
  @needs_memories_ft,
  'ALTER TABLE mcp_memories ADD FULLTEXT INDEX idx_memories_search (content, tags_text)',
  'DO 0'
);
PREPARE add_memories_ft FROM @ddl;
EXECUTE add_memories_ft;
DEALLOCATE PREPARE add_memories_ft;
