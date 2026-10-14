-- Fleet activity counters filter by action and a UTC timestamp range. Cover
-- host_id as well so recent distinct-host counts do not fetch audit payloads.
-- Keep the existing host/time indexes for other audit queries.
SET @needs_logs_activity_index := (
  SELECT COUNT(*) = 0
    FROM information_schema.STATISTICS
   WHERE TABLE_SCHEMA = DATABASE()
     AND TABLE_NAME = 'logs'
     AND INDEX_NAME = 'idx_logs_action_created_host'
);
SET @logs_activity_ddl := IF(
  @needs_logs_activity_index,
  'ALTER TABLE logs ADD INDEX idx_logs_action_created_host (action, created_at, host_id), ALGORITHM=INPLACE, LOCK=NONE',
  'DO 0'
);
PREPARE add_logs_activity_index FROM @logs_activity_ddl;
EXECUTE add_logs_activity_index;
DEALLOCATE PREPARE add_logs_activity_index;
