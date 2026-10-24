-- Historical timed leases remain timed. Only an explicit new owner grant opts
-- into connection ownership; disconnect/restart retains that durable obligation.
SET @provider_ownership_exists=(SELECT COUNT(*) FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='provider_account_sessions' AND column_name='ownership_mode');
SET @provider_ownership_ddl=IF(@provider_ownership_exists=0,'ALTER TABLE provider_account_sessions ADD COLUMN ownership_mode VARCHAR(16) NOT NULL DEFAULT ''timed''','SELECT 1');
PREPARE provider_ownership_stmt FROM @provider_ownership_ddl;
EXECUTE provider_ownership_stmt;
DEALLOCATE PREPARE provider_ownership_stmt;
