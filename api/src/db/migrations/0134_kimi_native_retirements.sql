-- Kimi Code 2.6 user settings: retire only verified obsolete authored paths.
-- Explicit successors win; invalid old loop values remain visible for correction.
-- Preserve every sibling, literal map name, and historical body/hash snapshot.
UPDATE client_config_documents
SET settings = JSON_SET(settings, '$.native_settings.loop_control.max_attempts_per_step',
  JSON_EXTRACT(settings, '$.native_settings.loop_control.max_retries_per_step'))
WHERE engine = 'kimi'
  AND NOT JSON_CONTAINS_PATH(settings, 'one', '$.native_settings.loop_control.max_attempts_per_step')
  AND JSON_TYPE(JSON_EXTRACT(settings, '$.native_settings.loop_control.max_retries_per_step')) IN ('INTEGER', 'DOUBLE', 'DECIMAL')
  AND CAST(JSON_UNQUOTE(JSON_EXTRACT(settings, '$.native_settings.loop_control.max_retries_per_step')) AS DOUBLE) BETWEEN 0 AND 9007199254740991
  AND MOD(CAST(JSON_UNQUOTE(JSON_EXTRACT(settings, '$.native_settings.loop_control.max_retries_per_step')) AS DOUBLE), 1) = 0;

UPDATE client_config_documents
SET settings = JSON_REMOVE(settings, '$.native_settings.loop_control.max_retries_per_step')
WHERE engine = 'kimi'
  AND JSON_CONTAINS_PATH(settings, 'all', '$.native_settings.loop_control.max_retries_per_step', '$.native_settings.loop_control.max_attempts_per_step');

UPDATE client_config_documents
SET settings = JSON_SET(settings, '$.native_settings.loop_control.max_steps_per_turn',
  JSON_EXTRACT(settings, '$.native_settings.loop_control.max_steps_per_run'))
WHERE engine = 'kimi'
  AND NOT JSON_CONTAINS_PATH(settings, 'one', '$.native_settings.loop_control.max_steps_per_turn')
  AND JSON_TYPE(JSON_EXTRACT(settings, '$.native_settings.loop_control.max_steps_per_run')) IN ('INTEGER', 'DOUBLE', 'DECIMAL')
  AND CAST(JSON_UNQUOTE(JSON_EXTRACT(settings, '$.native_settings.loop_control.max_steps_per_run')) AS DOUBLE) BETWEEN 0 AND 9007199254740991
  AND MOD(CAST(JSON_UNQUOTE(JSON_EXTRACT(settings, '$.native_settings.loop_control.max_steps_per_run')) AS DOUBLE), 1) = 0;

UPDATE client_config_documents
SET settings = JSON_REMOVE(settings, '$.native_settings.loop_control.max_steps_per_run')
WHERE engine = 'kimi'
  AND JSON_CONTAINS_PATH(settings, 'all', '$.native_settings.loop_control.max_steps_per_run', '$.native_settings.loop_control.max_steps_per_turn');

UPDATE client_config_documents
SET settings = JSON_REMOVE(settings,
  '$.native_settings.secondary_model.force',
  '$.native_settings.secondary_model.max_context_size',
  '$.native_settings.secondary_model.max_input_size',
  '$.native_settings.secondary_model.max_output_size',
  '$.native_settings.secondary_model.capabilities',
  '$.native_settings.secondary_model.display_name',
  '$.native_settings.secondary_model.reasoning_key',
  '$.native_settings.secondary_model.adaptive_thinking',
  '$.native_settings.secondary_model.support_efforts',
  '$.native_settings.secondary_model.off_effort',
  '$.native_settings.task.max_running_tasks',
  '$.native_settings.background.max_running_tasks')
WHERE engine = 'kimi' AND JSON_CONTAINS_PATH(settings, 'one',
  '$.native_settings.secondary_model.force',
  '$.native_settings.secondary_model.max_context_size',
  '$.native_settings.secondary_model.max_input_size',
  '$.native_settings.secondary_model.max_output_size',
  '$.native_settings.secondary_model.capabilities',
  '$.native_settings.secondary_model.display_name',
  '$.native_settings.secondary_model.reasoning_key',
  '$.native_settings.secondary_model.adaptive_thinking',
  '$.native_settings.secondary_model.support_efforts',
  '$.native_settings.secondary_model.off_effort',
  '$.native_settings.task.max_running_tasks',
  '$.native_settings.background.max_running_tasks');
