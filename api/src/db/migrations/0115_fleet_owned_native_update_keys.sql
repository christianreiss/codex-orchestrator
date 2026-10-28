-- Native updater policy is fleet-owned: managed launches disable the native
-- updaters and refuse native install/update, so these stored keys either do
-- nothing or (Grok cli.required_*_version) stop every managed launch. Grok
-- compat.<vendor>.sessions is staged upstream with no consumer. New input now
-- rejects all of them; remove only these exact paths from root and
-- version-override layers. Unrelated siblings, other engines and historical
-- body/sha256 snapshots stay unchanged; host renders and admin previews derive
-- current output from the migrated settings. Grok features.zdr_access_enabled
-- is deliberately kept: it still works below 1.0.64 and is gated per host.
UPDATE client_config_documents
SET settings = JSON_REMOVE(settings, '$.native_settings.minimumVersion')
WHERE engine = 'claude' AND JSON_TYPE(settings) = 'OBJECT'
  AND JSON_CONTAINS_PATH(settings, 'one', '$.native_settings.minimumVersion');

DROP PROCEDURE IF EXISTS migrate_fleet_owned_grok_update_keys;
DELIMITER $$
CREATE PROCEDURE migrate_fleet_owned_grok_update_keys()
BEGIN
  DECLARE finished BOOLEAN DEFAULT FALSE;
  DECLARE document_id BIGINT UNSIGNED;
  DECLARE original_settings JSON;
  DECLARE migrated_settings JSON;
  DECLARE layer_prefix VARCHAR(128);
  DECLARE layer_index INT;
  DECLARE layer_count INT;
  DECLARE documents CURSOR FOR SELECT id, settings FROM client_config_documents
    WHERE engine = 'grok' AND JSON_TYPE(settings) = 'OBJECT';
  DECLARE CONTINUE HANDLER FOR NOT FOUND SET finished = TRUE;
  OPEN documents;
  documents_loop: LOOP
    FETCH documents INTO document_id, original_settings;
    IF finished THEN LEAVE documents_loop; END IF;
    SET migrated_settings = original_settings;
    SET layer_index = -1;
    SET layer_count = IF(JSON_TYPE(JSON_EXTRACT(original_settings, '$.native_settings.version_overrides')) = 'ARRAY',
      JSON_LENGTH(JSON_EXTRACT(original_settings, '$.native_settings.version_overrides')), 0);
    WHILE layer_index < layer_count DO
      SET layer_prefix = IF(layer_index = -1, '$.native_settings', CONCAT('$.native_settings.version_overrides[', layer_index, ']'));
      SET migrated_settings = JSON_REMOVE(migrated_settings,
        CONCAT(layer_prefix, '.cli.channel'),
        CONCAT(layer_prefix, '.cli.minimum_version'),
        CONCAT(layer_prefix, '.cli.maximum_version'),
        CONCAT(layer_prefix, '.cli.required_minimum_version'),
        CONCAT(layer_prefix, '.cli.required_maximum_version'),
        CONCAT(layer_prefix, '.cli.npm_registry'),
        CONCAT(layer_prefix, '.cli.installer'),
        CONCAT(layer_prefix, '.compat.claude.sessions'),
        CONCAT(layer_prefix, '.compat.codex.sessions'),
        CONCAT(layer_prefix, '.compat.cursor.sessions'));
      SET layer_index = layer_index + 1;
    END WHILE;
    IF NOT (migrated_settings <=> original_settings) THEN
      UPDATE client_config_documents SET settings = migrated_settings WHERE id = document_id;
    END IF;
  END LOOP;
  CLOSE documents;
END$$
DELIMITER ;
CALL migrate_fleet_owned_grok_update_keys();
DROP PROCEDURE migrate_fleet_owned_grok_update_keys;
