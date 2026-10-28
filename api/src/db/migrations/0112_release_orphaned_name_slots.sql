-- Address retention deleted old name leases and sessions but left the launch-name
-- pool slot pointing at the deleted session, so a slot stayed "taken" forever and
-- the pool ran dry (every launch failed with agent_name_pool_exhausted). Release
-- exactly the slots whose current session and lease no longer exist. Slots held by
-- a live session or an unexpired/ended lease are untouched. Safe to run twice.
UPDATE agent_name_pool p
LEFT JOIN agent_name_leases l ON l.name_key = p.name_key AND l.session_id = p.current_session_id
LEFT JOIN agent_sessions s ON s.id = p.current_session_id
SET p.current_session_id = NULL
WHERE p.current_session_id IS NOT NULL AND l.id IS NULL AND s.id IS NULL;
