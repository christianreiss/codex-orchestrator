-- Fleet Advisor: one row per advisor conversation an agent opened. The advisor
-- itself is an ordinary host daemon session; this row binds it to its caller.
CREATE TABLE IF NOT EXISTS advisor_sessions (
  id CHAR(36) NOT NULL,
  caller_address_id CHAR(36) NOT NULL,
  client_key VARCHAR(150) NOT NULL,
  daemon_session_id CHAR(36) NOT NULL,
  host_id BIGINT UNSIGNED NOT NULL,
  kind VARCHAR(24) NOT NULL,
  conversation_id CHAR(36) NULL,
  status VARCHAR(16) NOT NULL,
  verdict_enc LONGTEXT NULL,
  close_reason VARCHAR(24) NULL,
  turns INT UNSIGNED NOT NULL DEFAULT 0,
  created_at VARCHAR(100) NOT NULL,
  updated_at VARCHAR(100) NOT NULL,
  closed_at VARCHAR(100) NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_advisor_client (client_key),
  UNIQUE KEY uq_advisor_daemon_session (daemon_session_id),
  KEY idx_advisor_caller (caller_address_id, status),
  CONSTRAINT fk_advisor_host FOREIGN KEY (host_id) REFERENCES hosts (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
