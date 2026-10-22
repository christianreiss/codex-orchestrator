-- Relay idle checks look up a host's addresses by service user; the only host_id index led with engine, so every
-- check scanned all of the host's addresses (~178 rows per check in production, 2026-10-22).
SET @idx_exists=(SELECT COUNT(*) FROM information_schema.statistics WHERE table_schema=DATABASE() AND table_name='agent_bus_addresses' AND index_name='idx_agent_bus_addresses_relay');
SET @ddl=IF(@idx_exists=0,'CREATE INDEX idx_agent_bus_addresses_relay ON agent_bus_addresses (host_id, username, enabled, archived_at)','SELECT 1');
PREPARE idle_poll_stmt FROM @ddl;
EXECUTE idle_poll_stmt;
DEALLOCATE PREPARE idle_poll_stmt;

-- schema.ts has always declared idx_scope_member_session, but 0078 and the baseline never created it (feedback 18f9d16d).
SET @idx_exists=(SELECT COUNT(*) FROM information_schema.statistics WHERE table_schema=DATABASE() AND table_name='agent_scope_members' AND index_name='idx_scope_member_session');
SET @ddl=IF(@idx_exists=0,'CREATE INDEX idx_scope_member_session ON agent_scope_members (session_id)','SELECT 1');
PREPARE idle_poll_stmt FROM @ddl;
EXECUTE idle_poll_stmt;
DEALLOCATE PREPARE idle_poll_stmt;
