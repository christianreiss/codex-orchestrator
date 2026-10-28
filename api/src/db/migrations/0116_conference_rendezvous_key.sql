-- Atomic open-or-join for conferences (feedback da5e43bf). A room opened with
-- join_existing carries a rendezvous key: sha256 of the opener's repository
-- identity and the normalized topic. The UNIQUE index is what makes two agents
-- that race to open the same topic end up in one room: the loser's INSERT fails
-- and its retry joins the winner. NULL for every ordinary room, and MySQL permits
-- any number of NULLs in a UNIQUE index, so default behavior is untouched.
-- The key is cleared (not the row deleted) once the room is no longer open, the
-- same way pin is released. Additive and idempotent.
SET @conf_rdv_col = (SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'agent_bus_conferences' AND column_name = 'rendezvous_key');
SET @conf_rdv_col_ddl = IF(@conf_rdv_col = 0, 'ALTER TABLE agent_bus_conferences ADD COLUMN rendezvous_key CHAR(64) NULL', 'SELECT 1');
PREPARE conf_rdv_col_stmt FROM @conf_rdv_col_ddl;
EXECUTE conf_rdv_col_stmt;
DEALLOCATE PREPARE conf_rdv_col_stmt;
SET @conf_rdv_idx = (SELECT COUNT(*) FROM information_schema.statistics WHERE table_schema = DATABASE() AND table_name = 'agent_bus_conferences' AND index_name = 'uq_agent_bus_conferences_rendezvous');
SET @conf_rdv_idx_ddl = IF(@conf_rdv_idx = 0, 'ALTER TABLE agent_bus_conferences ADD UNIQUE KEY uq_agent_bus_conferences_rendezvous (rendezvous_key)', 'SELECT 1');
PREPARE conf_rdv_idx_stmt FROM @conf_rdv_idx_ddl;
EXECUTE conf_rdv_idx_stmt;
DEALLOCATE PREPARE conf_rdv_idx_stmt;
