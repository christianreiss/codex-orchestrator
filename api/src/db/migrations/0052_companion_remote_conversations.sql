-- Keep headless Portal launches in one durable Android conversation.
CREATE TABLE IF NOT EXISTS host_daemon_portal_bindings (
  portal_session_id CHAR(36) NOT NULL PRIMARY KEY,
  daemon_session_id CHAR(36) NOT NULL,
  KEY idx_daemon_portal_session (daemon_session_id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS companion_daemon_follows (
  device_id CHAR(36) NOT NULL,
  daemon_session_id CHAR(36) NOT NULL,
  PRIMARY KEY (device_id, daemon_session_id)
) ENGINE=InnoDB;

-- Existing installations may mix older utf8mb4_unicode_ci Portal IDs and newer
-- database-default daemon/device IDs. A foreign key needs the exact referenced
-- column charset/collation, independently for each column. Replays keep existing
-- constraints untouched, including after a partially completed migration.
DROP PROCEDURE IF EXISTS companion_remote_add_fk;
DELIMITER //
CREATE PROCEDURE companion_remote_add_fk(IN tbl VARCHAR(64), IN col VARCHAR(64), IN ref_tbl VARCHAR(64), IN fk VARCHAR(64))
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.TABLE_CONSTRAINTS
    WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME = tbl AND CONSTRAINT_NAME = fk) THEN
    SELECT CONCAT('ALTER TABLE `', tbl, '` MODIFY COLUMN `', col, '` CHAR(36) CHARACTER SET ',
      CHARACTER_SET_NAME, ' COLLATE ', COLLATION_NAME, ' NOT NULL') INTO @companion_remote_ddl
    FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ref_tbl AND COLUMN_NAME = 'id';
    PREPARE companion_remote_fk_stmt FROM @companion_remote_ddl;
    EXECUTE companion_remote_fk_stmt;
    DEALLOCATE PREPARE companion_remote_fk_stmt;
    SET @companion_remote_ddl = CONCAT('ALTER TABLE `', tbl, '` ADD CONSTRAINT `', fk,
      '` FOREIGN KEY (`', col, '`) REFERENCES `', ref_tbl, '` (`id`) ON DELETE CASCADE');
    PREPARE companion_remote_fk_stmt FROM @companion_remote_ddl;
    EXECUTE companion_remote_fk_stmt;
    DEALLOCATE PREPARE companion_remote_fk_stmt;
  END IF;
END//
DELIMITER ;
CALL companion_remote_add_fk('host_daemon_portal_bindings', 'portal_session_id', 'agent_sessions', 'fk_daemon_portal_launch');
CALL companion_remote_add_fk('host_daemon_portal_bindings', 'daemon_session_id', 'host_daemon_sessions', 'fk_daemon_portal_remote');
CALL companion_remote_add_fk('companion_daemon_follows', 'device_id', 'companion_devices', 'fk_companion_daemon_device');
CALL companion_remote_add_fk('companion_daemon_follows', 'daemon_session_id', 'host_daemon_sessions', 'fk_companion_daemon_remote');
DROP PROCEDURE companion_remote_add_fk;

SET @has_portal_content = (SELECT COUNT(*) FROM information_schema.columns
  WHERE table_schema = DATABASE() AND table_name = 'host_daemon_operations' AND column_name = 'portal_content_enc');
SET @add_portal_content = IF(@has_portal_content = 0,
  'ALTER TABLE host_daemon_operations ADD COLUMN portal_content_enc LONGTEXT NULL', 'SELECT 1');
PREPARE companion_remote_stmt FROM @add_portal_content;
EXECUTE companion_remote_stmt;
DEALLOCATE PREPARE companion_remote_stmt;

INSERT IGNORE INTO host_daemon_portal_bindings (portal_session_id, daemon_session_id)
SELECT d.session_id, d.id FROM host_daemon_sessions d JOIN agent_sessions s ON BINARY s.id = BINARY d.session_id;
