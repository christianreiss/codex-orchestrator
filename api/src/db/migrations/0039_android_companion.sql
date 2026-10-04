-- Device tokens are hashed; FCM registration tokens use the existing secret box.
CREATE TABLE IF NOT EXISTS companion_pairings (
  token_hash CHAR(64) PRIMARY KEY,
  user_id BIGINT UNSIGNED NOT NULL,
  expires_at VARCHAR(100) NOT NULL,
  INDEX idx_companion_pairing_expiry (expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS companion_devices (
  id CHAR(36) PRIMARY KEY,
  user_id BIGINT UNSIGNED NOT NULL,
  name VARCHAR(100) NOT NULL,
  token_hash CHAR(64) NOT NULL,
  fcm_token_enc LONGTEXT NULL,
  notifications TINYINT NOT NULL DEFAULT 1,
  event_cursor BIGINT UNSIGNED NOT NULL DEFAULT 0,
  visible_session_id CHAR(36) NULL,
  visible_until VARCHAR(100) NULL,
  created_at VARCHAR(100) NOT NULL,
  last_seen_at VARCHAR(100) NOT NULL,
  expires_at VARCHAR(100) NOT NULL,
  revoked_at VARCHAR(100) NULL,
  UNIQUE KEY uq_companion_device_token (token_hash),
  INDEX idx_companion_device_user (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS companion_follows (
  device_id CHAR(36) NOT NULL,
  session_id CHAR(36) NOT NULL,
  PRIMARY KEY (device_id, session_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS companion_notifications (
  id CHAR(36) PRIMARY KEY,
  device_id CHAR(36) NOT NULL,
  source_key VARCHAR(100) NOT NULL,
  kind VARCHAR(24) NOT NULL,
  target_id VARCHAR(64) NOT NULL,
  state VARCHAR(16) NOT NULL DEFAULT 'pending',
  attempts INT NOT NULL DEFAULT 0,
  next_attempt_at VARCHAR(100) NOT NULL,
  expires_at VARCHAR(100) NOT NULL,
  created_at VARCHAR(100) NOT NULL,
  UNIQUE KEY uq_companion_notification_source (device_id, source_key),
  INDEX idx_companion_notification_work (state, next_attempt_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
