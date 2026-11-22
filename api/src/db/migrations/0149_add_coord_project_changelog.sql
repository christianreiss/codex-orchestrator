-- Per-project changelog: agent-written "what changed and why" entries,
-- optionally tied to a board card. Every mutation also writes a
-- coord_project_events row carrying the full entry state, so the event feed is
-- the edit history; this table holds only the current version.
CREATE TABLE IF NOT EXISTS coord_project_changelog (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    project_id BIGINT UNSIGNED NOT NULL,
    card_id VARCHAR(64) NULL,
    kind VARCHAR(32) NOT NULL DEFAULT 'change',
    title VARCHAR(300) NOT NULL,
    body MEDIUMTEXT NOT NULL,
    tags JSON NULL,
    tags_text TEXT NULL,
    source_host_id BIGINT UNSIGNED NULL,
    created_at VARCHAR(100) NOT NULL,
    updated_at VARCHAR(100) NOT NULL,
    INDEX idx_coord_project_changelog_project (project_id, created_at),
    INDEX idx_coord_project_changelog_card (card_id),
    FULLTEXT INDEX idx_coord_project_changelog_search (title, body, tags_text),
    CONSTRAINT fk_coord_project_changelog_project FOREIGN KEY (project_id) REFERENCES coord_projects(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Backstop for a table created without the full-text index (drizzle-kit push
-- cannot express FULLTEXT); mirrors migration 0003.
SET @needs_ft := (
  SELECT COUNT(*) = 0
    FROM information_schema.STATISTICS
   WHERE TABLE_SCHEMA = DATABASE()
     AND TABLE_NAME = 'coord_project_changelog'
     AND INDEX_NAME = 'idx_coord_project_changelog_search'
);
SET @ddl := IF(
  @needs_ft,
  'ALTER TABLE coord_project_changelog ADD FULLTEXT INDEX idx_coord_project_changelog_search (title, body, tags_text)',
  'DO 0'
);
PREPARE add_ft_index FROM @ddl;
EXECUTE add_ft_index;
DEALLOCATE PREPARE add_ft_index;
