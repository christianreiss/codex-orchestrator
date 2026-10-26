/** Fleet defaults for new Codex configs and OpenAI-compatible requests. */
export const DEFAULT_CODEX_MODEL = 'gpt-6-astra';
export const DEFAULT_CODEX_REASONING_EFFORT = 'medium';

export const FORCE_UPGRADE_MODEL = DEFAULT_CODEX_MODEL;
/** Compatibility export; actual migrations preserve valid effort or use the successor default. */
export const FORCE_UPGRADE_REASONING_EFFORT = 'high';

export const LEGACY_MODEL_UPGRADES: Readonly<Record<string, string>> = {
  // Deprecated before its 2026-10-14 retirement; native catalog replacement.
  'gpt-5.5': 'gpt-6.1-sol',
  // Current Codex model/workspace guidance, verified 2026-10-26:
  // https://learn.chatgpt.com/docs/models
  'gpt-5.4-mini': 'gpt-6-luna',
  'gpt-5.4': 'gpt-6-sol',
  'gpt-5.3-codex': FORCE_UPGRADE_MODEL,
  'gpt-5.2': FORCE_UPGRADE_MODEL,
  'gpt-5.2-codex': FORCE_UPGRADE_MODEL,
  'gpt-5.1-codex-max': FORCE_UPGRADE_MODEL,
  'gpt-5.1-codex-mini': FORCE_UPGRADE_MODEL,
  // Retired upstream (codex-cli 0.158.0: gone from the catalog and binary, a live
  // call is rejected "not supported when using Codex with a ChatGPT account").
  // The catalog names no replacement, so it takes the forced upgrade.
  'gpt-5.3-codex-spark': FORCE_UPGRADE_MODEL,
};

/** Known deprecated ids only: custom provider model names remain untouched. */
export function upgradeCodexModelId(value: string): string {
  const key = value.trim();
  return Object.hasOwn(LEGACY_MODEL_UPGRADES, key) ? LEGACY_MODEL_UPGRADES[key]! : value;
}
