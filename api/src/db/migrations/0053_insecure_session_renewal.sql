-- Manual closure fences automatic session renewal until explicit approval.
SET @has_renewal_fence = (SELECT COUNT(*) FROM information_schema.columns
  WHERE table_schema = DATABASE() AND table_name = 'hosts' AND column_name = 'insecure_session_renewal_blocked');
SET @renewal_fence_ddl = IF(@has_renewal_fence = 0,
  'ALTER TABLE hosts ADD COLUMN insecure_session_renewal_blocked TINYINT NOT NULL DEFAULT 0', 'SELECT 1');
PREPARE renewal_fence_stmt FROM @renewal_fence_ddl;
EXECUTE renewal_fence_stmt;
DEALLOCATE PREPARE renewal_fence_stmt;
