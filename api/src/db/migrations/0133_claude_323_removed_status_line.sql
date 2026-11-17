-- Claude Code 2.1.323 removed subagentStatusLine; its parser still loads it
-- but there is no consumer. Strip only the actual authored native root leaf.
-- Preserve siblings, literal map keys, other engines and historical body/hash.
UPDATE client_config_documents
SET settings = JSON_REMOVE(settings, '$.native_settings.subagentStatusLine')
WHERE engine = 'claude'
  AND JSON_TYPE(JSON_EXTRACT(settings, '$.native_settings')) = 'OBJECT'
  AND JSON_CONTAINS_PATH(settings, 'one', '$.native_settings.subagentStatusLine');
