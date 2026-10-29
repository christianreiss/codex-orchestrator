/**
 * Cross-engine model classes for the managed "Model Class Check" guidance.
 *
 * Tiers rank capability across providers. Each registry entry carries its tier
 * (`model-registry/data.ts`, operator ruling in docs/model-tiers.md); an exact
 * id or alias resolves to it. Unknown Codex and Claude ids (dated ids, `[1m]`
 * variants, the CLI's bare aliases, a new version) fall back to their family's
 * tier; Grok families do not separate 4.6 from 4.7, so Grok ranks by exact id.
 * The engine-maintenance prompt (docs/prompts/engine-maintenance.md) owns
 * keeping the registry current.
 */
import { ENGINE_CLAUDE, ENGINE_CODEX, ENGINES, type Engine } from '../util/engine.js';
import { familyTiers, registryModels, type ModelTier } from './model-registry/index.js';

export type { ModelTier } from './model-registry/index.js';

export const MODEL_TIER_CHECK_ENABLED_KEY = 'model_tier_check_enabled';

const FAMILY_TIERS: Readonly<Record<Engine, Readonly<Record<string, ModelTier>>>> = {
  codex: familyTiers('codex'),
  claude: familyTiers('claude'),
  grok: {},
};

/** Exact ids and active aliases (not retired ids) -> tier. */
const EXACT_TIERS: Readonly<Record<Engine, ReadonlyMap<string, ModelTier>>> = Object.fromEntries(
  ENGINES.map((engine) => {
    const tiers = new Map<string, ModelTier>();
    for (const entry of registryModels(engine)) {
      if (entry.status === 'retired') continue;
      tiers.set(entry.id.toLowerCase(), entry.tier);
      for (const alias of entry.aliases ?? []) tiers.set(alias.toLowerCase(), entry.tier);
    }
    return [engine, tiers];
  }),
) as unknown as Record<Engine, ReadonlyMap<string, ModelTier>>;

export const MODEL_TIER_WORK: Readonly<Record<ModelTier, string>> = {
  1: 'Lookups, renames, single-file edits, formatting',
  2: 'Feature work, multi-file changes, debugging with a clear repro',
  3: 'Cross-cutting refactors, concurrency, security-sensitive or migration work',
  4: 'Architecture, complex multi-factor redesigns',
  5: 'Open-ended diagnosis, frontier review',
};

/** Tier of a model id, or null for an unknown or custom-provider id. */
export function modelTier(engine: Engine, model: string | null | undefined): ModelTier | null {
  if (typeof model !== 'string') return null;
  const id = model.trim().toLowerCase();
  if (id === '') return null;
  const exact = EXACT_TIERS[engine].get(id);
  if (exact !== undefined) return exact;
  if (engine === ENGINE_CODEX) {
    const family = /^gpt-\d+(?:\.\d+)*-([a-z]+)$/.exec(id)?.[1];
    return family ? FAMILY_TIERS.codex[family] ?? null : null;
  }
  if (engine === ENGINE_CLAUDE) {
    // Accepts dated ids, `[1m]` variants and the CLI's bare aliases.
    const family = /^(?:claude-)?(haiku|sonnet|opus|fable)\b/.exec(id)?.[1];
    return family ? FAMILY_TIERS.claude[family] ?? null : null;
  }
  return null;
}

export interface ModelTierEntry {
  engine: Engine;
  model: string;
}

export interface ModelTierRow {
  tier: ModelTier;
  models: ModelTierEntry[];
}

/**
 * Group the recommendable models of the active engines by tier. Engines and
 * models keep canonical order, so the table is independent of which engine is
 * reading it. Tiers with no model are omitted.
 */
export function buildModelTierTable(
  engines: readonly Engine[],
  modelsByEngine: Readonly<Partial<Record<Engine, readonly string[]>>>,
): ModelTierRow[] {
  const rows: ModelTierRow[] = [];
  for (const tier of [1, 2, 3, 4, 5] as const) {
    const models: ModelTierEntry[] = [];
    for (const engine of ENGINES) {
      if (!engines.includes(engine)) continue;
      for (const model of modelsByEngine[engine] ?? []) {
        if (modelTier(engine, model) === tier) models.push({ engine, model });
      }
    }
    if (models.length > 0) rows.push({ tier, models });
  }
  return rows;
}

export interface ConfiguredModel {
  engine: Engine;
  model: string | null;
}

export function renderModelTierGuidance(table: readonly ModelTierRow[], configured: ConfiguredModel): string {
  const tier = modelTier(configured.engine, configured.model);
  const identity = configured.model !== null && tier !== null
    ? `This host's configured ${configured.engine} model is \`${configured.model}\` (Tier ${tier}).`
    : configured.model !== null
      ? `This host's configured ${configured.engine} model is \`${configured.model}\`, which has no fleet tier.`
      : `No ${configured.engine} model is pinned for this host.`;
  // Task definitions survive even when this host has no model at that tier.
  const rows = ([1, 2, 3, 4, 5] as const).map((tier) => {
    const models = table.find((row) => row.tier === tier)?.models ?? [];
    return `| ${tier} | ${MODEL_TIER_WORK[tier]} | ${models.map((entry) => `\`${entry.model}\``).join(', ') || 'None available'} |`;
  });
  return `## Model Class Check

Preflight before task-specific scouting, planning or execution. ${identity}
A concrete session model overrides config; generic \`GPT-6\` does not. If genuinely unknown,
state it and proceed; never abort on a guess.

| Tier | Typical work | Models available on this host |
| --- | --- | --- |
${rows.join('\n')}

Rate by judgment needed, not keywords: read-only scouting (\`scout and prepare\`)
takes the tier of the decisions it feeds; mechanical inventory can be Tier 1. Security or
irreversibility sets checks, not tier. For Tier 3+, state task tier, model tier, reason.

Report \`Underclassed: Tier <n> required, running <model> (Tier <m>). Recommended: <model>.\`
with the lowest fitting available model, own engine first; if none fits, say so.

- **Task one tier above yours:** report and proceed.
- **Task two or more tiers above yours:** stop before scouting or planning; accepted work ends
  \`agent_task_result\` \`blocked\`. Only an explicit operator override acknowledging this mismatch
  permits proceeding; selecting a model or assigning the task is not an override.
- Otherwise proceed; re-check when scope grows.
`;
}
