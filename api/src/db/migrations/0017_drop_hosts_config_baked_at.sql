-- Drop the informational `hosts.config_baked_at` column.
--
-- It was written on every bake and read by nothing: no code branches on it, it
-- carries no index, it is not part of the signed config payload, and
-- `hostToWire` never put it on the wire. `hosts.config_version` is the value
-- that actually changes the etag and the signature.
--
-- DEPLOY CAVEAT — DO NOT SHIP THIS MIGRATION IN THE SAME STEP AS THE CODE.
-- `scripts/deploy.sh` applies migrations with the freshly built image *before*
-- `docker compose up` swaps the containers, and the api also migrates itself on
-- boot via RUN_MIGRATIONS_ON_BOOT. Drizzle emits explicit column lists, so the
-- still-running OUTGOING container selects `config_baked_at` on every host
-- lookup and will throw ER_BAD_FIELD_ERROR for the whole deploy window.
-- The safe procedure is a two-step deploy:
--   1. Ship a build that no longer references the column but does NOT contain
--      this file, and wait until every instance is on it.
--   2. Ship this migration and apply it.
-- There is no rollback: re-adding the column does not restore any timestamp.

-- MySQL has no `DROP COLUMN IF EXISTS`, so guard on information_schema. Re-applying
-- this file against an already-migrated database must be a no-op.
DROP PROCEDURE IF EXISTS drop_hosts_config_column;
DELIMITER //
CREATE PROCEDURE drop_hosts_config_column(IN p_table_name VARCHAR(191), IN p_column_name VARCHAR(191))
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = DATABASE() AND table_name = p_table_name AND column_name = p_column_name
  ) THEN
    SET @drop_hosts_config_ddl = CONCAT('ALTER TABLE `', p_table_name, '` DROP COLUMN `', p_column_name, '`');
    PREPARE drop_hosts_config_stmt FROM @drop_hosts_config_ddl;
    EXECUTE drop_hosts_config_stmt;
    DEALLOCATE PREPARE drop_hosts_config_stmt;
  END IF;
END//
DELIMITER ;

CALL drop_hosts_config_column('hosts', 'config_baked_at');
DROP PROCEDURE drop_hosts_config_column;
