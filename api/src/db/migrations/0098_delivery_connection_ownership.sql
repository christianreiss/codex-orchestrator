-- New delivery grants are held by an exact connection identity. Disconnect is
-- uncertainty, never authority to retry work. Existing timed grants stay marked.
SET @delivery_mode_exists=(SELECT COUNT(*) FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='agent_bus_messages' AND column_name='ownership_mode');
SET @delivery_mode_ddl=IF(@delivery_mode_exists=0,'ALTER TABLE agent_bus_messages ADD COLUMN ownership_mode VARCHAR(16) NOT NULL DEFAULT ''timed''','SELECT 1');
PREPARE delivery_mode_stmt FROM @delivery_mode_ddl;
EXECUTE delivery_mode_stmt;
DEALLOCATE PREPARE delivery_mode_stmt;
SET @delivery_instance_exists=(SELECT COUNT(*) FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='agent_bus_messages' AND column_name='owner_instance_id');
SET @delivery_instance_ddl=IF(@delivery_instance_exists=0,'ALTER TABLE agent_bus_messages ADD COLUMN owner_instance_id CHAR(36) NULL','SELECT 1');
PREPARE delivery_instance_stmt FROM @delivery_instance_ddl;
EXECUTE delivery_instance_stmt;
DEALLOCATE PREPARE delivery_instance_stmt;
