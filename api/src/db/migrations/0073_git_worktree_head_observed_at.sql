-- git_worktrees.head_sha is reported by the agent, never observed by the
-- Director (it has no filesystem access). Record WHEN it was last reported so
-- git_list consumers can judge staleness instead of mistaking it for live HEAD.
SET @has_git_head_observed = (SELECT COUNT(*) FROM information_schema.columns
  WHERE table_schema = DATABASE() AND table_name = 'git_worktrees' AND column_name = 'head_observed_at');
SET @git_head_observed_ddl = IF(@has_git_head_observed = 0,
  'ALTER TABLE git_worktrees ADD COLUMN head_observed_at VARCHAR(100) NULL AFTER head_sha', 'SELECT 1');
PREPARE git_head_observed_stmt FROM @git_head_observed_ddl;
EXECUTE git_head_observed_stmt;
DEALLOCATE PREPARE git_head_observed_stmt;

-- Rows reported before this column existed: the head was last written at
-- register time, and heartbeat_at only bounds it from above, so the oldest
-- possible stamp (registered_at) is the conservative choice — it may
-- understate freshness, never overstate it.
UPDATE git_worktrees SET head_observed_at = registered_at
  WHERE head_sha IS NOT NULL AND head_observed_at IS NULL;
