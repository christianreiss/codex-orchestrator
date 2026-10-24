-- Worktree occupancy survives transport loss as uncertain exclusion; merge
-- permission remains a separate bounded absolute deadline.
SET @git_instance_exists=(SELECT COUNT(*) FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='git_worktrees' AND column_name='native_instance_id');
SET @git_instance_ddl=IF(@git_instance_exists=0,'ALTER TABLE git_worktrees ADD COLUMN native_instance_id CHAR(36) NULL','SELECT 1');
PREPARE git_instance_stmt FROM @git_instance_ddl;
EXECUTE git_instance_stmt;
DEALLOCATE PREPARE git_instance_stmt;
SET @git_mode_exists=(SELECT COUNT(*) FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='git_worktrees' AND column_name='ownership_mode');
SET @git_mode_ddl=IF(@git_mode_exists=0,'ALTER TABLE git_worktrees ADD COLUMN ownership_mode VARCHAR(16) NOT NULL DEFAULT ''timed''','SELECT 1');
PREPARE git_mode_stmt FROM @git_mode_ddl;
EXECUTE git_mode_stmt;
DEALLOCATE PREPARE git_mode_stmt;
SET @git_reason_exists=(SELECT COUNT(*) FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='git_worktrees' AND column_name='uncertainty_reason');
SET @git_reason_ddl=IF(@git_reason_exists=0,'ALTER TABLE git_worktrees ADD COLUMN uncertainty_reason VARCHAR(32) NULL','SELECT 1');
PREPARE git_reason_stmt FROM @git_reason_ddl;
EXECUTE git_reason_stmt;
DEALLOCATE PREPARE git_reason_stmt;
