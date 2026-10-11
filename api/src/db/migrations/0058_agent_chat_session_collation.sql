-- Rich-chat tables created by 0057 inherit the database default, which can
-- differ from older Portal session IDs. Match the referenced ID column rather
-- than assuming an installation-wide default. Only session IDs need changing.
SET @agent_chat_session_charset = (SELECT CHARACTER_SET_NAME FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='agent_sessions' AND COLUMN_NAME='id');
SET @agent_chat_session_collation = (SELECT COLLATION_NAME FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='agent_sessions' AND COLUMN_NAME='id');

SET @agent_chat_session_ddl = IF((SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='agent_chat_attachments' AND COLUMN_NAME='session_id'
    AND CHARACTER_SET_NAME=@agent_chat_session_charset AND COLLATION_NAME=@agent_chat_session_collation)=0,
  CONCAT('ALTER TABLE agent_chat_attachments MODIFY COLUMN session_id CHAR(36) CHARACTER SET ',
    @agent_chat_session_charset, ' COLLATE ', @agent_chat_session_collation, ' NOT NULL'), 'SELECT 1');
PREPARE agent_chat_session_stmt FROM @agent_chat_session_ddl;
EXECUTE agent_chat_session_stmt;
DEALLOCATE PREPARE agent_chat_session_stmt;

SET @agent_chat_session_ddl = IF((SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='agent_chat_notices' AND COLUMN_NAME='session_id'
    AND CHARACTER_SET_NAME=@agent_chat_session_charset AND COLLATION_NAME=@agent_chat_session_collation)=0,
  CONCAT('ALTER TABLE agent_chat_notices MODIFY COLUMN session_id CHAR(36) CHARACTER SET ',
    @agent_chat_session_charset, ' COLLATE ', @agent_chat_session_collation, ' NOT NULL'), 'SELECT 1');
PREPARE agent_chat_session_stmt FROM @agent_chat_session_ddl;
EXECUTE agent_chat_session_stmt;
DEALLOCATE PREPARE agent_chat_session_stmt;
