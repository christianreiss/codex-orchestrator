-- Only a proven attachment opts into the one-use owner-restart recovery window.
-- Existing rows stay unmarked; each column is guarded independently.
SET @suspend_col=(SELECT COUNT(*) FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='agent_sessions' AND column_name='suspend_attachment_generation');
SET @suspend_ddl=IF(@suspend_col=0,'ALTER TABLE agent_sessions ADD COLUMN suspend_attachment_generation INT UNSIGNED NULL','SELECT 1');
PREPARE suspend_stmt FROM @suspend_ddl;
EXECUTE suspend_stmt;
DEALLOCATE PREPARE suspend_stmt;

SET @suspend_col=(SELECT COUNT(*) FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='agent_sessions' AND column_name='suspend_recovery_until');
SET @suspend_ddl=IF(@suspend_col=0,'ALTER TABLE agent_sessions ADD COLUMN suspend_recovery_until VARCHAR(100) NULL','SELECT 1');
PREPARE suspend_stmt FROM @suspend_ddl;
EXECUTE suspend_stmt;
DEALLOCATE PREPARE suspend_stmt;
