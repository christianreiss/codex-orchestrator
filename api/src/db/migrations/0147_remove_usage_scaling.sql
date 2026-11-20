-- Remove usage-based scaling (operator decision 2026-11-20).
--
-- The feature only ever stored and displayed its tiers: nothing applied a tier
-- and nothing read the per-host "always allowed" flag. This drops the flag
-- column and the stored tier rules. There is no `usage_scaling_rules` table; the
-- rules were one `versions` key.
--
-- DEPLOY CAVEAT: Drizzle emits explicit column lists, so the OUTGOING container
-- selects `hosts.scaling_exempt` on every host lookup and throws
-- ER_BAD_FIELD_ERROR once the column is gone. `scripts/deploy.sh` applies
-- migrations before the containers swap, so ship the build that no longer
-- references the column first and apply this file in a following deploy (the
-- same two-step procedure as 0017).
--
-- Idempotent: the DELETE is a no-op without the key, and the column drop is
-- guarded on information_schema.

DELETE FROM `versions` WHERE `name` = 'usage_scaling_rules';

DROP PROCEDURE IF EXISTS drop_hosts_scaling_exempt;
DELIMITER //
CREATE PROCEDURE drop_hosts_scaling_exempt()
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = DATABASE() AND table_name = 'hosts' AND column_name = 'scaling_exempt'
  ) THEN
    SET @drop_hosts_scaling_exempt_ddl = 'ALTER TABLE `hosts` DROP COLUMN `scaling_exempt`';
    PREPARE drop_hosts_scaling_exempt_stmt FROM @drop_hosts_scaling_exempt_ddl;
    EXECUTE drop_hosts_scaling_exempt_stmt;
    DEALLOCATE PREPARE drop_hosts_scaling_exempt_stmt;
  END IF;
END//
DELIMITER ;

CALL drop_hosts_scaling_exempt();
DROP PROCEDURE drop_hosts_scaling_exempt;
