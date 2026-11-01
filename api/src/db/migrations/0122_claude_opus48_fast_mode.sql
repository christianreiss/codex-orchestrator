-- Claude Code 2.1.316: Opus 4.8 fast mode deprecated 2026-10-30,
-- removed 2026-11-30. Retain the model and explicit disabled-mode ownership.
-- Match structured-env-over-native-env leaf precedence, then native
-- ANTHROPIC_MODEL > settings.model > ANTHROPIC_DEFAULT_MODEL selection.
-- Known family aliases follow their matching DEFAULT_*_MODEL pin only.
-- Custom IDs remain opaque. Historical body/hash/timestamps never change.
DROP TEMPORARY TABLE IF EXISTS opus48_fast_mode_candidates;
CREATE TEMPORARY TABLE opus48_fast_mode_candidates (
  id BIGINT UNSIGNED PRIMARY KEY,
  selected_model LONGTEXT,
  default_model LONGTEXT,
  opus_model LONGTEXT,
  sonnet_model LONGTEXT,
  haiku_model LONGTEXT,
  fable_model LONGTEXT
);
INSERT INTO opus48_fast_mode_candidates
SELECT id,
  COALESCE(NULLIF(LOWER(TRIM(CASE
      WHEN JSON_TYPE(JSON_EXTRACT(settings, '$.env.ANTHROPIC_MODEL')) IN ('STRING','INTEGER','DOUBLE','BOOLEAN')
        THEN JSON_UNQUOTE(JSON_EXTRACT(settings, '$.env.ANTHROPIC_MODEL'))
      WHEN JSON_TYPE(JSON_EXTRACT(settings, '$.native_settings.env.ANTHROPIC_MODEL')) IN ('STRING','INTEGER','DOUBLE','BOOLEAN')
        THEN JSON_UNQUOTE(JSON_EXTRACT(settings, '$.native_settings.env.ANTHROPIC_MODEL'))
      ELSE NULL END)), ''),
    NULLIF(LOWER(TRIM(CASE WHEN JSON_TYPE(JSON_EXTRACT(settings, '$.model')) = 'STRING'
      THEN JSON_UNQUOTE(JSON_EXTRACT(settings, '$.model')) ELSE NULL END)), '')),
  LOWER(TRIM(CASE
      WHEN JSON_TYPE(JSON_EXTRACT(settings, '$.env.ANTHROPIC_DEFAULT_MODEL')) IN ('STRING','INTEGER','DOUBLE','BOOLEAN')
        THEN JSON_UNQUOTE(JSON_EXTRACT(settings, '$.env.ANTHROPIC_DEFAULT_MODEL'))
      WHEN JSON_TYPE(JSON_EXTRACT(settings, '$.native_settings.env.ANTHROPIC_DEFAULT_MODEL')) IN ('STRING','INTEGER','DOUBLE','BOOLEAN')
        THEN JSON_UNQUOTE(JSON_EXTRACT(settings, '$.native_settings.env.ANTHROPIC_DEFAULT_MODEL'))
      ELSE NULL END)),
  LOWER(TRIM(CASE
      WHEN JSON_TYPE(JSON_EXTRACT(settings, '$.env.ANTHROPIC_DEFAULT_OPUS_MODEL')) IN ('STRING','INTEGER','DOUBLE','BOOLEAN')
        THEN JSON_UNQUOTE(JSON_EXTRACT(settings, '$.env.ANTHROPIC_DEFAULT_OPUS_MODEL'))
      WHEN JSON_TYPE(JSON_EXTRACT(settings, '$.native_settings.env.ANTHROPIC_DEFAULT_OPUS_MODEL')) IN ('STRING','INTEGER','DOUBLE','BOOLEAN')
        THEN JSON_UNQUOTE(JSON_EXTRACT(settings, '$.native_settings.env.ANTHROPIC_DEFAULT_OPUS_MODEL'))
      ELSE NULL END)),
  LOWER(TRIM(CASE
      WHEN JSON_TYPE(JSON_EXTRACT(settings, '$.env.ANTHROPIC_DEFAULT_SONNET_MODEL')) IN ('STRING','INTEGER','DOUBLE','BOOLEAN')
        THEN JSON_UNQUOTE(JSON_EXTRACT(settings, '$.env.ANTHROPIC_DEFAULT_SONNET_MODEL'))
      WHEN JSON_TYPE(JSON_EXTRACT(settings, '$.native_settings.env.ANTHROPIC_DEFAULT_SONNET_MODEL')) IN ('STRING','INTEGER','DOUBLE','BOOLEAN')
        THEN JSON_UNQUOTE(JSON_EXTRACT(settings, '$.native_settings.env.ANTHROPIC_DEFAULT_SONNET_MODEL'))
      ELSE NULL END)),
  LOWER(TRIM(CASE
      WHEN JSON_TYPE(JSON_EXTRACT(settings, '$.env.ANTHROPIC_DEFAULT_HAIKU_MODEL')) IN ('STRING','INTEGER','DOUBLE','BOOLEAN')
        THEN JSON_UNQUOTE(JSON_EXTRACT(settings, '$.env.ANTHROPIC_DEFAULT_HAIKU_MODEL'))
      WHEN JSON_TYPE(JSON_EXTRACT(settings, '$.native_settings.env.ANTHROPIC_DEFAULT_HAIKU_MODEL')) IN ('STRING','INTEGER','DOUBLE','BOOLEAN')
        THEN JSON_UNQUOTE(JSON_EXTRACT(settings, '$.native_settings.env.ANTHROPIC_DEFAULT_HAIKU_MODEL'))
      ELSE NULL END)),
  LOWER(TRIM(CASE
      WHEN JSON_TYPE(JSON_EXTRACT(settings, '$.env.ANTHROPIC_DEFAULT_FABLE_MODEL')) IN ('STRING','INTEGER','DOUBLE','BOOLEAN')
        THEN JSON_UNQUOTE(JSON_EXTRACT(settings, '$.env.ANTHROPIC_DEFAULT_FABLE_MODEL'))
      WHEN JSON_TYPE(JSON_EXTRACT(settings, '$.native_settings.env.ANTHROPIC_DEFAULT_FABLE_MODEL')) IN ('STRING','INTEGER','DOUBLE','BOOLEAN')
        THEN JSON_UNQUOTE(JSON_EXTRACT(settings, '$.native_settings.env.ANTHROPIC_DEFAULT_FABLE_MODEL'))
      ELSE NULL END))
FROM client_config_documents
WHERE engine = 'claude' AND JSON_TYPE(settings) = 'OBJECT'
  AND JSON_TYPE(JSON_EXTRACT(settings, '$.native_settings.fastMode')) = 'BOOLEAN'
  AND JSON_EXTRACT(settings, '$.native_settings.fastMode') = CAST('true' AS JSON);

-- Existing registry upgrades to Opus 4.8 also apply before runtime selection.
-- Preserve the authored model IDs in documents; only normalize candidates.
UPDATE opus48_fast_mode_candidates SET
  selected_model = CASE WHEN (CASE WHEN RIGHT(selected_model,4) = '[1m]' THEN LEFT(selected_model,CHAR_LENGTH(selected_model)-4) ELSE selected_model END)
    IN ('claude-3-opus-20240229', 'claude-opus-4-20250514', 'claude-opus-4-1-20250805', 'claude-opus-4-1', 'claude-opus-4-0', 'claude-2.0', 'claude-2.1')
    THEN CONCAT('claude-opus-4-8', CASE WHEN RIGHT(selected_model,4) = '[1m]' THEN '[1m]' ELSE '' END)
    ELSE selected_model END,
  default_model = CASE WHEN (CASE WHEN RIGHT(default_model,4) = '[1m]' THEN LEFT(default_model,CHAR_LENGTH(default_model)-4) ELSE default_model END)
    IN ('claude-3-opus-20240229', 'claude-opus-4-20250514', 'claude-opus-4-1-20250805', 'claude-opus-4-1', 'claude-opus-4-0', 'claude-2.0', 'claude-2.1')
    THEN CONCAT('claude-opus-4-8', CASE WHEN RIGHT(default_model,4) = '[1m]' THEN '[1m]' ELSE '' END)
    ELSE default_model END,
  opus_model = CASE WHEN (CASE WHEN RIGHT(opus_model,4) = '[1m]' THEN LEFT(opus_model,CHAR_LENGTH(opus_model)-4) ELSE opus_model END)
    IN ('claude-3-opus-20240229', 'claude-opus-4-20250514', 'claude-opus-4-1-20250805', 'claude-opus-4-1', 'claude-opus-4-0', 'claude-2.0', 'claude-2.1')
    THEN CONCAT('claude-opus-4-8', CASE WHEN RIGHT(opus_model,4) = '[1m]' THEN '[1m]' ELSE '' END)
    ELSE opus_model END,
  sonnet_model = CASE WHEN (CASE WHEN RIGHT(sonnet_model,4) = '[1m]' THEN LEFT(sonnet_model,CHAR_LENGTH(sonnet_model)-4) ELSE sonnet_model END)
    IN ('claude-3-opus-20240229', 'claude-opus-4-20250514', 'claude-opus-4-1-20250805', 'claude-opus-4-1', 'claude-opus-4-0', 'claude-2.0', 'claude-2.1')
    THEN CONCAT('claude-opus-4-8', CASE WHEN RIGHT(sonnet_model,4) = '[1m]' THEN '[1m]' ELSE '' END)
    ELSE sonnet_model END,
  haiku_model = CASE WHEN (CASE WHEN RIGHT(haiku_model,4) = '[1m]' THEN LEFT(haiku_model,CHAR_LENGTH(haiku_model)-4) ELSE haiku_model END)
    IN ('claude-3-opus-20240229', 'claude-opus-4-20250514', 'claude-opus-4-1-20250805', 'claude-opus-4-1', 'claude-opus-4-0', 'claude-2.0', 'claude-2.1')
    THEN CONCAT('claude-opus-4-8', CASE WHEN RIGHT(haiku_model,4) = '[1m]' THEN '[1m]' ELSE '' END)
    ELSE haiku_model END,
  fable_model = CASE WHEN (CASE WHEN RIGHT(fable_model,4) = '[1m]' THEN LEFT(fable_model,CHAR_LENGTH(fable_model)-4) ELSE fable_model END)
    IN ('claude-3-opus-20240229', 'claude-opus-4-20250514', 'claude-opus-4-1-20250805', 'claude-opus-4-1', 'claude-opus-4-0', 'claude-2.0', 'claude-2.1')
    THEN CONCAT('claude-opus-4-8', CASE WHEN RIGHT(fable_model,4) = '[1m]' THEN '[1m]' ELSE '' END)
    ELSE fable_model END;

-- The default option resolves through DEFAULT_MODEL. Native ignores its
-- plan/haiku values after stripping [1m]; they must not become selections here.
UPDATE opus48_fast_mode_candidates
SET selected_model = CASE WHEN default_model IN ('opusplan','opusplan[1m]','haiku','haiku[1m]') THEN NULL ELSE default_model END
WHERE selected_model IS NULL OR selected_model = 'default';

UPDATE client_config_documents AS d
JOIN opus48_fast_mode_candidates AS c ON c.id = d.id
SET d.settings = JSON_SET(d.settings, '$.native_settings.fastMode', CAST('false' AS JSON))
WHERE c.selected_model IN ('claude-opus-4-8', 'claude-opus-4-8[1m]')
  OR (c.selected_model IN ('opus', 'opus[1m]', 'opusplan', 'opusplan[1m]')
    AND c.opus_model IN ('claude-opus-4-8', 'claude-opus-4-8[1m]'))
  OR (c.selected_model IN ('sonnet', 'sonnet[1m]', 'opusplan', 'opusplan[1m]')
    AND c.sonnet_model IN ('claude-opus-4-8', 'claude-opus-4-8[1m]'))
  OR (c.selected_model IN ('haiku', 'haiku[1m]')
    AND c.haiku_model IN ('claude-opus-4-8', 'claude-opus-4-8[1m]'))
  OR (c.selected_model IN ('fable', 'fable[1m]')
    AND c.fable_model IN ('claude-opus-4-8', 'claude-opus-4-8[1m]'));
DROP TEMPORARY TABLE opus48_fast_mode_candidates;
