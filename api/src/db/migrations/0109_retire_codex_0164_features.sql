-- Codex 0.164.0 marks these exact feature flags removed. Preserve other
-- engines, literal map keys, sibling values, profile order and body/hash history.
UPDATE client_config_documents
SET settings = JSON_REMOVE(settings, '$.features.realtime_conversation', '$.features.stable_environment_tools', '$.features.worktrees', '$.native_settings.features.realtime_conversation', '$.native_settings.features.stable_environment_tools', '$.native_settings.features.worktrees')
WHERE engine = 'codex' AND JSON_CONTAINS_PATH(settings, 'one', '$.features.realtime_conversation', '$.features.stable_environment_tools', '$.features.worktrees', '$.native_settings.features.realtime_conversation', '$.native_settings.features.stable_environment_tools', '$.native_settings.features.worktrees');

DROP PROCEDURE IF EXISTS retire_codex_0164_profile_features;
DELIMITER //
CREATE PROCEDURE retire_codex_0164_profile_features()
BEGIN
  DECLARE profile_index INT DEFAULT 0;
  DECLARE profile_count INT DEFAULT 0;
  SELECT COALESCE(MAX(JSON_LENGTH(JSON_EXTRACT(settings, '$.profiles'))), 0)
    INTO profile_count FROM client_config_documents
    WHERE engine = 'codex' AND JSON_TYPE(JSON_EXTRACT(settings, '$.profiles')) = 'ARRAY';
  WHILE profile_index < profile_count DO
    UPDATE client_config_documents
    SET settings = JSON_REMOVE(settings, CONCAT('$.profiles[', profile_index, '].features.realtime_conversation'),
      CONCAT('$.profiles[', profile_index, '].features.stable_environment_tools'),
      CONCAT('$.profiles[', profile_index, '].features.worktrees'),
      CONCAT('$.profiles[', profile_index, '].native_settings.features.realtime_conversation'),
      CONCAT('$.profiles[', profile_index, '].native_settings.features.stable_environment_tools'),
      CONCAT('$.profiles[', profile_index, '].native_settings.features.worktrees'))
    WHERE engine = 'codex' AND JSON_TYPE(JSON_EXTRACT(settings, '$.profiles')) = 'ARRAY'
      AND JSON_CONTAINS_PATH(settings, 'one', CONCAT('$.profiles[', profile_index, '].features.realtime_conversation'),
        CONCAT('$.profiles[', profile_index, '].features.stable_environment_tools'),
        CONCAT('$.profiles[', profile_index, '].features.worktrees'),
        CONCAT('$.profiles[', profile_index, '].native_settings.features.realtime_conversation'),
        CONCAT('$.profiles[', profile_index, '].native_settings.features.stable_environment_tools'),
        CONCAT('$.profiles[', profile_index, '].native_settings.features.worktrees'));
    SET profile_index = profile_index + 1;
  END WHILE;
END//
DELIMITER ;
CALL retire_codex_0164_profile_features();
DROP PROCEDURE retire_codex_0164_profile_features;
