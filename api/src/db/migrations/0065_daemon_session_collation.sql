-- Remote (daemon) session IDs meet Portal session IDs in the same queries:
-- agent_chat_attachments.session_id holds either kind, and the attachment purge
-- joins it against agent_sessions.id, host_daemon_sessions.id and
-- host_daemon_portal_bindings.daemon_session_id at once. 0058 aligned the chat
-- column with agent_sessions.id, so on installations whose older Portal tables
-- predate the database default (utf8mb4_unicode_ci vs utf8mb4_0900_ai_ci) the
-- daemon family was left on the other collation and the purge failed with
-- "Illegal mix of collations". Align the daemon family with agent_sessions.id,
-- read from information_schema like 0058/0052, so fresh installations (one
-- collation everywhere) see no change.
--
-- MySQL refuses to change the collation of a column that a foreign key uses,
-- so the three FKs referencing host_daemon_sessions.id are dropped, the parent
-- table and child columns converted, and the FKs re-added under their previous
-- names. Each step is guarded, so a replay after a partial failure finishes the
-- job; a missing FK is re-added under its fresh-install name.
DROP PROCEDURE IF EXISTS daemon_session_collation_drop_fk;
DROP PROCEDURE IF EXISTS daemon_session_collation_add_fk;
DROP PROCEDURE IF EXISTS daemon_session_collation_align;
DELIMITER //
CREATE PROCEDURE daemon_session_collation_drop_fk(IN tbl VARCHAR(64), IN col VARCHAR(64), OUT fk VARCHAR(64))
BEGIN
  SET fk = NULL;
  SELECT CONSTRAINT_NAME INTO fk FROM information_schema.KEY_COLUMN_USAGE
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = tbl AND COLUMN_NAME = col
      AND REFERENCED_TABLE_NAME = 'host_daemon_sessions' AND REFERENCED_COLUMN_NAME = 'id'
    LIMIT 1;
  IF fk IS NOT NULL THEN
    SET @daemon_session_collation_ddl = CONCAT('ALTER TABLE `', tbl, '` DROP FOREIGN KEY `', fk, '`');
    PREPARE daemon_session_collation_stmt FROM @daemon_session_collation_ddl;
    EXECUTE daemon_session_collation_stmt;
    DEALLOCATE PREPARE daemon_session_collation_stmt;
  END IF;
END//
CREATE PROCEDURE daemon_session_collation_add_fk(IN tbl VARCHAR(64), IN col VARCHAR(64), IN fk VARCHAR(64))
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = tbl AND COLUMN_NAME = col)
    AND NOT EXISTS (SELECT 1 FROM information_schema.KEY_COLUMN_USAGE
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = tbl AND COLUMN_NAME = col
        AND REFERENCED_TABLE_NAME = 'host_daemon_sessions' AND REFERENCED_COLUMN_NAME = 'id') THEN
    SET @daemon_session_collation_ddl = CONCAT('ALTER TABLE `', tbl, '` ADD CONSTRAINT `', fk,
      '` FOREIGN KEY (`', col, '`) REFERENCES `host_daemon_sessions` (`id`) ON DELETE CASCADE');
    PREPARE daemon_session_collation_stmt FROM @daemon_session_collation_ddl;
    EXECUTE daemon_session_collation_stmt;
    DEALLOCATE PREPARE daemon_session_collation_stmt;
  END IF;
END//
CREATE PROCEDURE daemon_session_collation_align()
BEGIN
  DECLARE v_charset VARCHAR(64) DEFAULT NULL;
  DECLARE v_collation VARCHAR(64) DEFAULT NULL;
  DECLARE v_pending INT DEFAULT 0;
  DECLARE v_fk_binding VARCHAR(64) DEFAULT NULL;
  DECLARE v_fk_follow VARCHAR(64) DEFAULT NULL;
  DECLARE v_fk_operation VARCHAR(64) DEFAULT NULL;

  SELECT CHARACTER_SET_NAME, COLLATION_NAME INTO v_charset, v_collation FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'agent_sessions' AND COLUMN_NAME = 'id';

  IF v_collation IS NOT NULL AND EXISTS (SELECT 1 FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'host_daemon_sessions') THEN
    SELECT COUNT(*) INTO v_pending FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND COLLATION_NAME IS NOT NULL AND COLLATION_NAME <> v_collation
        AND (TABLE_NAME = 'host_daemon_sessions'
          OR (TABLE_NAME = 'host_daemon_portal_bindings' AND COLUMN_NAME = 'daemon_session_id')
          OR (TABLE_NAME = 'companion_daemon_follows' AND COLUMN_NAME = 'daemon_session_id')
          OR (TABLE_NAME = 'host_daemon_operations' AND COLUMN_NAME = 'session_id'));

    IF v_pending > 0 THEN
      CALL daemon_session_collation_drop_fk('host_daemon_portal_bindings', 'daemon_session_id', v_fk_binding);
      CALL daemon_session_collation_drop_fk('companion_daemon_follows', 'daemon_session_id', v_fk_follow);
      CALL daemon_session_collation_drop_fk('host_daemon_operations', 'session_id', v_fk_operation);

      IF EXISTS (SELECT 1 FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'host_daemon_sessions'
            AND COLLATION_NAME IS NOT NULL AND COLLATION_NAME <> v_collation) THEN
        SET @daemon_session_collation_ddl = CONCAT('ALTER TABLE `host_daemon_sessions` CONVERT TO CHARACTER SET ',
          v_charset, ' COLLATE ', v_collation);
        PREPARE daemon_session_collation_stmt FROM @daemon_session_collation_ddl;
        EXECUTE daemon_session_collation_stmt;
        DEALLOCATE PREPARE daemon_session_collation_stmt;
      END IF;

      IF EXISTS (SELECT 1 FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'host_daemon_portal_bindings'
            AND COLUMN_NAME = 'daemon_session_id' AND COLLATION_NAME <> v_collation) THEN
        SET @daemon_session_collation_ddl = CONCAT('ALTER TABLE `host_daemon_portal_bindings` MODIFY COLUMN `daemon_session_id` CHAR(36) CHARACTER SET ',
          v_charset, ' COLLATE ', v_collation, ' NOT NULL');
        PREPARE daemon_session_collation_stmt FROM @daemon_session_collation_ddl;
        EXECUTE daemon_session_collation_stmt;
        DEALLOCATE PREPARE daemon_session_collation_stmt;
      END IF;

      IF EXISTS (SELECT 1 FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'companion_daemon_follows'
            AND COLUMN_NAME = 'daemon_session_id' AND COLLATION_NAME <> v_collation) THEN
        SET @daemon_session_collation_ddl = CONCAT('ALTER TABLE `companion_daemon_follows` MODIFY COLUMN `daemon_session_id` CHAR(36) CHARACTER SET ',
          v_charset, ' COLLATE ', v_collation, ' NOT NULL');
        PREPARE daemon_session_collation_stmt FROM @daemon_session_collation_ddl;
        EXECUTE daemon_session_collation_stmt;
        DEALLOCATE PREPARE daemon_session_collation_stmt;
      END IF;

      IF EXISTS (SELECT 1 FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'host_daemon_operations'
            AND COLUMN_NAME = 'session_id' AND COLLATION_NAME <> v_collation) THEN
        SET @daemon_session_collation_ddl = CONCAT('ALTER TABLE `host_daemon_operations` MODIFY COLUMN `session_id` CHAR(36) CHARACTER SET ',
          v_charset, ' COLLATE ', v_collation, ' NOT NULL');
        PREPARE daemon_session_collation_stmt FROM @daemon_session_collation_ddl;
        EXECUTE daemon_session_collation_stmt;
        DEALLOCATE PREPARE daemon_session_collation_stmt;
      END IF;
    END IF;

    CALL daemon_session_collation_add_fk('host_daemon_portal_bindings', 'daemon_session_id',
      COALESCE(v_fk_binding, 'fk_daemon_portal_remote'));
    CALL daemon_session_collation_add_fk('companion_daemon_follows', 'daemon_session_id',
      COALESCE(v_fk_follow, 'fk_companion_daemon_remote'));
    CALL daemon_session_collation_add_fk('host_daemon_operations', 'session_id',
      COALESCE(v_fk_operation, 'host_daemon_operations_session_id_host_daemon_sessions_id_fk'));
  END IF;
END//
DELIMITER ;
CALL daemon_session_collation_align();
DROP PROCEDURE daemon_session_collation_align;
DROP PROCEDURE daemon_session_collation_add_fk;
DROP PROCEDURE daemon_session_collation_drop_fk;
