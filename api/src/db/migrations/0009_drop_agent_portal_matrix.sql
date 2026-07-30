-- Retire the agent portal's Matrix push channel.
--
-- The portal is now purely pull-based: each user holds one permanent link that
-- an owner/admin reads back from Settings → Agent Portal and bookmarks. Nothing
-- is pushed anywhere, so the outbox and the per-user Matrix destination are both
-- dead weight.
--
-- `agent_matrix_outbox` is dropped rather than left idle on purpose: every queued
-- row's encrypted envelope holds a rendered magic link, i.e. live bearer material
-- for a token that is still valid. A queue no writer feeds is not a queue worth
-- keeping that in.

DROP TABLE IF EXISTS agent_matrix_outbox;

-- MySQL has no `DROP COLUMN IF EXISTS`, so guard on information_schema. Re-applying
-- this file against an already-migrated database must be a no-op.
DROP PROCEDURE IF EXISTS drop_agent_portal_column;
DELIMITER //
CREATE PROCEDURE drop_agent_portal_column(IN p_table_name VARCHAR(191), IN p_column_name VARCHAR(191))
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = DATABASE() AND table_name = p_table_name AND column_name = p_column_name
  ) THEN
    SET @drop_agent_portal_ddl = CONCAT('ALTER TABLE `', p_table_name, '` DROP COLUMN `', p_column_name, '`');
    PREPARE drop_agent_portal_stmt FROM @drop_agent_portal_ddl;
    EXECUTE drop_agent_portal_stmt;
    DEALLOCATE PREPARE drop_agent_portal_stmt;
  END IF;
END//
DELIMITER ;

CALL drop_agent_portal_column('agent_portal_users', 'matrix_room');
DROP PROCEDURE drop_agent_portal_column;
