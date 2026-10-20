-- NULL marks historical runs; only new runs require clarification and confirmation.
SET @workflow_sql = IF(EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'workflow_runs' AND column_name = 'preparation'), 'SELECT 1', 'ALTER TABLE workflow_runs ADD COLUMN preparation JSON NULL');
PREPARE workflow_stmt FROM @workflow_sql;
EXECUTE workflow_stmt;
DEALLOCATE PREPARE workflow_stmt;
