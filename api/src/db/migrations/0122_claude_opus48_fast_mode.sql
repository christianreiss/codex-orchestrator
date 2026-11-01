-- Opus 4.8 remains active, but its fast mode was deprecated on 2026-10-30
-- and is removed on 2026-11-30 (Claude Code 2.1.316 release notes).
-- Keep the chosen model and explicit ownership of the disabled mode. Touch
-- only an actual true boolean on the two known native model spellings;
-- custom providers, siblings and historical body/hash/timestamps survive.
UPDATE client_config_documents
SET settings = JSON_SET(settings, '$.native_settings.fastMode', CAST('false' AS JSON))
WHERE engine = 'claude' AND JSON_TYPE(settings) = 'OBJECT'
  AND LOWER(TRIM(JSON_UNQUOTE(JSON_EXTRACT(settings, '$.model'))))
    IN ('claude-opus-4-8', 'claude-opus-4-8[1m]')
  AND JSON_TYPE(JSON_EXTRACT(settings, '$.native_settings.fastMode')) = 'BOOLEAN'
  AND JSON_EXTRACT(settings, '$.native_settings.fastMode') = CAST('true' AS JSON);
