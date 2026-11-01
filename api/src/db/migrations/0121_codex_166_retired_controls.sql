-- Codex 0.166 removes code_mode_tool_description_first and ignores Guardian's
-- async_classifier_mode. Remove only those exact authored paths. Keep other
-- engines, literal map names, profile order and historical body/hash snapshots.
UPDATE client_config_documents
SET settings = JSON_REMOVE(settings,
  '$.features.code_mode_tool_description_first',
  '$.features.guardianv2.async_classifier_mode',
  '$.native_settings.features.code_mode_tool_description_first',
  '$.native_settings.features.guardianv2.async_classifier_mode')
WHERE engine = 'codex' AND JSON_CONTAINS_PATH(settings, 'one',
  '$.features.code_mode_tool_description_first',
  '$.features.guardianv2.async_classifier_mode',
  '$.native_settings.features.code_mode_tool_description_first',
  '$.native_settings.features.guardianv2.async_classifier_mode');

DROP PROCEDURE IF EXISTS retire_codex_0166_profile_controls;
DELIMITER //
CREATE PROCEDURE retire_codex_0166_profile_controls()
BEGIN
  DECLARE profile_index INT DEFAULT 0;
  DECLARE profile_count INT DEFAULT 0;
  SELECT COALESCE(MAX(JSON_LENGTH(JSON_EXTRACT(settings, '$.profiles'))), 0)
    INTO profile_count FROM client_config_documents
    WHERE engine = 'codex' AND JSON_TYPE(JSON_EXTRACT(settings, '$.profiles')) = 'ARRAY';
  WHILE profile_index < profile_count DO
    UPDATE client_config_documents
    SET settings = JSON_REMOVE(settings,
      CONCAT('$.profiles[', profile_index, '].features.code_mode_tool_description_first'),
      CONCAT('$.profiles[', profile_index, '].features.guardianv2.async_classifier_mode'),
      CONCAT('$.profiles[', profile_index, '].native_settings.features.code_mode_tool_description_first'),
      CONCAT('$.profiles[', profile_index, '].native_settings.features.guardianv2.async_classifier_mode'))
    WHERE engine = 'codex' AND JSON_TYPE(JSON_EXTRACT(settings, '$.profiles')) = 'ARRAY'
      AND JSON_CONTAINS_PATH(settings, 'one',
        CONCAT('$.profiles[', profile_index, '].features.code_mode_tool_description_first'),
        CONCAT('$.profiles[', profile_index, '].features.guardianv2.async_classifier_mode'),
        CONCAT('$.profiles[', profile_index, '].native_settings.features.code_mode_tool_description_first'),
        CONCAT('$.profiles[', profile_index, '].native_settings.features.guardianv2.async_classifier_mode'));
    SET profile_index = profile_index + 1;
  END WHILE;
END//
DELIMITER ;
CALL retire_codex_0166_profile_controls();
DROP PROCEDURE retire_codex_0166_profile_controls;
