-- A live resource exclusion belongs to the exact native process attachment.
-- Legacy claims have no proof and cannot auto-recover after uncertain outcome.
SET @claim_instance_exists=(SELECT COUNT(*) FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='agent_resource_claims' AND column_name='native_instance_id');
SET @claim_instance_ddl=IF(@claim_instance_exists=0,'ALTER TABLE agent_resource_claims ADD COLUMN native_instance_id CHAR(36) NULL','SELECT 1');
PREPARE claim_instance_stmt FROM @claim_instance_ddl;
EXECUTE claim_instance_stmt;
DEALLOCATE PREPARE claim_instance_stmt;
SET @claim_mode_exists=(SELECT COUNT(*) FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='agent_resource_claims' AND column_name='ownership_mode');
SET @claim_mode_ddl=IF(@claim_mode_exists=0,'ALTER TABLE agent_resource_claims ADD COLUMN ownership_mode VARCHAR(16) NOT NULL DEFAULT ''timed''','SELECT 1');
PREPARE claim_mode_stmt FROM @claim_mode_ddl;
EXECUTE claim_mode_stmt;
DEALLOCATE PREPARE claim_mode_stmt;
