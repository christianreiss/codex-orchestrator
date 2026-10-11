CREATE TABLE IF NOT EXISTS agent_chat_attachments (
 id CHAR(36) NOT NULL PRIMARY KEY, session_id CHAR(36) NOT NULL,
 owner VARCHAR(80) NOT NULL, metadata_enc LONGTEXT NOT NULL,
 size_bytes BIGINT UNSIGNED NOT NULL, uploaded_bytes BIGINT UNSIGNED NOT NULL DEFAULT 0,
 sha256 CHAR(64) NULL, status VARCHAR(16) NOT NULL DEFAULT 'uploading',
 created_at VARCHAR(100) NOT NULL, updated_at VARCHAR(100) NOT NULL,
 INDEX idx_agent_chat_attachments_session (session_id, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS agent_chat_notices (
 id CHAR(36) NOT NULL PRIMARY KEY, session_id CHAR(36) NOT NULL,
 severity VARCHAR(16) NOT NULL, payload_enc LONGTEXT NOT NULL, event_id BIGINT UNSIGNED NOT NULL,
 resolved_at VARCHAR(100) NULL, created_at VARCHAR(100) NOT NULL,
 INDEX idx_agent_chat_notices_session (session_id, resolved_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
SET @s = IF((SELECT COUNT(*) FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='agent_prompts' AND column_name='answer_mode')=0,
 'ALTER TABLE agent_prompts ADD COLUMN answer_mode VARCHAR(16) NOT NULL DEFAULT ''both''', 'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;
SET @s = IF((SELECT COUNT(*) FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='agent_prompts' AND column_name='choices_enc')=0,
 'ALTER TABLE agent_prompts ADD COLUMN choices_enc LONGTEXT NULL', 'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;
SET @s = IF((SELECT COUNT(*) FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='agent_messages' AND column_name='metadata_enc')=0,
 'ALTER TABLE agent_messages ADD COLUMN metadata_enc LONGTEXT NULL', 'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;
