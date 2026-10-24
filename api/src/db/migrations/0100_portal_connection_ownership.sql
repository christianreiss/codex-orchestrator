-- Preserve offered portal instructions across disconnect and owner restart.
SET @portal_exists=(SELECT COUNT(*) FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='agent_messages' AND column_name='ownership_mode');
SET @portal_ddl=IF(@portal_exists=0,'ALTER TABLE agent_messages ADD COLUMN ownership_mode VARCHAR(16) NOT NULL DEFAULT ''timed''','SELECT 1');
PREPARE portal_stmt FROM @portal_ddl;
EXECUTE portal_stmt;
DEALLOCATE PREPARE portal_stmt;
SET @portal_exists=(SELECT COUNT(*) FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='agent_messages' AND column_name='owner_instance_id');
SET @portal_ddl=IF(@portal_exists=0,'ALTER TABLE agent_messages ADD COLUMN owner_instance_id CHAR(36) NULL','SELECT 1');
PREPARE portal_stmt FROM @portal_ddl;
EXECUTE portal_stmt;
DEALLOCATE PREPARE portal_stmt;
SET @portal_exists=(SELECT COUNT(*) FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='agent_messages' AND column_name='owner_binding_generation');
SET @portal_ddl=IF(@portal_exists=0,'ALTER TABLE agent_messages ADD COLUMN owner_binding_generation INT UNSIGNED NULL','SELECT 1');
PREPARE portal_stmt FROM @portal_ddl;
EXECUTE portal_stmt;
DEALLOCATE PREPARE portal_stmt;
