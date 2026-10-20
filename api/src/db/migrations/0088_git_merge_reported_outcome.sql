-- Completion reports are unverified agent attestations, never inferred from lease state.

SET @git_report_outcome_exists = (SELECT COUNT(*) FROM information_schema.columns
  WHERE table_schema = DATABASE() AND table_name = 'git_merge_requests' AND column_name = 'reported_outcome');
SET @git_report_outcome_ddl = IF(@git_report_outcome_exists = 0,
  'ALTER TABLE git_merge_requests ADD COLUMN reported_outcome VARCHAR(16) NULL', 'SELECT 1');
PREPARE git_report_outcome_stmt FROM @git_report_outcome_ddl;
EXECUTE git_report_outcome_stmt;
DEALLOCATE PREPARE git_report_outcome_stmt;

SET @git_report_head_exists = (SELECT COUNT(*) FROM information_schema.columns
  WHERE table_schema = DATABASE() AND table_name = 'git_merge_requests' AND column_name = 'reported_target_head_sha');
SET @git_report_head_ddl = IF(@git_report_head_exists = 0,
  'ALTER TABLE git_merge_requests ADD COLUMN reported_target_head_sha VARCHAR(64) NULL', 'SELECT 1');
PREPARE git_report_head_stmt FROM @git_report_head_ddl;
EXECUTE git_report_head_stmt;
DEALLOCATE PREPARE git_report_head_stmt;

SET @git_report_at_exists = (SELECT COUNT(*) FROM information_schema.columns
  WHERE table_schema = DATABASE() AND table_name = 'git_merge_requests' AND column_name = 'outcome_reported_at');
SET @git_report_at_ddl = IF(@git_report_at_exists = 0,
  'ALTER TABLE git_merge_requests ADD COLUMN outcome_reported_at VARCHAR(100) NULL', 'SELECT 1');
PREPARE git_report_at_stmt FROM @git_report_at_ddl;
EXECUTE git_report_at_stmt;
DEALLOCATE PREPARE git_report_at_stmt;
