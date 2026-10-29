/**
 * Read-only views over the fleet model registry (`./data.ts`). The legacy
 * modules (`config-normalizer`, `codex-model-*`, `claude-models`, `grok-models`,
 * `claude-effort`, `model-tiers`) re-export their historical names from these
 * views, so nothing below is hand-maintained. See docs/model-registry.md.
 */
import type { Engine } from '../../util/engine.js';
import {
  CLAUDE_ADVISOR_ALIASES,
  CLAUDE_DEFAULT_MODEL,
  CLAUDE_MODELS,
  CODEX_DEFAULT_MODEL,
  CODEX_FORCED_UPGRADES_FROM,
  CODEX_MODELS,
  GROK_DEFAULT_MODEL,
  GROK_MODELS,
} from './data.js';
import type { EngineRegistry, ModelEntry, ModelTier } from './types.js';

export type { ClaudeModelLine, EngineRegistry, ModelEntry, ModelStatus, ModelTier } from './types.js';
export { CLAUDE_ADVISOR_ALIASES, CODEX_DEFAULT_EFFORT, CODEX_FORCED_UPGRADES_FROM } from './data.js';

export type ClaudeModel = (typeof CLAUDE_MODELS)[number]['id'];
export type GrokModel = (typeof GROK_MODELS)[number]['id'];

export const MODEL_REGISTRY: Readonly<Record<Engine, EngineRegistry>> = {
  codex: { models: CODEX_MODELS, defaultModel: CODEX_DEFAULT_MODEL },
  claude: { models: CLAUDE_MODELS, defaultModel: CLAUDE_DEFAULT_MODEL },
  grok: { models: GROK_MODELS, defaultModel: GROK_DEFAULT_MODEL },
};

const own = <T>(map: Readonly<Record<string, T>>, key: string): T | undefined =>
  Object.prototype.hasOwnProperty.call(map, key) ? map[key] : undefined;

/** Every registered entry of an engine, in canonical order, whatever its status. */
export function registryModels(engine: Engine): readonly ModelEntry[] {
  return MODEL_REGISTRY[engine].models;
}

/** Ids the fleet accepts (active + deprecated), in canonical order. */
export function acceptedModelIds(engine: Engine): string[] {
  return registryModels(engine).filter((entry) => entry.status !== 'retired').map((entry) => entry.id);
}

/** Ids the fleet offers in pickers and catalogs (active only), in canonical order. */
export function offeredModelIds(engine: Engine): string[] {
  return registryModels(engine).filter((entry) => entry.status === 'active').map((entry) => entry.id);
}

/** Exact registry entry for an id (no alias or upgrade resolution). */
export function registryEntry(engine: Engine, id: string): ModelEntry | undefined {
  return registryModels(engine).find((entry) => entry.id === id);
}

export function liveCatalogRequired(engine: Engine, id: string): boolean {
  return registryEntry(engine, id)?.liveCatalogRequired === true;
}

/** Per-id table of one field over the accepted models. */
export function modelTable<T>(engine: Engine, pick: (entry: ModelEntry) => T | undefined): Record<string, T> {
  const out: Record<string, T> = {};
  for (const entry of registryModels(engine)) {
    if (entry.status === 'retired') continue;
    const value = pick(entry);
    if (value !== undefined) out[entry.id] = value;
  }
  return out;
}

/**
 * Retired id -> successor, plus active aliases -> canonical id. Codex ids with
 * no named successor follow the fleet default (`CODEX_FORCED_UPGRADES_FROM`).
 */
export function upgradeMap(engine: Engine): Record<string, string> {
  const out: Record<string, string> = {};
  for (const entry of registryModels(engine)) {
    if (entry.status === 'retired') continue;
    for (const from of entry.upgradesFrom ?? []) out[from] = entry.id;
  }
  if (engine === 'codex') for (const from of CODEX_FORCED_UPGRADES_FROM) out[from] = MODEL_REGISTRY.codex.defaultModel;
  for (const entry of registryModels(engine)) {
    if (entry.status === 'retired') continue;
    for (const alias of entry.aliases ?? []) out[alias] = entry.id;
  }
  return out;
}

/** Family -> tier for families whose members all share one tier. */
export function familyTiers(engine: Engine): Record<string, ModelTier> {
  const out: Record<string, ModelTier> = {};
  const mixed = new Set<string>();
  for (const entry of registryModels(engine)) {
    const known = own(out, entry.family);
    if (known !== undefined && known !== entry.tier) mixed.add(entry.family);
    else out[entry.family] = entry.tier;
  }
  for (const family of mixed) delete out[family];
  return out;
}

/** Claude `advisor_rank` per id and per alias of a ranked model. */
export function claudeAdvisorRanks(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const entry of registryModels('claude')) {
    if (entry.advisorRank === undefined || entry.status === 'retired') continue;
    out[entry.id] = entry.advisorRank;
    for (const alias of entry.aliases ?? []) out[alias] = entry.advisorRank;
  }
  return out;
}

export const CLAUDE_ADVISOR_ALIAS_NAMES = Object.keys(CLAUDE_ADVISOR_ALIASES) as Array<keyof typeof CLAUDE_ADVISOR_ALIASES>;
