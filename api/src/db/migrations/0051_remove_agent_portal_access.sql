-- Retire the /go magic-link webchat. Shared sessions and admin/Android authors stay.
-- portal_user_id remains empty for historical migration replay; it is not an identity.
UPDATE agent_prompts p
JOIN agent_messages m ON m.message_id = p.answer_message_id
SET p.status = 'expired', p.answered_by_user_id = NULL, p.answer_message_id = NULL,
    p.answered_at = NULL, p.version = p.version + 1,
    p.expires_at = DATE_FORMAT(UTC_TIMESTAMP(3), '%Y-%m-%dT%H:%i:%s.%fZ')
WHERE m.portal_user_id IS NOT NULL;

DELETE e FROM agent_events e
JOIN agent_messages m ON e.session_id = m.session_id
  AND (e.client_event_id = CONCAT('portal:', m.message_id)
       OR e.client_event_id = CONCAT('portal:close:', m.message_id))
WHERE m.portal_user_id IS NOT NULL;

DELETE FROM agent_messages WHERE portal_user_id IS NOT NULL;
DROP TABLE IF EXISTS agent_portal_browser_sessions;
DROP TABLE IF EXISTS agent_portal_users;
