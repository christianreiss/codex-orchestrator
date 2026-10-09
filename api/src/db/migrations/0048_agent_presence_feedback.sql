-- Session-bound return notices and durable waiting markers.
SET @ddl := IF((SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='agent_bus_messages' AND COLUMN_NAME='target_session_id')=0, 'ALTER TABLE agent_bus_messages ADD COLUMN target_session_id CHAR(36) NULL', 'SELECT 1');
PREPARE presence_ddl FROM @ddl;
EXECUTE presence_ddl;
DEALLOCATE PREPARE presence_ddl;
SET @ddl := IF((SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='agent_bus_messages' AND COLUMN_NAME='presence_notice_key')=0, 'ALTER TABLE agent_bus_messages ADD COLUMN presence_notice_key VARCHAR(100) NULL', 'SELECT 1');
PREPARE presence_ddl FROM @ddl;
EXECUTE presence_ddl;
DEALLOCATE PREPARE presence_ddl;
SET @ddl := IF((SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='agent_bus_messages' AND COLUMN_NAME='awaiting_presence')=0, 'ALTER TABLE agent_bus_messages ADD COLUMN awaiting_presence TINYINT NOT NULL DEFAULT 0', 'SELECT 1');
PREPARE presence_ddl FROM @ddl;
EXECUTE presence_ddl;
DEALLOCATE PREPARE presence_ddl;
SET @ddl := IF((SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='agent_bus_messages' AND INDEX_NAME='uq_agent_bus_messages_presence_notice')=0, 'CREATE UNIQUE INDEX uq_agent_bus_messages_presence_notice ON agent_bus_messages (presence_notice_key)', 'SELECT 1');
PREPARE presence_ddl FROM @ddl;
EXECUTE presence_ddl;
DEALLOCATE PREPARE presence_ddl;
