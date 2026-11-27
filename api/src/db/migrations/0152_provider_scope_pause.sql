-- Pause, switch, resume: the server asks every session of a scope to hold
-- itself at its hooks so that a pending account switch gets its quiet moment.
-- pause_capable is per lease (the session proved that its hooks run).
-- pause_round, pause_deadline and pause_ready_at are scope-wide like the
-- desired_* columns; pause_state and pause_reported_at are what this lease
-- reported for the round. All are cleared when the round ends.

SET @pas_pause_capable_exists=(SELECT COUNT(*) FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='provider_account_sessions' AND column_name='pause_capable');
SET @pas_pause_capable_ddl=IF(@pas_pause_capable_exists=0,'ALTER TABLE provider_account_sessions ADD COLUMN pause_capable TINYINT(1) NOT NULL DEFAULT 0','SELECT 1');
PREPARE pas_pause_capable_stmt FROM @pas_pause_capable_ddl;
EXECUTE pas_pause_capable_stmt;
DEALLOCATE PREPARE pas_pause_capable_stmt;

SET @pas_pause_round_exists=(SELECT COUNT(*) FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='provider_account_sessions' AND column_name='pause_round');
SET @pas_pause_round_ddl=IF(@pas_pause_round_exists=0,'ALTER TABLE provider_account_sessions ADD COLUMN pause_round VARCHAR(36) NULL','SELECT 1');
PREPARE pas_pause_round_stmt FROM @pas_pause_round_ddl;
EXECUTE pas_pause_round_stmt;
DEALLOCATE PREPARE pas_pause_round_stmt;

SET @pas_pause_deadline_exists=(SELECT COUNT(*) FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='provider_account_sessions' AND column_name='pause_deadline');
SET @pas_pause_deadline_ddl=IF(@pas_pause_deadline_exists=0,'ALTER TABLE provider_account_sessions ADD COLUMN pause_deadline VARCHAR(100) NULL','SELECT 1');
PREPARE pas_pause_deadline_stmt FROM @pas_pause_deadline_ddl;
EXECUTE pas_pause_deadline_stmt;
DEALLOCATE PREPARE pas_pause_deadline_stmt;

SET @pas_pause_state_exists=(SELECT COUNT(*) FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='provider_account_sessions' AND column_name='pause_state');
SET @pas_pause_state_ddl=IF(@pas_pause_state_exists=0,'ALTER TABLE provider_account_sessions ADD COLUMN pause_state VARCHAR(16) NULL','SELECT 1');
PREPARE pas_pause_state_stmt FROM @pas_pause_state_ddl;
EXECUTE pas_pause_state_stmt;
DEALLOCATE PREPARE pas_pause_state_stmt;

SET @pas_pause_reported_at_exists=(SELECT COUNT(*) FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='provider_account_sessions' AND column_name='pause_reported_at');
SET @pas_pause_reported_at_ddl=IF(@pas_pause_reported_at_exists=0,'ALTER TABLE provider_account_sessions ADD COLUMN pause_reported_at VARCHAR(100) NULL','SELECT 1');
PREPARE pas_pause_reported_at_stmt FROM @pas_pause_reported_at_ddl;
EXECUTE pas_pause_reported_at_stmt;
DEALLOCATE PREPARE pas_pause_reported_at_stmt;

SET @pas_pause_ready_at_exists=(SELECT COUNT(*) FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='provider_account_sessions' AND column_name='pause_ready_at');
SET @pas_pause_ready_at_ddl=IF(@pas_pause_ready_at_exists=0,'ALTER TABLE provider_account_sessions ADD COLUMN pause_ready_at VARCHAR(100) NULL','SELECT 1');
PREPARE pas_pause_ready_at_stmt FROM @pas_pause_ready_at_ddl;
EXECUTE pas_pause_ready_at_stmt;
DEALLOCATE PREPARE pas_pause_ready_at_stmt;
