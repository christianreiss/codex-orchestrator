-- Invitations are reservations, not confirmed joins. Keep historic timestamps intact.
SET @ddl := IF((SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='agent_bus_conference_members'
    AND COLUMN_NAME='joined_at' AND IS_NULLABLE='NO') > 0,
  'ALTER TABLE agent_bus_conference_members MODIFY COLUMN joined_at VARCHAR(100) NULL',
  'SELECT 1');
PREPARE conference_join FROM @ddl;
EXECUTE conference_join;
DEALLOCATE PREPARE conference_join;
