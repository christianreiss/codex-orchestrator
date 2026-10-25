-- Conference admission resolves room-question notices by their message ID.
-- Preserve the event/address uniqueness key and avoid a history scan per lookup.
SET @needs_room_delivery_message_index := (
  SELECT COUNT(*) = 0 FROM information_schema.STATISTICS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'agent_room_deliveries'
     AND INDEX_NAME = 'idx_room_delivery_message'
);
SET @room_delivery_message_ddl := IF(
  @needs_room_delivery_message_index,
  'ALTER TABLE agent_room_deliveries ADD INDEX idx_room_delivery_message (message_id), ALGORITHM=INPLACE, LOCK=NONE',
  'DO 0'
);
PREPARE add_room_delivery_message_index FROM @room_delivery_message_ddl;
EXECUTE add_room_delivery_message_index;
DEALLOCATE PREPARE add_room_delivery_message_index;
