-- Android Companion R3: room push, room delta sync, unified unread.
-- agent_room_changes is a metadata-only, append-only change log for shared rooms. Every
-- room mutation (event, delivery receipt, membership, status/read position) appends one row
-- in the same transaction. seq is the durable, monotonic delta cursor for room reads and
-- the room push cursor. No bodies are stored here; retention prunes it with room history.
CREATE TABLE IF NOT EXISTS agent_room_changes (
 seq bigint unsigned NOT NULL AUTO_INCREMENT,
 room_id char(36) NOT NULL,
 kind varchar(16) NOT NULL,
 ref_id char(36) NULL,
 created_at varchar(100) NOT NULL,
 PRIMARY KEY (seq),
 KEY idx_room_changes_room (room_id, seq),
 KEY idx_room_changes_time (created_at)
);
-- Per-device, per-room push preference: follow (every message by someone else),
-- default (mentions of, and replies to, the operator) or mute (none). No row = default.
CREATE TABLE IF NOT EXISTS companion_room_prefs (
 device_id char(36) NOT NULL,
 room_id char(36) NOT NULL,
 mode varchar(8) NOT NULL DEFAULT 'default',
 updated_at varchar(100) NOT NULL,
 PRIMARY KEY (device_id, room_id)
);
-- Room push cursor into agent_room_changes.seq. Existing devices start at the current
-- head (the table is new, so 0 or its current maximum), never at history: no flood.
SET @companion_room_cursor_col = (SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'companion_devices' AND column_name = 'room_change_cursor');
SET @companion_room_cursor_ddl = IF(@companion_room_cursor_col = 0, 'ALTER TABLE companion_devices ADD COLUMN room_change_cursor BIGINT UNSIGNED NOT NULL DEFAULT 0', 'SELECT 1');
PREPARE companion_room_cursor_stmt FROM @companion_room_cursor_ddl;
EXECUTE companion_room_cursor_stmt;
DEALLOCATE PREPARE companion_room_cursor_stmt;
UPDATE companion_devices SET room_change_cursor = (SELECT COALESCE(MAX(seq), 0) FROM agent_room_changes) WHERE room_change_cursor = 0;
