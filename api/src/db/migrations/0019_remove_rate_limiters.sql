-- Remove every database artifact used by orchestrator-enforced request rate
-- limiting. The API no longer reads or writes the counter table and API keys
-- no longer carry a per-minute request budget.
--
-- DEPLOY CAVEAT -- DO NOT SHIP THIS MIGRATION IN THE SAME STEP AS THE CODE.
-- `scripts/deploy.sh` applies migrations before replacing the outgoing API
-- container. The old build still selects `rate_limit_rpm` and writes
-- `ip_rate_limits`, so use the repository's two-step destructive-column
-- rollout: first deploy the code without this file, then deploy this migration
-- after every API instance runs the limiter-free build.

DROP TABLE IF EXISTS ip_rate_limits;

-- MySQL has no portable `DROP COLUMN IF EXISTS`, so guard on
-- information_schema. Re-applying this migration is a no-op.
DROP PROCEDURE IF EXISTS drop_rate_limit_column;
DELIMITER //
CREATE PROCEDURE drop_rate_limit_column(IN p_table_name VARCHAR(191), IN p_column_name VARCHAR(191))
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = DATABASE() AND table_name = p_table_name AND column_name = p_column_name
  ) THEN
    SET @drop_rate_limit_ddl = CONCAT('ALTER TABLE `', p_table_name, '` DROP COLUMN `', p_column_name, '`');
    PREPARE drop_rate_limit_stmt FROM @drop_rate_limit_ddl;
    EXECUTE drop_rate_limit_stmt;
    DEALLOCATE PREPARE drop_rate_limit_stmt;
  END IF;
END//
DELIMITER ;

CALL drop_rate_limit_column('openai_api_keys', 'rate_limit_rpm');
DROP PROCEDURE drop_rate_limit_column;
