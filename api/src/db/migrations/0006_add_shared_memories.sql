-- Fleet-wide shared memory substrate.
--
-- `mcp_memories` is keyed (host_id, memory_key) and `coord_project_memories` is
-- keyed (project_id, memory_key); neither can hold a document that every agent
-- on every host should be able to find without already knowing where to look.
-- These tables are that third substrate: one corpus, addressed by slug, no host
-- or project scoping, documents up to 1 MiB, retrieved by relevance over
-- chunks rather than by exact key.

CREATE TABLE IF NOT EXISTS shared_memories (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    slug VARCHAR(160) NOT NULL,
    title VARCHAR(255) NOT NULL,
    summary TEXT NULL,
    content LONGTEXT NOT NULL,
    content_sha256 CHAR(64) NOT NULL,
    content_length INT UNSIGNED NOT NULL DEFAULT 0,
    chunk_count INT UNSIGNED NOT NULL DEFAULT 0,
    revision INT UNSIGNED NOT NULL DEFAULT 1,
    metadata JSON NULL,
    tags JSON NULL,
    tags_text TEXT NULL,
    source_host_id BIGINT UNSIGNED NULL,
    source_engine VARCHAR(16) NULL,
    created_at VARCHAR(100) NOT NULL,
    updated_at VARCHAR(100) NOT NULL,
    deleted_at VARCHAR(100) NULL,
    UNIQUE KEY uniq_shared_memories_slug (slug),
    INDEX idx_shared_memories_updated_at (updated_at),
    INDEX idx_shared_memories_deleted_at (deleted_at),
    FULLTEXT INDEX idx_shared_memories_search (title, summary, tags_text),
    CONSTRAINT fk_shared_memories_host FOREIGN KEY (source_host_id) REFERENCES hosts(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Retrieval units. `revision` is denormalized from the parent so a rewrite can
-- insert the new chunks before deleting the superseded ones without a
-- transaction: every read joins on chunk.revision = memory.revision, so a crash
-- mid-rewrite can leave garbage rows but never a half-old/half-new document.
CREATE TABLE IF NOT EXISTS shared_memory_chunks (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    memory_id BIGINT UNSIGNED NOT NULL,
    revision INT UNSIGNED NOT NULL,
    ordinal INT UNSIGNED NOT NULL,
    heading VARCHAR(255) NULL,
    content TEXT NOT NULL,
    char_start INT UNSIGNED NOT NULL,
    char_end INT UNSIGNED NOT NULL,
    tags_text TEXT NULL,
    created_at VARCHAR(100) NOT NULL,
    UNIQUE KEY uniq_shared_memory_chunk (memory_id, revision, ordinal),
    INDEX idx_shared_memory_chunks_memory (memory_id, revision),
    FULLTEXT INDEX idx_shared_memory_chunks_search (content, heading, tags_text),
    CONSTRAINT fk_shared_memory_chunks_memory FOREIGN KEY (memory_id) REFERENCES shared_memories(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Metadata-only audit trail. Bodies are not copied: at 1 MiB a document the
-- history would dwarf the corpus. Attribution, not rollback.
CREATE TABLE IF NOT EXISTS shared_memory_revisions (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    memory_id BIGINT UNSIGNED NOT NULL,
    revision INT UNSIGNED NOT NULL,
    op VARCHAR(16) NOT NULL,
    content_sha256 CHAR(64) NOT NULL,
    content_length INT UNSIGNED NOT NULL DEFAULT 0,
    delta_length INT NOT NULL DEFAULT 0,
    source_host_id BIGINT UNSIGNED NULL,
    source_engine VARCHAR(16) NULL,
    note VARCHAR(255) NULL,
    created_at VARCHAR(100) NOT NULL,
    UNIQUE KEY uniq_shared_memory_revision (memory_id, revision),
    INDEX idx_shared_memory_revisions_memory (memory_id),
    CONSTRAINT fk_shared_memory_revisions_memory FOREIGN KEY (memory_id) REFERENCES shared_memories(id) ON DELETE CASCADE,
    CONSTRAINT fk_shared_memory_revisions_host FOREIGN KEY (source_host_id) REFERENCES hosts(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Backstop for tables that already exist without their full-text indexes.
-- `CREATE TABLE IF NOT EXISTS` above is a no-op in that case, so the indexes
-- would be silently missing and shared_memory_search would run permanently
-- degraded to a substring scan. That is not hypothetical: `drizzle-kit push`
-- creates these tables from schema.ts, which cannot express FULLTEXT, so any DB
-- built that way lands here. MySQL has no `ADD INDEX IF NOT EXISTS`, hence the
-- information_schema guard. Same pattern as
-- 0003_add_coord_project_memories.sql.
SET @needs_doc_ft := (
  SELECT COUNT(*) = 0
    FROM information_schema.STATISTICS
   WHERE TABLE_SCHEMA = DATABASE()
     AND TABLE_NAME = 'shared_memories'
     AND INDEX_NAME = 'idx_shared_memories_search'
);
SET @ddl := IF(
  @needs_doc_ft,
  'ALTER TABLE shared_memories ADD FULLTEXT INDEX idx_shared_memories_search (title, summary, tags_text)',
  'DO 0'
);
PREPARE add_doc_ft FROM @ddl;
EXECUTE add_doc_ft;
DEALLOCATE PREPARE add_doc_ft;

SET @needs_chunk_ft := (
  SELECT COUNT(*) = 0
    FROM information_schema.STATISTICS
   WHERE TABLE_SCHEMA = DATABASE()
     AND TABLE_NAME = 'shared_memory_chunks'
     AND INDEX_NAME = 'idx_shared_memory_chunks_search'
);
SET @ddl := IF(
  @needs_chunk_ft,
  'ALTER TABLE shared_memory_chunks ADD FULLTEXT INDEX idx_shared_memory_chunks_search (content, heading, tags_text)',
  'DO 0'
);
PREPARE add_chunk_ft FROM @ddl;
EXECUTE add_chunk_ft;
DEALLOCATE PREPARE add_chunk_ft;

-- Same story for the cascade FKs. schema.ts cannot express a foreign key
-- either, so a `drizzle-kit push`-built database has the child tables with no
-- CASCADE — deleting a document there would strand its chunks and revisions in
-- the FULLTEXT index forever. The orphan sweep before each ADD CONSTRAINT is a
-- no-op on a healthy database and is required on one that has already leaked
-- rows, since ADD CONSTRAINT fails outright when orphans exist.
DELETE c FROM shared_memory_chunks c LEFT JOIN shared_memories m ON m.id = c.memory_id WHERE m.id IS NULL;
DELETE r FROM shared_memory_revisions r LEFT JOIN shared_memories m ON m.id = r.memory_id WHERE m.id IS NULL;

SET @needs_chunk_fk := (
  SELECT COUNT(*) = 0
    FROM information_schema.TABLE_CONSTRAINTS
   WHERE TABLE_SCHEMA = DATABASE()
     AND TABLE_NAME = 'shared_memory_chunks'
     AND CONSTRAINT_NAME = 'fk_shared_memory_chunks_memory'
     AND CONSTRAINT_TYPE = 'FOREIGN KEY'
);
SET @ddl := IF(
  @needs_chunk_fk,
  'ALTER TABLE shared_memory_chunks ADD CONSTRAINT fk_shared_memory_chunks_memory FOREIGN KEY (memory_id) REFERENCES shared_memories(id) ON DELETE CASCADE',
  'DO 0'
);
PREPARE add_chunk_fk FROM @ddl;
EXECUTE add_chunk_fk;
DEALLOCATE PREPARE add_chunk_fk;

SET @needs_rev_fk := (
  SELECT COUNT(*) = 0
    FROM information_schema.TABLE_CONSTRAINTS
   WHERE TABLE_SCHEMA = DATABASE()
     AND TABLE_NAME = 'shared_memory_revisions'
     AND CONSTRAINT_NAME = 'fk_shared_memory_revisions_memory'
     AND CONSTRAINT_TYPE = 'FOREIGN KEY'
);
SET @ddl := IF(
  @needs_rev_fk,
  'ALTER TABLE shared_memory_revisions ADD CONSTRAINT fk_shared_memory_revisions_memory FOREIGN KEY (memory_id) REFERENCES shared_memories(id) ON DELETE CASCADE',
  'DO 0'
);
PREPARE add_rev_fk FROM @ddl;
EXECUTE add_rev_fk;
DEALLOCATE PREPARE add_rev_fk;
