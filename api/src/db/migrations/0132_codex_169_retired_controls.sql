-- Codex 0.169 removes legacy multi-agent/prefetch controls and auto-review
-- prompt overrides. Remove only exact authored paths; do not enable multi_agent_v2.
-- Preserve sibling values, other engines, literal map names and body/hash history.
-- Preserve legacy false before removing the flag: its native default is true.
-- Structured features take precedence; an explicit successor always wins.
UPDATE client_config_documents
SET settings = JSON_SET(settings, '$.native_settings',
  JSON_SET(CASE WHEN JSON_TYPE(JSON_EXTRACT(settings, '$.native_settings')) = 'OBJECT' THEN JSON_EXTRACT(settings, '$.native_settings') ELSE JSON_OBJECT() END, '$.agents',
    JSON_SET(COALESCE(JSON_EXTRACT(settings, '$.native_settings.agents'), JSON_OBJECT()), '$.enabled', CAST('false' AS JSON))))
WHERE engine = 'codex'
  AND COALESCE(NULLIF(JSON_UNQUOTE(JSON_EXTRACT(settings, '$.features.multi_agent')), 'null'),
    JSON_UNQUOTE(JSON_EXTRACT(settings, '$.native_settings.features.multi_agent'))) = 'false'
  AND NOT JSON_CONTAINS_PATH(settings, 'one', '$.native_settings.agents.enabled')
  AND (JSON_EXTRACT(settings, '$.native_settings') IS NULL OR JSON_TYPE(JSON_EXTRACT(settings, '$.native_settings')) IN ('OBJECT', 'NULL'))
  AND (JSON_EXTRACT(settings, '$.native_settings.agents') IS NULL OR JSON_TYPE(JSON_EXTRACT(settings, '$.native_settings.agents')) = 'OBJECT');

UPDATE client_config_documents
SET settings = JSON_REMOVE(settings,
  '$.features.multi_agent',
  '$.features.plugin_discovery_prefetch',
  '$.native_settings.features.multi_agent',
  '$.native_settings.features.plugin_discovery_prefetch',
  '$.native_settings.auto_review.experimental_policy_template',
  '$.native_settings.auto_review.extra_policy')
WHERE engine = 'codex' AND JSON_CONTAINS_PATH(settings, 'one',
  '$.features.multi_agent',
  '$.features.plugin_discovery_prefetch',
  '$.native_settings.features.multi_agent',
  '$.native_settings.features.plugin_discovery_prefetch',
  '$.native_settings.auto_review.experimental_policy_template',
  '$.native_settings.auto_review.extra_policy');

DROP PROCEDURE IF EXISTS retire_codex_0169_profile_controls;
DELIMITER //
CREATE PROCEDURE retire_codex_0169_profile_controls()
BEGIN
  DECLARE profile_index INT DEFAULT 0;
  DECLARE profile_count INT DEFAULT 0;
  SELECT COALESCE(MAX(JSON_LENGTH(JSON_EXTRACT(settings, '$.profiles'))), 0)
    INTO profile_count FROM client_config_documents
    WHERE engine = 'codex' AND JSON_TYPE(JSON_EXTRACT(settings, '$.profiles')) = 'ARRAY';
  WHILE profile_index < profile_count DO
    UPDATE client_config_documents
    SET settings = JSON_SET(settings, CONCAT('$.profiles[', profile_index, '].native_settings'),
      JSON_SET(CASE WHEN JSON_TYPE(JSON_EXTRACT(settings, CONCAT('$.profiles[', profile_index, '].native_settings'))) = 'OBJECT' THEN JSON_EXTRACT(settings, CONCAT('$.profiles[', profile_index, '].native_settings')) ELSE JSON_OBJECT() END, '$.agents',
        JSON_SET(COALESCE(JSON_EXTRACT(settings, CONCAT('$.profiles[', profile_index, '].native_settings.agents')), JSON_OBJECT()), '$.enabled', CAST('false' AS JSON))))
    WHERE engine = 'codex' AND JSON_TYPE(JSON_EXTRACT(settings, '$.profiles')) = 'ARRAY'
      AND COALESCE(NULLIF(JSON_UNQUOTE(JSON_EXTRACT(settings, CONCAT('$.profiles[', profile_index, '].features.multi_agent'))), 'null'),
        JSON_UNQUOTE(JSON_EXTRACT(settings, CONCAT('$.profiles[', profile_index, '].native_settings.features.multi_agent')))) = 'false'
      AND NOT JSON_CONTAINS_PATH(settings, 'one', CONCAT('$.profiles[', profile_index, '].native_settings.agents.enabled'))
      AND (JSON_EXTRACT(settings, CONCAT('$.profiles[', profile_index, '].native_settings')) IS NULL
        OR JSON_TYPE(JSON_EXTRACT(settings, CONCAT('$.profiles[', profile_index, '].native_settings'))) IN ('OBJECT', 'NULL'))
      AND (JSON_EXTRACT(settings, CONCAT('$.profiles[', profile_index, '].native_settings.agents')) IS NULL
        OR JSON_TYPE(JSON_EXTRACT(settings, CONCAT('$.profiles[', profile_index, '].native_settings.agents'))) = 'OBJECT');
    UPDATE client_config_documents
    SET settings = JSON_REMOVE(settings,
      CONCAT('$.profiles[', profile_index, '].features.multi_agent'),
      CONCAT('$.profiles[', profile_index, '].features.plugin_discovery_prefetch'),
      CONCAT('$.profiles[', profile_index, '].native_settings.features.multi_agent'),
      CONCAT('$.profiles[', profile_index, '].native_settings.features.plugin_discovery_prefetch'),
      CONCAT('$.profiles[', profile_index, '].native_settings.auto_review.experimental_policy_template'),
      CONCAT('$.profiles[', profile_index, '].native_settings.auto_review.extra_policy'))
    WHERE engine = 'codex' AND JSON_TYPE(JSON_EXTRACT(settings, '$.profiles')) = 'ARRAY'
      AND JSON_CONTAINS_PATH(settings, 'one',
      CONCAT('$.profiles[', profile_index, '].features.multi_agent'),
      CONCAT('$.profiles[', profile_index, '].features.plugin_discovery_prefetch'),
      CONCAT('$.profiles[', profile_index, '].native_settings.features.multi_agent'),
      CONCAT('$.profiles[', profile_index, '].native_settings.features.plugin_discovery_prefetch'),
      CONCAT('$.profiles[', profile_index, '].native_settings.auto_review.experimental_policy_template'),
      CONCAT('$.profiles[', profile_index, '].native_settings.auto_review.extra_policy'));
    SET profile_index = profile_index + 1;
  END WHILE;
END//
DELIMITER ;
CALL retire_codex_0169_profile_controls();
DROP PROCEDURE retire_codex_0169_profile_controls;
