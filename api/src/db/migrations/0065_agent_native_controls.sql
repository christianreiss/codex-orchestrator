-- Session IDs inherit their parent column collation across both legacy and new installs.
SET @native_charset = (SELECT CHARACTER_SET_NAME FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'agent_sessions' AND column_name = 'id');
SET @native_collation = (SELECT COLLATION_NAME FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'agent_sessions' AND column_name = 'id');
SET @native_ddl = CONCAT('CREATE TABLE IF NOT EXISTS agent_native_controls (
 session_id CHAR(36) CHARACTER SET ', @native_charset, ' COLLATE ', @native_collation, ' NOT NULL PRIMARY KEY,
 instance_id CHAR(36) NOT NULL,
 binding_generation INT UNSIGNED NOT NULL,
 request_id CHAR(36) NULL,
 client_message_id CHAR(36) NULL,
 actor_id BIGINT UNSIGNED NULL,
 status VARCHAR(24) NOT NULL,
 updated_at VARCHAR(100) NOT NULL,
 CONSTRAINT fk_native_control_session FOREIGN KEY (session_id) REFERENCES agent_sessions(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4');
PREPARE native_stmt FROM @native_ddl;
EXECUTE native_stmt;
DEALLOCATE PREPARE native_stmt;
