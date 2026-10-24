-- Durable commands and effects belong to one active control-plane owner.
CREATE TABLE IF NOT EXISTS control_plane_owner (
  id TINYINT UNSIGNED NOT NULL PRIMARY KEY,
  epoch CHAR(36) NOT NULL,
  sequence BIGINT UNSIGNED NOT NULL DEFAULT 0,
  started_at VARCHAR(100) NOT NULL
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS control_plane_command_receipts (
  principal VARCHAR(191) COLLATE utf8mb4_bin NOT NULL,
  request_id VARCHAR(64) COLLATE utf8mb4_bin NOT NULL,
  kind VARCHAR(191) NOT NULL,
  request_digest CHAR(64) NOT NULL,
  owner_epoch CHAR(36) NOT NULL,
  sequence BIGINT UNSIGNED NOT NULL,
  result_enc LONGTEXT NOT NULL,
  created_at VARCHAR(100) NOT NULL,
  PRIMARY KEY (principal, request_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE IF NOT EXISTS control_plane_outbox (
  id CHAR(36) COLLATE utf8mb4_bin NOT NULL PRIMARY KEY,
  principal VARCHAR(191) COLLATE utf8mb4_bin NOT NULL,
  request_id VARCHAR(64) COLLATE utf8mb4_bin NOT NULL,
  kind VARCHAR(191) NOT NULL,
  target VARCHAR(255) NOT NULL,
  payload_enc LONGTEXT NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'pending',
  attempts INT UNSIGNED NOT NULL DEFAULT 0,
  available_at VARCHAR(100) NOT NULL,
  created_at VARCHAR(100) NOT NULL,
  completed_at VARCHAR(100) NULL,
  INDEX control_plane_outbox_due (status, available_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
