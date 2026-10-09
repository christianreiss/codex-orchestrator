CREATE TABLE IF NOT EXISTS chatty_sessions (
 user_id BIGINT UNSIGNED NOT NULL PRIMARY KEY, generation INT NOT NULL DEFAULT 1,
 selection JSON NOT NULL, seen_available TINYINT NOT NULL DEFAULT 0,
 summary_enc LONGTEXT NULL, updated_at VARCHAR(100) NOT NULL,
 FOREIGN KEY (user_id) REFERENCES admin_users(id) ON DELETE CASCADE
) ENGINE=InnoDB;
CREATE TABLE IF NOT EXISTS chatty_runs (
 id CHAR(36) NOT NULL PRIMARY KEY, user_id BIGINT UNSIGNED NOT NULL,
 admin_session_id BIGINT UNSIGNED NOT NULL, generation INT NOT NULL,
 client_message_id CHAR(36) NOT NULL, request_hash CHAR(64) NOT NULL,
 status VARCHAR(32) NOT NULL, input_enc LONGTEXT NOT NULL, state_enc LONGTEXT NOT NULL,
 claim_id CHAR(36) NULL, lease_until VARCHAR(100) NULL,
 steps INT NOT NULL DEFAULT 0, active_ms INT NOT NULL DEFAULT 0,
 created_at VARCHAR(100) NOT NULL, updated_at VARCHAR(100) NOT NULL,
 UNIQUE KEY uq_chatty_client(user_id,client_message_id), INDEX idx_chatty_queue(status,created_at),
 FOREIGN KEY (user_id) REFERENCES admin_users(id) ON DELETE CASCADE
) ENGINE=InnoDB;
CREATE TABLE IF NOT EXISTS chatty_events (
 id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
 user_id BIGINT UNSIGNED NOT NULL, generation INT NOT NULL, run_id CHAR(36) NULL,
 kind VARCHAR(24) NOT NULL, body_enc LONGTEXT NOT NULL, created_at VARCHAR(100) NOT NULL,
 INDEX idx_chatty_events(user_id,generation,id),
 FOREIGN KEY (user_id) REFERENCES admin_users(id) ON DELETE CASCADE
) ENGINE=InnoDB;
CREATE TABLE IF NOT EXISTS chatty_actions (
 id CHAR(36) NOT NULL PRIMARY KEY, run_id CHAR(36) NOT NULL, user_id BIGINT UNSIGNED NOT NULL,
 generation INT NOT NULL, tool VARCHAR(100) NOT NULL, status VARCHAR(24) NOT NULL,
 payload_enc LONGTEXT NOT NULL, result_enc LONGTEXT NULL,
 expires_at VARCHAR(100) NOT NULL, created_at VARCHAR(100) NOT NULL, updated_at VARCHAR(100) NOT NULL,
 INDEX idx_chatty_actions(run_id,status),
 FOREIGN KEY (user_id) REFERENCES admin_users(id) ON DELETE CASCADE
) ENGINE=InnoDB;
