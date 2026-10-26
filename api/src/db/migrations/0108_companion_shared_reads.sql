-- One monotonic conversation read position per administrator, shared by their devices.
CREATE TABLE IF NOT EXISTS companion_reads (
 user_id BIGINT UNSIGNED NOT NULL,
 session_id CHAR(36) NOT NULL,
 read_cursor BIGINT UNSIGNED NOT NULL,
 updated_at VARCHAR(100) NOT NULL,
 PRIMARY KEY (user_id, session_id),
 CONSTRAINT fk_companion_read_user FOREIGN KEY (user_id) REFERENCES admin_users(id) ON DELETE CASCADE
);
SET @needs_read_sync_protocol := (
 SELECT COUNT(*) = 0 FROM information_schema.COLUMNS
 WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'companion_devices' AND COLUMN_NAME = 'read_sync_protocol'
);
SET @read_sync_protocol_ddl := IF(@needs_read_sync_protocol,
 'ALTER TABLE companion_devices ADD COLUMN read_sync_protocol TINYINT NOT NULL DEFAULT 0', 'DO 0');
PREPARE add_read_sync_protocol FROM @read_sync_protocol_ddl;
EXECUTE add_read_sync_protocol;
DEALLOCATE PREPARE add_read_sync_protocol;
