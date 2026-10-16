-- Grok 1.0.51 removed these controls; 1.0.60 still recognizes the other
-- memory_v2 tuning fields. Preserve memory.enabled and every unrelated sibling.
-- Also repair known historically accepted but native-invalid inheritance,
-- status-line and notice shapes. Unknown custom content remains actionable.
-- Config documents are historical snapshots: keep body/sha256 together unchanged.
-- Host rendering and admin previews derive current TOML from the migrated settings;
-- the next normal save writes a fresh, matching settings/body/sha256 snapshot.
DROP PROCEDURE IF EXISTS migrate_grok_retired_memory_controls;
DELIMITER $$
CREATE PROCEDURE migrate_grok_retired_memory_controls()
BEGIN
  DECLARE finished BOOLEAN DEFAULT FALSE;
  DECLARE document_id BIGINT UNSIGNED;
  DECLARE original_settings JSON;
  DECLARE migrated_settings JSON;
  DECLARE layer_prefix VARCHAR(128);
  DECLARE layer_index INT;
  DECLARE layer_count INT;
  DECLARE status_path VARCHAR(256);
  DECLARE status_config JSON;
  DECLARE status_type VARCHAR(64);
  DECLARE item_index INT;
  DECLARE model_names JSON;
  DECLARE model_index INT;
  DECLARE model_path TEXT;
  DECLARE notice_path TEXT;
  DECLARE notice_config JSON;
  DECLARE documents CURSOR FOR
    SELECT id, settings FROM client_config_documents
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
      SET migrated_settings = JSON_REMOVE(migrated_settings,
        CONCAT(layer_prefix, '.memory.embedding'),
        CONCAT(layer_prefix, '.memory.initial_injection'),
        CONCAT(layer_prefix, '.memory.search'),
        CONCAT(layer_prefix, '.memory.session'),
        CONCAT(layer_prefix, '.memory.watcher'),
        CONCAT(layer_prefix, '.memory_v2.automatic_dream_enabled'),
        CONCAT(layer_prefix, '.memory_v2.capture_enabled'),
        CONCAT(layer_prefix, '.memory_v2.capture_status_enabled'),
        CONCAT(layer_prefix, '.memory_v2.file_writes_enabled'),
        CONCAT(layer_prefix, '.memory_v2.manual_dream_enabled'),
        CONCAT(layer_prefix, '.memory_v2.rollout'));
      -- Previously accepted strings outside the actual native enum had no
      -- supported behavior. Restore native inheritance by omitting only that key.
      IF JSON_CONTAINS_PATH(migrated_settings, 'one', CONCAT(layer_prefix, '.shell_environment_policy.inherit'))
        AND JSON_UNQUOTE(JSON_EXTRACT(migrated_settings, CONCAT(layer_prefix, '.shell_environment_policy.inherit'))) NOT IN ('core', 'all', 'none') THEN
        SET migrated_settings = JSON_REMOVE(migrated_settings, CONCAT(layer_prefix, '.shell_environment_policy.inherit'));
      END IF;

      SET status_path = CONCAT(layer_prefix, '.ui.status_line');
      SET status_config = JSON_EXTRACT(migrated_settings, status_path);
      SET status_type = JSON_UNQUOTE(JSON_EXTRACT(status_config, '$.type'));
      -- Only repair known status-line shapes. Unknown custom content stays
      -- visible to validation rather than being guessed away.
      IF JSON_TYPE(status_config) = 'OBJECT'
        AND JSON_LENGTH(JSON_REMOVE(status_config, '$.type', '$.command', '$.items', '$.padding', '$.refresh_interval')) = 0 THEN
        IF status_type IS NULL OR status_type NOT IN ('builtin', 'command', 'disabled', 'off', 'none', 'hidden')
          OR (status_type = 'command' AND (JSON_TYPE(JSON_EXTRACT(status_config, '$.command')) IS NULL
            OR JSON_TYPE(JSON_EXTRACT(status_config, '$.command')) <> 'STRING'
            OR TRIM(JSON_UNQUOTE(JSON_EXTRACT(status_config, '$.command'))) = '')) THEN
          SET migrated_settings = JSON_REMOVE(migrated_settings, status_path);
        ELSEIF status_type = 'builtin' THEN
          SET status_config = JSON_REMOVE(status_config, '$.refresh_interval');
          SET item_index = COALESCE(JSON_LENGTH(JSON_EXTRACT(status_config, '$.items')), 0) - 1;
          WHILE item_index >= 0 DO
            IF JSON_UNQUOTE(JSON_EXTRACT(status_config, CONCAT('$.items[', item_index, ']'))) NOT IN ('cwd', 'model', 'context', 'cost', 'turn-timer', 'session-name') THEN
              SET status_config = JSON_REMOVE(status_config, CONCAT('$.items[', item_index, ']'));
            END IF;
            SET item_index = item_index - 1;
          END WHILE;
          IF JSON_LENGTH(JSON_EXTRACT(status_config, '$.items')) = 0 THEN
            SET status_config = JSON_REMOVE(status_config, '$.items');
          END IF;
          SET migrated_settings = JSON_SET(migrated_settings, status_path, status_config);
        END IF;
      END IF;

      SET model_names = JSON_KEYS(JSON_EXTRACT(migrated_settings, CONCAT(layer_prefix, '.model')));
      SET model_index = 0;
      WHILE model_index < COALESCE(JSON_LENGTH(model_names), 0) DO
        -- Quote each opaque ID, including literal dots, quotes and backslashes.
        SET model_path = CONCAT(layer_prefix, '.model.', JSON_QUOTE(JSON_UNQUOTE(JSON_EXTRACT(model_names, CONCAT('$[', model_index, ']')))));
        SET migrated_settings = JSON_REMOVE(migrated_settings, CONCAT(model_path, '."6".api_key'));
        IF JSON_TYPE(JSON_EXTRACT(migrated_settings, CONCAT(model_path, '."6"'))) = 'OBJECT'
          AND JSON_LENGTH(JSON_EXTRACT(migrated_settings, CONCAT(model_path, '."6"'))) = 0 THEN
          SET migrated_settings = JSON_REMOVE(migrated_settings, CONCAT(model_path, '."6"'));
        END IF;
        SET notice_path = CONCAT(model_path, '.notice');
        SET notice_config = JSON_EXTRACT(migrated_settings, notice_path);
        IF JSON_TYPE(notice_config) = 'OBJECT'
          AND JSON_LENGTH(JSON_REMOVE(notice_config, '$.text', '$.label', '$.severity')) = 0 THEN
          IF JSON_TYPE(JSON_EXTRACT(notice_config, '$.text')) IS NULL
            OR JSON_TYPE(JSON_EXTRACT(notice_config, '$.text')) <> 'STRING' THEN
            SET migrated_settings = JSON_REMOVE(migrated_settings, notice_path);
          ELSE
            IF JSON_CONTAINS_PATH(notice_config, 'one', '$.label') AND JSON_TYPE(JSON_EXTRACT(notice_config, '$.label')) <> 'STRING' THEN
              SET notice_config = JSON_REMOVE(notice_config, '$.label');
            END IF;
            IF JSON_CONTAINS_PATH(notice_config, 'one', '$.severity')
              AND JSON_UNQUOTE(JSON_EXTRACT(notice_config, '$.severity')) NOT IN ('info', 'warning', 'critical') THEN
              SET notice_config = JSON_REMOVE(notice_config, '$.severity');
            END IF;
            SET migrated_settings = JSON_SET(migrated_settings, notice_path, notice_config);
          END IF;
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
CALL migrate_grok_retired_memory_controls();
DROP PROCEDURE migrate_grok_retired_memory_controls;
