-- External receipt clocks must skip expired result bodies before seeking age.
-- Otherwise ORDER BY created_at LIMIT 1 scans old expired history and blocks
-- the serialized owner queue long enough for client registration to time out.
SET @needs_receipt_state_age_index := (
  SELECT COUNT(*) = 0 FROM information_schema.STATISTICS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'control_plane_command_receipts'
     AND INDEX_NAME = 'command_receipts_state_age'
);
SET @receipt_state_age_ddl := IF(
  @needs_receipt_state_age_index,
  'ALTER TABLE control_plane_command_receipts ADD INDEX command_receipts_state_age (result_state, created_at, replay_class), ALGORITHM=INPLACE, LOCK=NONE',
  'DO 0'
);
PREPARE add_receipt_state_age_index FROM @receipt_state_age_ddl;
EXECUTE add_receipt_state_age_index;
DEALLOCATE PREPARE add_receipt_state_age_index;
