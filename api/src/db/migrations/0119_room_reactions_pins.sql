-- Android Companion R5 (C6): reactions and pins on shared-room events. Room events are
-- never edited or deleted (audit trail); these tables only annotate canonical events.
-- Both are cold metadata (no bodies). Every toggle appends an agent_room_changes row
-- (kind 'reaction' or 'pin', ref = event id) so delta sync re-delivers the event.
-- emoji compares byte-exactly: accent/variation-insensitive collations would merge
-- distinct emoji sequences in the unique key.
CREATE TABLE IF NOT EXISTS agent_room_reactions (
 room_id char(36) NOT NULL,
 event_id char(36) NOT NULL,
 actor varchar(80) NOT NULL,
 emoji varchar(16) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
 created_at varchar(100) NOT NULL,
 PRIMARY KEY (event_id, actor, emoji),
 KEY idx_room_reactions_room (room_id)
);
-- At most 20 pinned events per room (enforced by the API); one row per room and event.
CREATE TABLE IF NOT EXISTS agent_room_pins (
 room_id char(36) NOT NULL,
 event_id char(36) NOT NULL,
 pinned_by varchar(80) NOT NULL,
 pinned_at varchar(100) NOT NULL,
 PRIMARY KEY (room_id, event_id),
 KEY idx_room_pins_event (event_id)
);
