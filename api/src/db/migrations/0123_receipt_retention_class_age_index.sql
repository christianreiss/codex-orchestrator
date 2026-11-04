-- Internal receipt retention uses a seven-day cutoff, while external/legacy
-- receipts live longer. Seek within the internal class before scanning age so
-- each owner sweep does not walk the older external history and stall commands.
SET @needs_receipt_class_age_index := (
  SELECT COUNT(*) = 0 FROM information_schema.STATISTICS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'control_plane_command_receipts'
     AND INDEX_NAME = 'command_receipts_class_age'
);
SET @receipt_class_age_ddl := IF(
  @needs_receipt_class_age_index,
  'ALTER TABLE control_plane_command_receipts ADD INDEX command_receipts_class_age (replay_class, created_at), ALGORITHM=INPLACE, LOCK=NONE',
  'DO 0'
);
PREPARE add_receipt_class_age_index FROM @receipt_class_age_ddl;
EXECUTE add_receipt_class_age_index;
DEALLOCATE PREPARE add_receipt_class_age_index;
