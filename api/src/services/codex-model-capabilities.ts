/** Native Codex model capabilities from the 0.164.0 account catalog, verified 2026-10-26.
 * Shared by structured and native-reference migrations; API effort semantics are separate. */
export const MODEL_REASONING_EFFORTS: Readonly<Record<string, readonly string[]>> = {
  'gpt-6.1-sol': ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
  'gpt-6.1-terra': ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
  'gpt-6-astra': ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
  'gpt-6-sol': ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
  'gpt-6-luna': ['low', 'medium', 'high', 'xhigh', 'max'],
  'gpt-5.6-sol': ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
  'gpt-5.6-terra': ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
  'gpt-5.6-luna': ['low', 'medium', 'high', 'xhigh', 'max'],
};

/**
 * `default_reasoning_level` as reported by the Codex CLI model catalog.
 * Verified against codex-cli 0.164.0 models_cache.json, 2026-10-26.
 */
export const CODEX_MODEL_DEFAULT_REASONING_EFFORTS: Readonly<Record<string, string>> = {
  'gpt-6.1-sol': 'low',
  'gpt-6.1-terra': 'low',
  'gpt-6-astra': 'medium',
  'gpt-6-sol': 'medium',
  'gpt-6-luna': 'medium',
  'gpt-5.6-sol': 'low',
  'gpt-5.6-terra': 'medium',
  'gpt-5.6-luna': 'medium',
};

/** Native CLI availability, not an API model minimum. Official models reference, 2026-10-26. */
export const CODEX_MODEL_MIN_CLI_VERSIONS: Readonly<Record<string, string>> = {
  'gpt-6.1-terra': '0.159.0',
};
