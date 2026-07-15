CREATE TABLE IF NOT EXISTS coord_project_memories (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    project_id BIGINT UNSIGNED NOT NULL,
    memory_key VARCHAR(128) NOT NULL,
    content LONGTEXT NOT NULL,
    metadata JSON NULL,
    tags JSON NULL,
    tags_text TEXT NULL,
    source_host_id BIGINT UNSIGNED NULL,
    created_at VARCHAR(100) NOT NULL,
    updated_at VARCHAR(100) NOT NULL,
    UNIQUE KEY uniq_coord_project_memory_key (project_id, memory_key),
    INDEX idx_coord_project_memories_project (project_id),
    INDEX idx_coord_project_memories_updated_at (updated_at),
    FULLTEXT INDEX idx_coord_project_memories_search (content, tags_text),
    CONSTRAINT fk_coord_project_memories_project FOREIGN KEY (project_id) REFERENCES coord_projects(id) ON DELETE CASCADE,
    CONSTRAINT fk_coord_project_memories_host FOREIGN KEY (source_host_id) REFERENCES hosts(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Backstop for a table that already exists without the full-text index.
-- `CREATE TABLE IF NOT EXISTS` above is a no-op in that case, so the index would
-- be silently missing and `project_memory_search` would run permanently degraded.
-- That is not hypothetical: `drizzle-kit push` creates this table from
-- schema.ts, which cannot express FULLTEXT, so any DB built that way lands here.
-- MySQL has no `ADD INDEX IF NOT EXISTS`, hence the information_schema guard.
SET @needs_ft := (
  SELECT COUNT(*) = 0
    FROM information_schema.STATISTICS
   WHERE TABLE_SCHEMA = DATABASE()
     AND TABLE_NAME = 'coord_project_memories'
     AND INDEX_NAME = 'idx_coord_project_memories_search'
);
SET @ddl := IF(
  @needs_ft,
  'ALTER TABLE coord_project_memories ADD FULLTEXT INDEX idx_coord_project_memories_search (content, tags_text)',
  'DO 0'
);
PREPARE add_ft_index FROM @ddl;
EXECUTE add_ft_index;
DEALLOCATE PREPARE add_ft_index;
