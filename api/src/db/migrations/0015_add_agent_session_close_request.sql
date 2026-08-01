-- Operator-initiated channel close. `close_requested_at` records the first
-- close request from the portal and is never cleared: a close is a historical
-- fact, and `cxx portal wait` re-heartbeats with relay_action=poll at the top of
-- every loop iteration, so any "clear it when the agent comes back" rule would
-- race the very iteration that is about to claim the close note.

SET @needs_session_close := (
  SELECT COUNT(*) = 0
    FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE()
     AND TABLE_NAME = 'agent_sessions'
     AND COLUMN_NAME = 'close_requested_at'
);
SET @ddl := IF(
  @needs_session_close,
  'ALTER TABLE agent_sessions ADD COLUMN close_requested_at VARCHAR(100) NULL AFTER active_turn_id',
  'DO 0'
);
PREPARE add_session_close FROM @ddl;
EXECUTE add_session_close;
DEALLOCATE PREPARE add_session_close;
