-- Every /auth reads the latest Codex and Claude quota snapshot for one account
-- (WHERE account_id = ? ORDER BY fetched_at DESC, id DESC LIMIT 1). The only
-- usable index led with fetched_at, so an account without snapshots (every
-- Grok account, and the other engine's account on each call) scanned the whole
-- history: 14,431 and 10,477 rows per call, about 49 ms/s of MySQL time in
-- production on 2026-10-23 (feedback d5804868).
SET @idx_exists=(SELECT COUNT(*) FROM information_schema.statistics WHERE table_schema=DATABASE() AND table_name='chatgpt_usage_snapshots' AND index_name='idx_chatgpt_usage_account_fetched');
SET @ddl=IF(@idx_exists=0,'CREATE INDEX idx_chatgpt_usage_account_fetched ON chatgpt_usage_snapshots (account_id, fetched_at, id)','SELECT 1');
PREPARE quota_snapshot_stmt FROM @ddl;
EXECUTE quota_snapshot_stmt;
DEALLOCATE PREPARE quota_snapshot_stmt;

SET @idx_exists=(SELECT COUNT(*) FROM information_schema.statistics WHERE table_schema=DATABASE() AND table_name='claude_usage_snapshots' AND index_name='idx_claude_usage_account_fetched');
SET @ddl=IF(@idx_exists=0,'CREATE INDEX idx_claude_usage_account_fetched ON claude_usage_snapshots (account_id, fetched_at, id)','SELECT 1');
PREPARE quota_snapshot_stmt FROM @ddl;
EXECUTE quota_snapshot_stmt;
DEALLOCATE PREPARE quota_snapshot_stmt;
