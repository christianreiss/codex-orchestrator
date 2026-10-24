-- Compatible readers deploy before the policy is armed. Existing receipts remain legacy.
SET @has_column=(SELECT COUNT(*) FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='control_plane_command_receipts' AND column_name='replay_class');
SET @ddl=IF(@has_column=0,"ALTER TABLE control_plane_command_receipts ADD COLUMN replay_class VARCHAR(16) NOT NULL DEFAULT 'legacy'",'SELECT 1');
PREPARE retention_stmt FROM @ddl; EXECUTE retention_stmt; DEALLOCATE PREPARE retention_stmt;
SET @has_column=(SELECT COUNT(*) FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='control_plane_command_receipts' AND column_name='result_state');
SET @ddl=IF(@has_column=0,"ALTER TABLE control_plane_command_receipts ADD COLUMN result_state VARCHAR(16) NOT NULL DEFAULT 'available'",'SELECT 1');
PREPARE retention_stmt FROM @ddl; EXECUTE retention_stmt; DEALLOCATE PREPARE retention_stmt;
ALTER TABLE control_plane_command_receipts MODIFY COLUMN result_enc LONGTEXT NULL;
SET @has_index=(SELECT COUNT(*) FROM information_schema.statistics WHERE table_schema=DATABASE() AND table_name='control_plane_command_receipts' AND index_name='command_receipts_retention');
SET @ddl=IF(@has_index=0,'CREATE INDEX command_receipts_retention ON control_plane_command_receipts(created_at)','SELECT 1');
PREPARE retention_stmt FROM @ddl; EXECUTE retention_stmt; DEALLOCATE PREPARE retention_stmt;
-- The exclusive bootstrap seeds the missing policy from the current portal retention environment.
