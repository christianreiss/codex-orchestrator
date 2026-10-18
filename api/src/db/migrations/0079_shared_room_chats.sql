-- Shared chat history and real operator conference ownership. Additive, idempotent.
SET @room_owner_exists = (SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'agent_bus_conferences' AND column_name = 'owner_admin_id');
SET @room_owner_ddl = IF(@room_owner_exists = 0, 'ALTER TABLE agent_bus_conferences ADD COLUMN owner_admin_id int unsigned NULL', 'SELECT 1');
PREPARE room_owner_stmt FROM @room_owner_ddl;
EXECUTE room_owner_stmt;
DEALLOCATE PREPARE room_owner_stmt;
CREATE TABLE IF NOT EXISTS agent_room_events (
 id char(36) PRIMARY KEY, room_id char(36) NOT NULL, actor varchar(80) NOT NULL,
 request_id char(36) NOT NULL, payload_hash char(64) NOT NULL, body_enc longtext NOT NULL,
 created_at varchar(100) NOT NULL,
 UNIQUE KEY uq_room_event_request (room_id, actor, request_id),
 KEY idx_room_event_time (room_id, created_at, id)
);
CREATE TABLE IF NOT EXISTS agent_room_reads (
 room_id char(36) NOT NULL, admin_id int unsigned NOT NULL, read_at varchar(100) NOT NULL,
 UNIQUE KEY uq_room_read (room_id, admin_id)
);
CREATE TABLE IF NOT EXISTS agent_room_operations (
 id char(36) PRIMARY KEY, actor varchar(80) NOT NULL, payload_hash char(64) NOT NULL,
 result json NOT NULL, created_at varchar(100) NOT NULL
);
CREATE TABLE IF NOT EXISTS agent_room_deliveries (
 event_id char(36) NOT NULL, address_id char(36) NOT NULL, message_id char(36), reason varchar(80),
 UNIQUE KEY uq_room_delivery (event_id, address_id)
);

-- Existing bus IDs may predate the database's current default collation.
SET @room_message_charset = (SELECT CHARACTER_SET_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='agent_bus_messages' AND COLUMN_NAME='id');
SET @room_message_collation = (SELECT COLLATION_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='agent_bus_messages' AND COLUMN_NAME='id');
SET @room_message_ddl = IF((SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='agent_room_deliveries' AND COLUMN_NAME='message_id' AND COLLATION_NAME=@room_message_collation)=0, CONCAT('ALTER TABLE agent_room_deliveries MODIFY COLUMN message_id CHAR(36) CHARACTER SET ', @room_message_charset, ' COLLATE ', @room_message_collation, ' NULL'), 'SELECT 1');
PREPARE room_message_stmt FROM @room_message_ddl;
EXECUTE room_message_stmt;
DEALLOCATE PREPARE room_message_stmt;
