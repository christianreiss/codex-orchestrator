-- Retire outstanding attention tasks while retaining the original chat events.
UPDATE agent_chat_notices
SET resolved_at = DATE_FORMAT(UTC_TIMESTAMP(3), '%Y-%m-%dT%H:%i:%s.%fZ')
WHERE resolved_at IS NULL;
