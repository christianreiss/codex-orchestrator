-- Sender-selected timing is independent of informational priority/coalescing.
-- Existing messages retain their normal after-turn delivery semantics.
SET @needs_message_delivery_timing := (
  SELECT COUNT(*) = 0 FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'agent_bus_messages'
    AND COLUMN_NAME = 'delivery_timing'
);
SET @message_delivery_timing_ddl := IF(@needs_message_delivery_timing,
  'ALTER TABLE agent_bus_messages ADD COLUMN delivery_timing VARCHAR(16) NOT NULL DEFAULT ''after_turn''',
  'DO 0');
PREPARE add_message_delivery_timing FROM @message_delivery_timing_ddl;
EXECUTE add_message_delivery_timing;
DEALLOCATE PREPARE add_message_delivery_timing;
