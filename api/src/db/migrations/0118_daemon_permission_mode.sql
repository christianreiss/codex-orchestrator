-- Android Companion R4 / plan mode: each host daemon session may pin a native
-- permission mode. NULL or 'default' means no flag: the host's posture-clamped
-- settings apply. 'plan' passes the native plan mode on every turn until the
-- operator approves the plan (POST .../permission-mode), which stores 'default'.
SET @has_daemon_permission_mode = (SELECT COUNT(*) FROM information_schema.columns
 WHERE table_schema = DATABASE() AND table_name = 'host_daemon_sessions' AND column_name = 'permission_mode');
SET @daemon_permission_mode_ddl = IF(@has_daemon_permission_mode = 0,
 'ALTER TABLE host_daemon_sessions ADD COLUMN permission_mode VARCHAR(16) NULL', 'SELECT 1');
PREPARE daemon_permission_mode_stmt FROM @daemon_permission_mode_ddl;
EXECUTE daemon_permission_mode_stmt;
DEALLOCATE PREPARE daemon_permission_mode_stmt;
