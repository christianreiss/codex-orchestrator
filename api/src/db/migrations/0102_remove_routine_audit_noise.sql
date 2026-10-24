-- Current host versions and durable message lifecycle rows already retain these
-- facts. Remove redundant successful-operation copies; retain auth changes,
-- administrative actions and failed/ambiguous delivery audit records.
DELETE FROM logs
WHERE action IN ('cron.update_reported', 'cron.update_available',
                 'agent_message.delivery', 'agent_message.completed');
