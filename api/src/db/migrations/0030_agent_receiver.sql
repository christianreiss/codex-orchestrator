-- Connection-specific receiver proof; ordinary session heartbeats cannot renew it.
SET @receiver_sql = IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'agent_sessions' AND COLUMN_NAME = 'receiver') = 0,
  'ALTER TABLE agent_sessions ADD COLUMN receiver JSON NULL', 'SELECT 1');
PREPARE receiver_stmt FROM @receiver_sql;
EXECUTE receiver_stmt;
DEALLOCATE PREPARE receiver_stmt;
