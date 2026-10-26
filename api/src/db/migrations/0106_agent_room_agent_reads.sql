-- Per-agent read position in shared rooms: the newest room event timestamp an agent has
-- been shown through chats/read. One row per room and agent address. Additive, idempotent.
CREATE TABLE IF NOT EXISTS agent_room_agent_reads (
 room_id char(36) NOT NULL,
 address_id char(36) NOT NULL,
 read_through varchar(100) NOT NULL,
 updated_at varchar(100) NOT NULL,
 UNIQUE KEY uq_room_agent_read (room_id, address_id)
);
