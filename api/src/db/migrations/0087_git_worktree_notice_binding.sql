-- Historical registrations remain unbound until an explicit git_register.
-- Never infer an old owner's session from an address's current binding.
SET @git_notice_session_exists = (SELECT COUNT(*) FROM information_schema.columns
  WHERE table_schema = DATABASE() AND table_name = 'git_worktrees' AND column_name = 'agent_session_id');
SET @git_notice_session_ddl = IF(@git_notice_session_exists = 0,
  'ALTER TABLE git_worktrees ADD COLUMN agent_session_id CHAR(36) NULL', 'SELECT 1');
PREPARE git_notice_session_stmt FROM @git_notice_session_ddl;
EXECUTE git_notice_session_stmt;
DEALLOCATE PREPARE git_notice_session_stmt;

SET @git_notice_generation_exists = (SELECT COUNT(*) FROM information_schema.columns
  WHERE table_schema = DATABASE() AND table_name = 'git_worktrees' AND column_name = 'agent_binding_generation');
SET @git_notice_generation_ddl = IF(@git_notice_generation_exists = 0,
  'ALTER TABLE git_worktrees ADD COLUMN agent_binding_generation INT UNSIGNED NULL', 'SELECT 1');
PREPARE git_notice_generation_stmt FROM @git_notice_generation_ddl;
EXECUTE git_notice_generation_stmt;
DEALLOCATE PREPARE git_notice_generation_stmt;
