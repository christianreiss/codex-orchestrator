CREATE TABLE IF NOT EXISTS host_daemons (
 host_id BIGINT UNSIGNED NOT NULL PRIMARY KEY,
 settings JSON NOT NULL, runtime JSON NULL,
 enabled_at VARCHAR(100) NULL, updated_at VARCHAR(100) NOT NULL,
 FOREIGN KEY (host_id) REFERENCES hosts(id) ON DELETE CASCADE
) ENGINE=InnoDB;
CREATE TABLE IF NOT EXISTS host_daemon_sessions (
 id CHAR(36) NOT NULL PRIMARY KEY, host_id BIGINT UNSIGNED NOT NULL,
 owner VARCHAR(100) NOT NULL, engine VARCHAR(16) NOT NULL, username VARCHAR(64) NOT NULL,
 cwd VARCHAR(1024) NOT NULL, title VARCHAR(160) NOT NULL,
 address_id CHAR(36) NULL, session_id CHAR(36) NULL, active_message_id CHAR(36) NULL, status VARCHAR(24) NOT NULL,
 last_activity_at VARCHAR(100) NOT NULL, created_at VARCHAR(100) NOT NULL,
 INDEX idx_daemon_sessions_host(host_id), UNIQUE KEY uq_daemon_session_address(address_id),
 FOREIGN KEY (host_id) REFERENCES hosts(id) ON DELETE CASCADE
) ENGINE=InnoDB;
CREATE TABLE IF NOT EXISTS host_daemon_operations (
 id CHAR(36) NOT NULL PRIMARY KEY, session_id CHAR(36) NOT NULL, host_id BIGINT UNSIGNED NOT NULL,
 client_key VARCHAR(150) NOT NULL, request_hash CHAR(64) NOT NULL,
 prompt_enc LONGTEXT NOT NULL, status VARCHAR(24) NOT NULL, claim_id CHAR(36) NULL, result_enc LONGTEXT NULL,
 created_at VARCHAR(100) NOT NULL, updated_at VARCHAR(100) NOT NULL,
 UNIQUE KEY uq_daemon_operation_client(client_key), INDEX idx_daemon_operations_host(host_id,status),
 FOREIGN KEY (host_id) REFERENCES hosts(id) ON DELETE CASCADE,
 FOREIGN KEY (session_id) REFERENCES host_daemon_sessions(id) ON DELETE CASCADE
) ENGINE=InnoDB;
