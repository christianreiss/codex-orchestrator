-- Operator messages can now be authored by an admin session, not only a portal
-- magic-link user.
--
-- `agent_messages.portal_user_id` was NOT NULL and pointed at
-- `agent_portal_users`, which is a different identity table from `admin_users`.
-- That one column was the whole reason the console could look at a running agent
-- but never speak to it: an operator already signed in to /admin had to open
-- /go and authenticate a second time to send a single instruction.
--
-- The column carries three jobs, and all three had to survive the widening:
--
--  1. Authorship. `insertPortalMessageEvent` writes the author's display name
--     into the agent's own timeline, so an agent sees who asked.
--  2. Idempotency identity. `assertMessageIdempotency` compares it, so a retried
--     `client_message_id` from a DIFFERENT author is a conflict rather than a
--     silent no-op. Comparing only the numeric id across two identity tables
--     would collide admin #3 with portal user #3, so the actor KIND is part of
--     the comparison in the service.
--  3. Delivery-time revocation. `claimMessage` re-reads the author and cancels
--     the message if that account is gone or disabled -- revoking someone kills
--     their queued instructions at the moment of delivery, not merely on the
--     next sweep. The admin branch checks `admin_users.active` for the same
--     reason.
--
-- Exactly one of the two columns is set. There is deliberately no CHECK
-- constraint: `baseline/schema.sql` is drizzle-kit output and cannot express
-- one, so adding it here would leave migrated databases holding a constraint
-- that freshly installed ones do not -- and schema that differs by install route
-- is worse than an invariant held in the single service through which every
-- insert already passes.

-- Re-appliable, like every migration here: the runner is expected to survive
-- being pointed at an already-migrated schema, and MySQL has no
-- `ADD COLUMN IF NOT EXISTS` or `CREATE INDEX IF NOT EXISTS`. The guard is the
-- same information_schema procedure 0005 uses for exactly this.
--
-- `MODIFY COLUMN` needs no guard: it states the definition it wants rather than
-- a change to make, so a second run is a no-op on its own.
ALTER TABLE `agent_messages` MODIFY COLUMN `portal_user_id` bigint unsigned NULL;

DROP PROCEDURE IF EXISTS add_agent_messages_column;
DELIMITER //
CREATE PROCEDURE add_agent_messages_column(IN p_column_name VARCHAR(191), IN ddl TEXT)
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = DATABASE() AND table_name = 'agent_messages' AND column_name = p_column_name
  ) THEN
    SET @agent_messages_ddl = ddl;
    PREPARE agent_messages_stmt FROM @agent_messages_ddl;
    EXECUTE agent_messages_stmt;
    DEALLOCATE PREPARE agent_messages_stmt;
  END IF;
END//
DELIMITER ;

CALL add_agent_messages_column(
  'admin_user_id',
  'ALTER TABLE agent_messages ADD COLUMN admin_user_id BIGINT UNSIGNED NULL'
);
DROP PROCEDURE add_agent_messages_column;

DROP PROCEDURE IF EXISTS add_agent_messages_index;
DELIMITER //
CREATE PROCEDURE add_agent_messages_index(IN p_index_name VARCHAR(191), IN ddl TEXT)
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.statistics
    WHERE table_schema = DATABASE() AND table_name = 'agent_messages' AND index_name = p_index_name
  ) THEN
    SET @agent_messages_ddl = ddl;
    PREPARE agent_messages_stmt FROM @agent_messages_ddl;
    EXECUTE agent_messages_stmt;
    DEALLOCATE PREPARE agent_messages_stmt;
  END IF;
END//
DELIMITER ;

-- Mirrors `idx_agent_messages_user`, which backs the cancel-everything-queued
-- sweep when an account is disabled. Without the counterpart that sweep would
-- table-scan for admin authors.
CALL add_agent_messages_index(
  'idx_agent_messages_admin_user',
  'CREATE INDEX idx_agent_messages_admin_user ON agent_messages (admin_user_id, status)'
);
DROP PROCEDURE add_agent_messages_index;
