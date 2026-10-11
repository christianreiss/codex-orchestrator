-- Latest native observation; delivery ownership and work results remain independent.
SET @has_agent_activity = (SELECT COUNT(*) FROM information_schema.columns
  WHERE table_schema = DATABASE() AND table_name = 'agent_sessions' AND column_name = 'activity');
SET @agent_activity_ddl = IF(@has_agent_activity = 0,
  'ALTER TABLE agent_sessions ADD COLUMN activity JSON NULL', 'SELECT 1');
PREPARE agent_activity_stmt FROM @agent_activity_ddl;
EXECUTE agent_activity_stmt;
DEALLOCATE PREPARE agent_activity_stmt;
