-- Session-scoped discovery facts; no raw remote URLs or manual Director registration.
SET @has_agent_workspace = (SELECT COUNT(*) FROM information_schema.columns
  WHERE table_schema = DATABASE() AND table_name = 'agent_sessions' AND column_name = 'workspace');
SET @agent_workspace_ddl = IF(@has_agent_workspace = 0,
  'ALTER TABLE agent_sessions ADD COLUMN workspace JSON NULL', 'SELECT 1');
PREPARE agent_workspace_stmt FROM @agent_workspace_ddl;
EXECUTE agent_workspace_stmt;
DEALLOCATE PREPARE agent_workspace_stmt;
