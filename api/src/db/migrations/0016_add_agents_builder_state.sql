-- Structured provenance for toggle-composed AGENTS.md versions. The rendered
-- body remains the immutable serving source of truth; this JSON only lets the
-- admin UI reopen the exact builder selection that produced it.
--
-- MySQL has no `ADD COLUMN IF NOT EXISTS`, so guard on information_schema like
-- every other additive migration here. Re-applying this file against an
-- already-migrated database must be a no-op: the runner's contract is that a
-- schema which is ahead of its ledger can be replayed, which is how a
-- hand-migrated host gets baselined.
SET @needs_builder_state := (
  SELECT COUNT(*) = 0
    FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE()
     AND TABLE_NAME = 'agents_documents'
     AND COLUMN_NAME = 'builder_state'
);
SET @ddl := IF(
  @needs_builder_state,
  'ALTER TABLE agents_documents ADD COLUMN builder_state JSON NULL AFTER body',
  'DO 0'
);
PREPARE add_builder_state FROM @ddl;
EXECUTE add_builder_state;
DEALLOCATE PREPARE add_builder_state;
