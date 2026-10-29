/** Codex fleet defaults and retired-id upgrades, derived from the fleet model registry. */
import { CODEX_DEFAULT_EFFORT, MODEL_REGISTRY, upgradeMap } from './model-registry/index.js';

/** Fleet defaults for new Codex configs and OpenAI-compatible requests. */
export const DEFAULT_CODEX_MODEL = MODEL_REGISTRY.codex.defaultModel;
export const DEFAULT_CODEX_REASONING_EFFORT = CODEX_DEFAULT_EFFORT;

/** Target of retired ids without a named successor (`CODEX_FORCED_UPGRADES_FROM`). */
export const FORCE_UPGRADE_MODEL = DEFAULT_CODEX_MODEL;
/** Compatibility export; actual migrations preserve valid effort or use the successor default. */
export const FORCE_UPGRADE_REASONING_EFFORT = 'high';

/** Retired id -> successor: each entry's `upgradesFrom` plus the forced upgrades. */
export const LEGACY_MODEL_UPGRADES: Readonly<Record<string, string>> = upgradeMap('codex');

/** Known deprecated ids only: custom provider model names remain untouched. */
export function upgradeCodexModelId(value: string): string {
  const key = value.trim();
  return Object.hasOwn(LEGACY_MODEL_UPGRADES, key) ? LEGACY_MODEL_UPGRADES[key]! : value;
}
