const old = 'claude-opus-4-8', current = 'claude-opus-5-5';
const settings = (model: string | undefined, nativeEnv: Record<string, unknown> = {}, env?: Record<string, unknown>) => ({
  ...(model && { model }), native_settings: { fastMode: true, language: 'de', env: nativeEnv }, ...(env && { env }),
});

/** Explicit expected outcomes shared by the renderer and real-MySQL regression. */
export const claudeFastModeCases = [
  ['structured model env wins', settings(current, { ANTHROPIC_MODEL: current }, { ANTHROPIC_MODEL: old }), true],
  ['structured env clears native old selection', settings(old, { ANTHROPIC_MODEL: old }, { ANTHROPIC_MODEL: current }), false],
  ['native current selection wins over old setting', settings(old, { ANTHROPIC_MODEL: current }), false],
  ['structured unrelated leaf preserves native model env', settings(current, { ANTHROPIC_MODEL: old }, { LOCAL: 'keep' }), true],
  ['empty structured model shadows native env and falls back to setting', settings(current, { ANTHROPIC_MODEL: old }, { ANTHROPIC_MODEL: '' }), false],
  ['null structured leaf is ignored like env normalization', settings(current, { ANTHROPIC_MODEL: old }, { ANTHROPIC_MODEL: null }), true],
  ['opus alias follows old pin', settings('opus', { ANTHROPIC_DEFAULT_OPUS_MODEL: old }), true],
  ['opus 1m alias follows old pin', settings('opus[1m]', { ANTHROPIC_DEFAULT_OPUS_MODEL: old + '[1m]' }), true],
  ['plan phase follows old pin', settings('opusplan', { ANTHROPIC_DEFAULT_OPUS_MODEL: old }), true],
  ['sonnet alias follows authored old model pin', settings('sonnet', { ANTHROPIC_DEFAULT_SONNET_MODEL: old }), true],
  ['structured family pin overrides native pin', settings('opus', { ANTHROPIC_DEFAULT_OPUS_MODEL: old }, { ANTHROPIC_DEFAULT_OPUS_MODEL: current }), false],
  ['model env alias follows structured family pin', settings(current, { ANTHROPIC_MODEL: 'opus' }, { ANTHROPIC_DEFAULT_OPUS_MODEL: old }), true],
  ['specific current ID ignores old family pin', settings(current, { ANTHROPIC_DEFAULT_OPUS_MODEL: old }), false],
  ['custom model env stays opaque', settings(old, { ANTHROPIC_MODEL: 'provider/custom-opus', ANTHROPIC_DEFAULT_OPUS_MODEL: old }), false],
  ['custom alias pin stays opaque', settings('opus', { ANTHROPIC_DEFAULT_OPUS_MODEL: 'provider/custom-opus' }), false],
  ['default model applies only without a selected model', settings(undefined, { ANTHROPIC_DEFAULT_MODEL: old }), true],
  ['default option resolves authored default model', settings('default', { ANTHROPIC_DEFAULT_MODEL: old }), true],
  ['explicit model outranks default model', settings(current, { ANTHROPIC_DEFAULT_MODEL: old }), false],
  ['ignored default opusplan does not select old plan model', settings('default', { ANTHROPIC_DEFAULT_MODEL: 'opusplan', ANTHROPIC_DEFAULT_OPUS_MODEL: old }), false],
  ['known legacy root upgrades before validation', settings('claude-opus-4-1'), true],
  ['known legacy native env upgrades before validation', settings(current, { ANTHROPIC_MODEL: 'claude-opus-4-1' }), true],
  ['known legacy structured env upgrades before validation', settings(current, {}, { ANTHROPIC_MODEL: 'claude-opus-4-1-20250805[1m]' }), true],
  ['known legacy family pin upgrades before validation', settings('opus', { ANTHROPIC_DEFAULT_OPUS_MODEL: 'claude-opus-4-1' }), true],
  ['native model env wins', settings(current, { ANTHROPIC_MODEL: old }), true],
] as const;
