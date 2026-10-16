-- Codex 0.163.0 removed shell_zsh_fork. Clean saved settings before the strict
-- authoring boundary sees them. Do not touch literal dotted map keys, other
-- engines, siblings, profile order, auth or historical body/digest evidence.
-- Host config and sidecars are rendered anew from these migrated settings.
UPDATE client_config_documents
SET settings = JSON_REMOVE(settings, '$.features.shell_zsh_fork', '$.native_settings.features.shell_zsh_fork')
WHERE engine = 'codex' AND JSON_CONTAINS_PATH(settings, 'one', '$.features.shell_zsh_fork', '$.native_settings.features.shell_zsh_fork');

DROP PROCEDURE IF EXISTS retire_codex_profile_shell_zsh_fork;
DELIMITER //
CREATE PROCEDURE retire_codex_profile_shell_zsh_fork()
BEGIN
  DECLARE profile_index INT DEFAULT 0;
  DECLARE profile_count INT DEFAULT 0;
  SELECT COALESCE(MAX(JSON_LENGTH(JSON_EXTRACT(settings, '$.profiles'))), 0)
    INTO profile_count FROM client_config_documents
    WHERE engine = 'codex' AND JSON_TYPE(JSON_EXTRACT(settings, '$.profiles')) = 'ARRAY';
  WHILE profile_index < profile_count DO
    UPDATE client_config_documents
    SET settings = JSON_REMOVE(settings,
      CONCAT('$.profiles[', profile_index, '].features.shell_zsh_fork'),
      CONCAT('$.profiles[', profile_index, '].native_settings.features.shell_zsh_fork'))
    WHERE engine = 'codex' AND JSON_TYPE(JSON_EXTRACT(settings, '$.profiles')) = 'ARRAY'
      AND JSON_CONTAINS_PATH(settings, 'one',
        CONCAT('$.profiles[', profile_index, '].features.shell_zsh_fork'),
        CONCAT('$.profiles[', profile_index, '].native_settings.features.shell_zsh_fork'));
    SET profile_index = profile_index + 1;
  END WHILE;
END//
DELIMITER ;
CALL retire_codex_profile_shell_zsh_fork();
DROP PROCEDURE retire_codex_profile_shell_zsh_fork;
