-- Coordination tables can inherit a newer database default than Portal sessions.
-- Align only their session references; retain every other column's collation/data.
SET @scope_session_charset = (SELECT CHARACTER_SET_NAME FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='agent_sessions' AND COLUMN_NAME='id');
SET @scope_session_collation = (SELECT COLLATION_NAME FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='agent_sessions' AND COLUMN_NAME='id');

SET @scope_session_ddl = IF((SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='agent_scope_members' AND COLUMN_NAME='session_id'
    AND CHARACTER_SET_NAME=@scope_session_charset AND COLLATION_NAME=@scope_session_collation)=0,
  CONCAT('ALTER TABLE agent_scope_members MODIFY COLUMN session_id CHAR(36) CHARACTER SET ',
    @scope_session_charset, ' COLLATE ', @scope_session_collation, ' NOT NULL'), 'SELECT 1');
PREPARE scope_session_stmt FROM @scope_session_ddl;
EXECUTE scope_session_stmt;
DEALLOCATE PREPARE scope_session_stmt;

SET @scope_session_ddl = IF((SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='agent_resource_claims' AND COLUMN_NAME='session_id'
    AND CHARACTER_SET_NAME=@scope_session_charset AND COLLATION_NAME=@scope_session_collation)=0,
  CONCAT('ALTER TABLE agent_resource_claims MODIFY COLUMN session_id CHAR(36) CHARACTER SET ',
    @scope_session_charset, ' COLLATE ', @scope_session_collation, ' NOT NULL'), 'SELECT 1');
PREPARE scope_session_stmt FROM @scope_session_ddl;
EXECUTE scope_session_stmt;
DEALLOCATE PREPARE scope_session_stmt;
