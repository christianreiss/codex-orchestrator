-- Multiple assignments per launch preserve provisional picker-name history.
-- One atomic ALTER also survives a retry after implicit DDL commit.
SET @resume_names_id = (SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'agent_name_leases' AND column_name = 'id');
SET @resume_names_ddl = IF(@resume_names_id = 0, 'ALTER TABLE agent_name_leases DROP PRIMARY KEY, ADD COLUMN id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY FIRST', 'SELECT 1');
PREPARE resume_names_stmt FROM @resume_names_ddl;
EXECUTE resume_names_stmt;
DEALLOCATE PREPARE resume_names_stmt;
SET @resume_names_index = (SELECT COUNT(*) FROM information_schema.statistics WHERE table_schema = DATABASE() AND table_name = 'agent_name_leases' AND index_name = 'idx_agent_name_leases_session');
SET @resume_names_ddl = IF(@resume_names_index = 0, 'CREATE INDEX idx_agent_name_leases_session ON agent_name_leases (session_id, id)', 'SELECT 1');
PREPARE resume_names_stmt FROM @resume_names_ddl;
EXECUTE resume_names_stmt;
DEALLOCATE PREPARE resume_names_stmt;
