-- Explicit operator consolidation keeps old wrapper IDs as compatibility aliases.
-- This migration never guesses which accounts belong to the same subscription.
SET @account_merge_ddl = IF(EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='provider_accounts' AND column_name='merged_into_account_id'), 'SELECT 1', 'ALTER TABLE provider_accounts ADD COLUMN merged_into_account_id BIGINT UNSIGNED NULL');
PREPARE account_merge_stmt FROM @account_merge_ddl;
EXECUTE account_merge_stmt;
DEALLOCATE PREPARE account_merge_stmt;
