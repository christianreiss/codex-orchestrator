-- Grok 1.0.70 user-default maintenance. Preserve historical body/hash snapshots.
-- Only exact retired UI/memory keys and proven invalid compaction shapes change.
DROP PROCEDURE IF EXISTS migrate_grok_170_native_controls;
DELIMITER $$
CREATE PROCEDURE migrate_grok_170_native_controls()
BEGIN
  DECLARE finished BOOLEAN DEFAULT FALSE;
  DECLARE document_id BIGINT UNSIGNED;
  DECLARE original_settings JSON;
  DECLARE migrated_settings JSON;
  DECLARE layer_prefix VARCHAR(128);
  DECLARE layer_index INT;
  DECLARE layer_count INT;
  DECLARE old_vim JSON;
  DECLARE density VARCHAR(64);
  DECLARE model_names JSON;
  DECLARE model_index INT;
  DECLARE model_path TEXT;
  DECLARE field_value JSON;
  DECLARE documents CURSOR FOR SELECT id, settings FROM client_config_documents
    WHERE engine = 'grok' AND JSON_TYPE(settings) = 'OBJECT';
  DECLARE CONTINUE HANDLER FOR NOT FOUND SET finished = TRUE;
  OPEN documents;
  documents_loop: LOOP
    FETCH documents INTO document_id, original_settings;
    IF finished THEN LEAVE documents_loop; END IF;
    SET migrated_settings = original_settings;
    SET layer_index = -1;
    SET layer_count = COALESCE(JSON_LENGTH(JSON_EXTRACT(original_settings, '$.native_settings.version_overrides')), 0);
    WHILE layer_index < layer_count DO
      SET layer_prefix = IF(layer_index = -1, '$.native_settings', CONCAT('$.native_settings.version_overrides[', layer_index, ']'));
      SET old_vim = JSON_EXTRACT(migrated_settings, CONCAT(layer_prefix, '.ui.vim_mode'));
      IF JSON_TYPE(old_vim) = 'BOOLEAN' AND COALESCE(JSON_UNQUOTE(JSON_EXTRACT(migrated_settings, CONCAT(layer_prefix, '.keys.vim'))), '') NOT IN ('off', 'nav') THEN
        IF JSON_EXTRACT(migrated_settings, CONCAT(layer_prefix, '.keys')) IS NULL THEN
          SET migrated_settings = JSON_SET(migrated_settings, CONCAT(layer_prefix, '.keys'), JSON_OBJECT());
        END IF;
        SET migrated_settings = JSON_SET(migrated_settings, CONCAT(layer_prefix, '.keys.vim'), IF(JSON_UNQUOTE(old_vim) = 'true', 'nav', 'off'));
      END IF;
      IF NOT JSON_CONTAINS_PATH(migrated_settings, 'one', CONCAT(layer_prefix, '.ui.tool_call_density')) THEN
        SET density = NULL;
        IF JSON_EXTRACT(migrated_settings, CONCAT(layer_prefix, '.ui.collapsed_edit_blocks')) = CAST('true' AS JSON) THEN
          SET density = 'compact-ungrouped';
        ELSEIF JSON_EXTRACT(migrated_settings, CONCAT(layer_prefix, '.ui.collapsed_edit_blocks')) = CAST('false' AS JSON)
          OR JSON_EXTRACT(migrated_settings, CONCAT(layer_prefix, '.ui.group_tool_verbs')) = CAST('false' AS JSON) THEN
          SET density = 'compact-shells';
        END IF;
        IF density IS NOT NULL THEN
          SET migrated_settings = JSON_SET(migrated_settings, CONCAT(layer_prefix, '.ui.tool_call_density'), density);
        END IF;
      END IF;
      SET migrated_settings = JSON_REMOVE(migrated_settings,
        CONCAT(layer_prefix, '.ui.simple_mode'), CONCAT(layer_prefix, '.ui.vim_mode'),
        CONCAT(layer_prefix, '.ui.collapsed_edit_blocks'), CONCAT(layer_prefix, '.ui.group_tool_verbs'),
        CONCAT(layer_prefix, '.memory_v2.compact_index_enabled'));
      SET model_names = JSON_KEYS(JSON_EXTRACT(migrated_settings, CONCAT(layer_prefix, '.model')));
      SET model_index = 0;
      WHILE model_index < COALESCE(JSON_LENGTH(model_names), 0) DO
        SET model_path = CONCAT(layer_prefix, '.model.', JSON_QUOTE(JSON_UNQUOTE(JSON_EXTRACT(model_names, CONCAT('$[', model_index, ']')))));
        SET field_value = JSON_EXTRACT(migrated_settings, CONCAT(model_path, '.compaction_at_tokens'));
        IF field_value IS NOT NULL AND JSON_TYPE(field_value) NOT IN ('BOOLEAN', 'INTEGER', 'UNSIGNED INTEGER') THEN
          SET migrated_settings = JSON_REMOVE(migrated_settings, CONCAT(model_path, '.compaction_at_tokens'));
        ELSEIF JSON_TYPE(field_value) IN ('INTEGER', 'UNSIGNED INTEGER') AND CAST(JSON_UNQUOTE(field_value) AS DECIMAL(65,0)) < 0 THEN
          SET migrated_settings = JSON_REMOVE(migrated_settings, CONCAT(model_path, '.compaction_at_tokens'));
        END IF;
        SET field_value = JSON_EXTRACT(migrated_settings, CONCAT(model_path, '.compactions_remaining'));
        IF field_value IS NOT NULL AND JSON_TYPE(field_value) NOT IN ('BOOLEAN', 'INTEGER', 'UNSIGNED INTEGER') THEN
          SET migrated_settings = JSON_REMOVE(migrated_settings, CONCAT(model_path, '.compactions_remaining'));
        ELSEIF JSON_TYPE(field_value) IN ('INTEGER', 'UNSIGNED INTEGER') AND (CAST(JSON_UNQUOTE(field_value) AS DECIMAL(65,0)) < 0 OR CAST(JSON_UNQUOTE(field_value) AS DECIMAL(65,0)) > 255) THEN
          SET migrated_settings = JSON_REMOVE(migrated_settings, CONCAT(model_path, '.compactions_remaining'));
        END IF;
        SET model_index = model_index + 1;
      END WHILE;
      SET layer_index = layer_index + 1;
    END WHILE;
    IF NOT (migrated_settings <=> original_settings) THEN
      UPDATE client_config_documents SET settings = migrated_settings WHERE id = document_id;
    END IF;
  END LOOP;
  CLOSE documents;
END$$
DELIMITER ;
CALL migrate_grok_170_native_controls();
DROP PROCEDURE migrate_grok_170_native_controls;
