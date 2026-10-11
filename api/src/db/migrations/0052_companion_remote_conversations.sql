-- Keep headless Portal launches in one durable Android conversation.
CREATE TABLE IF NOT EXISTS host_daemon_portal_bindings (
  portal_session_id CHAR(36) NOT NULL PRIMARY KEY,
  daemon_session_id CHAR(36) NOT NULL,
  KEY idx_daemon_portal_session (daemon_session_id),
  CONSTRAINT fk_daemon_portal_launch FOREIGN KEY (portal_session_id) REFERENCES agent_sessions(id) ON DELETE CASCADE,
  CONSTRAINT fk_daemon_portal_remote FOREIGN KEY (daemon_session_id) REFERENCES host_daemon_sessions(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS companion_daemon_follows (
  device_id CHAR(36) NOT NULL,
  daemon_session_id CHAR(36) NOT NULL,
  PRIMARY KEY (device_id, daemon_session_id),
  CONSTRAINT fk_companion_daemon_device FOREIGN KEY (device_id) REFERENCES companion_devices(id) ON DELETE CASCADE,
  CONSTRAINT fk_companion_daemon_remote FOREIGN KEY (daemon_session_id) REFERENCES host_daemon_sessions(id) ON DELETE CASCADE
) ENGINE=InnoDB;

SET @has_portal_content = (SELECT COUNT(*) FROM information_schema.columns
  WHERE table_schema = DATABASE() AND table_name = 'host_daemon_operations' AND column_name = 'portal_content_enc');
SET @add_portal_content = IF(@has_portal_content = 0,
  'ALTER TABLE host_daemon_operations ADD COLUMN portal_content_enc LONGTEXT NULL', 'SELECT 1');
PREPARE companion_remote_stmt FROM @add_portal_content;
EXECUTE companion_remote_stmt;
DEALLOCATE PREPARE companion_remote_stmt;

INSERT IGNORE INTO host_daemon_portal_bindings (portal_session_id, daemon_session_id)
SELECT d.session_id, d.id FROM host_daemon_sessions d JOIN agent_sessions s ON s.id = d.session_id;
