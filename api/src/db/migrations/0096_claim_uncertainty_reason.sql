-- A terminal unknown outcome must not be revived by a stale connection report.
SET @claim_reason_exists=(SELECT COUNT(*) FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='agent_resource_claims' AND column_name='uncertainty_reason');
SET @claim_reason_ddl=IF(@claim_reason_exists=0,'ALTER TABLE agent_resource_claims ADD COLUMN uncertainty_reason VARCHAR(32) NULL','SELECT 1');
PREPARE claim_reason_stmt FROM @claim_reason_ddl;
EXECUTE claim_reason_stmt;
DEALLOCATE PREPARE claim_reason_stmt;
