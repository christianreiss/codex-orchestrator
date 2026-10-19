-- Separate genuine host contact from administrative edits.
SET @contact_exists = (SELECT COUNT(*) FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='hosts' AND column_name='last_contact_at');
SET @ddl = IF(@contact_exists=0,'ALTER TABLE hosts ADD COLUMN last_contact_at VARCHAR(100) NULL','SELECT 1');
PREPARE retention_stmt FROM @ddl;
EXECUTE retention_stmt;
DEALLOCATE PREPARE retention_stmt;
UPDATE hosts h LEFT JOIN (
 SELECT host_id, MAX(CONCAT(LEFT(created_at,19),'Z')) AS contacted_at FROM logs
 WHERE action IN ('agents.retrieve','cron.update_reported','auth.retrieve','auth.store','host.user')
 AND host_id IS NOT NULL AND LEFT(created_at,19)<=DATE_FORMAT(UTC_TIMESTAMP(),'%Y-%m-%dT%H:%i:%s') GROUP BY host_id
) l ON l.host_id=h.id
SET h.last_contact_at=NULLIF(GREATEST(COALESCE(l.contacted_at,''),COALESCE(h.last_cron_check,'')),'')
WHERE h.last_contact_at IS NULL;

SET @idx_exists=(SELECT COUNT(*) FROM information_schema.statistics WHERE table_schema=DATABASE() AND table_name='hosts' AND index_name='idx_hosts_last_contact');
SET @ddl=IF(@idx_exists=0,'CREATE INDEX idx_hosts_last_contact ON hosts (last_contact_at)','SELECT 1');
PREPARE retention_stmt FROM @ddl;
EXECUTE retention_stmt;
DEALLOCATE PREPARE retention_stmt;

SET @idx_exists=(SELECT COUNT(*) FROM information_schema.statistics WHERE table_schema=DATABASE() AND table_name='agent_bus_addresses' AND index_name='idx_agent_addresses_retention');
SET @ddl=IF(@idx_exists=0,'CREATE INDEX idx_agent_addresses_retention ON agent_bus_addresses (last_seen_at)','SELECT 1');
PREPARE retention_stmt FROM @ddl;
EXECUTE retention_stmt;
DEALLOCATE PREPARE retention_stmt;

SET @idx_exists=(SELECT COUNT(*) FROM information_schema.statistics WHERE table_schema=DATABASE() AND table_name='agent_bus_conversations' AND index_name='idx_agent_conversations_retention');
SET @ddl=IF(@idx_exists=0,'CREATE INDEX idx_agent_conversations_retention ON agent_bus_conversations (last_activity_at)','SELECT 1');
PREPARE retention_stmt FROM @ddl;
EXECUTE retention_stmt;
DEALLOCATE PREPARE retention_stmt;

SET @idx_exists=(SELECT COUNT(*) FROM information_schema.statistics WHERE table_schema=DATABASE() AND table_name='agent_bus_conferences' AND index_name='idx_agent_conferences_retention');
SET @ddl=IF(@idx_exists=0,'CREATE INDEX idx_agent_conferences_retention ON agent_bus_conferences (adjourned_at)','SELECT 1');
PREPARE retention_stmt FROM @ddl;
EXECUTE retention_stmt;
DEALLOCATE PREPARE retention_stmt;

SET @idx_exists=(SELECT COUNT(*) FROM information_schema.statistics WHERE table_schema=DATABASE() AND table_name='host_daemon_sessions' AND index_name='idx_daemon_sessions_retention');
SET @ddl=IF(@idx_exists=0,'CREATE INDEX idx_daemon_sessions_retention ON host_daemon_sessions (last_activity_at)','SELECT 1');
PREPARE retention_stmt FROM @ddl;
EXECUTE retention_stmt;
DEALLOCATE PREPARE retention_stmt;

SET @idx_exists=(SELECT COUNT(*) FROM information_schema.statistics WHERE table_schema=DATABASE() AND table_name='chatty_sessions' AND index_name='idx_chatty_sessions_retention');
SET @ddl=IF(@idx_exists=0,'CREATE INDEX idx_chatty_sessions_retention ON chatty_sessions (updated_at)','SELECT 1');
PREPARE retention_stmt FROM @ddl;
EXECUTE retention_stmt;
DEALLOCATE PREPARE retention_stmt;

SET @idx_exists=(SELECT COUNT(*) FROM information_schema.statistics WHERE table_schema=DATABASE() AND table_name='chatty_runs' AND index_name='idx_chatty_runs_user');
SET @ddl=IF(@idx_exists=0,'CREATE INDEX idx_chatty_runs_user ON chatty_runs (user_id)','SELECT 1');
PREPARE retention_stmt FROM @ddl;
EXECUTE retention_stmt;
DEALLOCATE PREPARE retention_stmt;

SET @idx_exists=(SELECT COUNT(*) FROM information_schema.statistics WHERE table_schema=DATABASE() AND table_name='agent_room_operations' AND index_name='idx_room_operations_retention');
SET @ddl=IF(@idx_exists=0,'CREATE INDEX idx_room_operations_retention ON agent_room_operations (created_at)','SELECT 1');
PREPARE retention_stmt FROM @ddl;
EXECUTE retention_stmt;
DEALLOCATE PREPARE retention_stmt;
