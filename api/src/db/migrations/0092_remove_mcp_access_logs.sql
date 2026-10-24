-- Keep security-relevant credential-read history, then remove unused request telemetry.
-- The source table may already be gone on a fresh install or a repeated run.
-- Freeze the legacy writer before copying: deploy migrations run while the old
-- API still serves. RENAME waits for in-flight writes, then old secret reads
-- fail closed rather than writing an audit row that the subsequent DROP loses.
-- If both names exist unexpectedly, RENAME fails and preserves both tables.
SET @mcp_logs_live = (SELECT COUNT(*) FROM information_schema.TABLES
  WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='mcp_access_logs');
SET @mcp_logs_freeze = IF(@mcp_logs_live > 0,
  'RENAME TABLE mcp_access_logs TO mcp_access_logs_retired', 'SELECT 1');
PREPARE mcp_logs_freeze_stmt FROM @mcp_logs_freeze;
EXECUTE mcp_logs_freeze_stmt;
DEALLOCATE PREPARE mcp_logs_freeze_stmt;

SET @mcp_logs_exists = (SELECT COUNT(*) FROM information_schema.TABLES
  WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='mcp_access_logs_retired');
SET @mcp_logs_retire = IF(@mcp_logs_exists > 0,
  'INSERT INTO admin_events (type, host_id, payload, created_at)
   SELECT ''secret.read'', m.host_id,
     JSON_OBJECT(''slug'', SUBSTRING(m.name, 12), ''success'', IF(m.success=1, TRUE, FALSE),
       ''error_code'', m.error_message, ''engine'', m.engine,
       ''legacy_mcp_log_id'', m.id), m.created_at
   FROM mcp_access_logs_retired m
   WHERE m.method=''secret.read''
     AND NOT EXISTS (SELECT 1 FROM admin_events a WHERE a.type=''secret.read''
       AND JSON_UNQUOTE(JSON_EXTRACT(a.payload, ''$.legacy_mcp_log_id''))=CAST(m.id AS CHAR))',
  'SELECT 1');
PREPARE mcp_logs_retire_stmt FROM @mcp_logs_retire;
EXECUTE mcp_logs_retire_stmt;
DEALLOCATE PREPARE mcp_logs_retire_stmt;
DROP TABLE IF EXISTS mcp_access_logs_retired;

-- These controls never had an executing worker and falsely promised retention.
DELETE FROM versions WHERE name IN ('log_retention_enabled', 'log_retention_days_logs',
  'log_retention_days_mcp', 'log_retention_days_events', 'log_retention_days_graph_stats');

-- Remove the old rows for access telemetry whose writers were retired as well.
DELETE FROM logs WHERE action IN (
  'agents.retrieve',
  'admin.toast',
  'claude_artifact.list',
  'claude_artifact.retrieve',
  'claude_settings.retrieve',
  'config.retrieve',
  'memory.retrieve',
  'memory.search',
  'project.changes',
  'project.detail',
  'project.feedback.list',
  'project.file.read',
  'project.files.list',
  'project.list',
  'project.memories.list',
  'project.memories.search',
  'project.memory.get',
  'project.memory.unchanged',
  'project.notes.list',
  'project.summary',
  'project.todos.list',
  'shared_memory.list',
  'shared_memory.read',
  'shared_memory.search',
  'skill.bundle',
  'skill.file.list',
  'skill.file.retrieve',
  'skill.list',
  'skill.retrieve',
  'agent_message.queued',
  'agent_message.replied'
);
