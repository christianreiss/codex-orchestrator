-- Fleet Advisor v2: the advisor container is a server-owned host that no
-- listing shows or counts, and each daemon session pins its native model.
SET @has_internal_role = (SELECT COUNT(*) FROM information_schema.columns
 WHERE table_schema = DATABASE() AND table_name = 'hosts' AND column_name = 'internal_role');
SET @internal_role_ddl = IF(@has_internal_role = 0,
 'ALTER TABLE hosts ADD COLUMN internal_role VARCHAR(24) NULL', 'SELECT 1');
PREPARE internal_role_stmt FROM @internal_role_ddl;
EXECUTE internal_role_stmt;
DEALLOCATE PREPARE internal_role_stmt;
SET @has_daemon_model = (SELECT COUNT(*) FROM information_schema.columns
 WHERE table_schema = DATABASE() AND table_name = 'host_daemon_sessions' AND column_name = 'model');
SET @daemon_model_ddl = IF(@has_daemon_model = 0,
 'ALTER TABLE host_daemon_sessions ADD COLUMN model VARCHAR(128) NULL', 'SELECT 1');
PREPARE daemon_model_stmt FROM @daemon_model_ddl;
EXECUTE daemon_model_stmt;
DEALLOCATE PREPARE daemon_model_stmt;
