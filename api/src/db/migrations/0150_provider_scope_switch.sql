-- Live account switching: every lease of one (host, engine, scope) carries the
-- scope's binding generation and an optional pending switch request. The
-- generation increments on every account change; wrappers fence stale
-- requests with it. bound_at records when the scope last changed account
-- (minimum dwell before automatic rebalancing).
SET @pas_gen_exists=(SELECT COUNT(*) FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='provider_account_sessions' AND column_name='binding_generation');
SET @pas_gen_ddl=IF(@pas_gen_exists=0,'ALTER TABLE provider_account_sessions ADD COLUMN binding_generation INT UNSIGNED NOT NULL DEFAULT 1','SELECT 1');
PREPARE pas_gen_stmt FROM @pas_gen_ddl;
EXECUTE pas_gen_stmt;
DEALLOCATE PREPARE pas_gen_stmt;

SET @pas_desired_exists=(SELECT COUNT(*) FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='provider_account_sessions' AND column_name='desired_account_id');
SET @pas_desired_ddl=IF(@pas_desired_exists=0,'ALTER TABLE provider_account_sessions ADD COLUMN desired_account_id BIGINT UNSIGNED NULL','SELECT 1');
PREPARE pas_desired_stmt FROM @pas_desired_ddl;
EXECUTE pas_desired_stmt;
DEALLOCATE PREPARE pas_desired_stmt;

SET @pas_reason_exists=(SELECT COUNT(*) FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='provider_account_sessions' AND column_name='desired_reason');
SET @pas_reason_ddl=IF(@pas_reason_exists=0,'ALTER TABLE provider_account_sessions ADD COLUMN desired_reason VARCHAR(16) NULL','SELECT 1');
PREPARE pas_reason_stmt FROM @pas_reason_ddl;
EXECUTE pas_reason_stmt;
DEALLOCATE PREPARE pas_reason_stmt;

SET @pas_desired_at_exists=(SELECT COUNT(*) FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='provider_account_sessions' AND column_name='desired_at');
SET @pas_desired_at_ddl=IF(@pas_desired_at_exists=0,'ALTER TABLE provider_account_sessions ADD COLUMN desired_at VARCHAR(100) NULL','SELECT 1');
PREPARE pas_desired_at_stmt FROM @pas_desired_at_ddl;
EXECUTE pas_desired_at_stmt;
DEALLOCATE PREPARE pas_desired_at_stmt;

SET @pas_bound_exists=(SELECT COUNT(*) FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='provider_account_sessions' AND column_name='bound_at');
SET @pas_bound_ddl=IF(@pas_bound_exists=0,'ALTER TABLE provider_account_sessions ADD COLUMN bound_at VARCHAR(100) NULL','SELECT 1');
PREPARE pas_bound_stmt FROM @pas_bound_ddl;
EXECUTE pas_bound_stmt;
DEALLOCATE PREPARE pas_bound_stmt;
