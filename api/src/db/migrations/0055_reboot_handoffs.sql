-- A nullable unique active_host_id reserves exactly one handoff per host.
-- Retain terminal rows: consumed native transcripts must never auto-rearm.
CREATE TABLE IF NOT EXISTS agent_reboot_handoffs (
  id CHAR(36) NOT NULL PRIMARY KEY,
  host_id BIGINT UNSIGNED NOT NULL,
  active_host_id BIGINT UNSIGNED NULL,
  address_id CHAR(36) NOT NULL,
  old_session_id CHAR(36) NOT NULL,
  new_session_id CHAR(36) NULL,
  engine VARCHAR(16) NOT NULL,
  username VARCHAR(255) NOT NULL,
  cwd VARCHAR(1024) NOT NULL,
  native_session_id VARCHAR(255) NOT NULL,
  boot_id CHAR(36) NOT NULL,
  resume_boot_id CHAR(36) NULL,
  request_sha CHAR(64) NOT NULL,
  continuation_enc LONGTEXT NOT NULL,
  reason VARCHAR(1000) NOT NULL,
  status VARCHAR(24) NOT NULL,
  bus_message_ids JSON NOT NULL,
  portal_message_ids JSON NOT NULL,
  expires_at VARCHAR(100) NOT NULL,
  created_at VARCHAR(100) NOT NULL,
  updated_at VARCHAR(100) NOT NULL,
  UNIQUE KEY uq_reboot_active_host (active_host_id),
  KEY idx_reboot_native (host_id, engine, native_session_id),
  KEY idx_reboot_old_session (old_session_id),
  KEY idx_reboot_new_session (new_session_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
