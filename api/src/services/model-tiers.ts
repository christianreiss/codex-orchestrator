/**
 * Cross-engine model classes for the managed "Model Class Check" guidance.
 *
 * Tiers rank capability across providers, so they are one table rather than a
 * field per engine catalog. Codex and Claude rank by model family so a new
 * version inherits its family's tier; Grok families do not separate 4.6 from
 * 4.7, so Grok ranks by exact id. Every supported catalog id must resolve
 * (pinned by model-tiers.test.ts): a new model without a tier fails CI instead
 * of silently vanishing from the guidance. The engine-maintenance prompt
 * (docs/prompts/engine-maintenance.md) owns keeping this table current.
 */
import { ENGINE_CLAUDE, ENGINE_CODEX, ENGINES, type Engine } from '../util/engine.js';

export type ModelTier = 1 | 2 | 3 | 4;

export const MODEL_TIER_CHECK_ENABLED_KEY = 'model_tier_check_enabled';

const CODEX_FAMILY_TIERS: Readonly<Record<string, ModelTier>> = { luna: 1, terra: 2, sol: 3, astra: 4 };
const CLAUDE_FAMILY_TIERS: Readonly<Record<string, ModelTier>> = { haiku: 1, sonnet: 2, opus: 3, fable: 4 };
const GROK_MODEL_TIERS: Readonly<Record<string, ModelTier>> = {
  'grok-4.7': 2,
  'grok-4.7-build-fast': 1,
  'grok-4.6': 1,
  'grok-4.5': 1,
};

export const MODEL_TIER_WORK: Readonly<Record<ModelTier, string>> = {
  1: 'Lookups, renames, single-file edits, formatting, mechanical changes',
  2: 'Feature work, multi-file changes, debugging with a clear reproduction',
  3: 'Cross-cutting refactors, concurrency, security-sensitive or migration work',
  4: 'Architecture, multi-factor redesigns, ambiguous research and open-ended diagnosis',
};

/** Tier of a model id, or null for an unknown or custom-provider id. */
export function modelTier(engine: Engine, model: string | null | undefined): ModelTier | null {
  if (typeof model !== 'string') return null;
  const id = model.trim().toLowerCase();
  if (id === '') return null;
  if (engine === ENGINE_CODEX) {
    const family = /^gpt-\d+(?:\.\d+)*-([a-z]+)$/.exec(id)?.[1];
    return family ? CODEX_FAMILY_TIERS[family] ?? null : null;
  }
  if (engine === ENGINE_CLAUDE) {
    // Accepts full ids, dated ids, `[1m]` variants and the CLI's bare aliases.
    const family = /^(?:claude-)?(haiku|sonnet|opus|fable)\b/.exec(id)?.[1];
    return family ? CLAUDE_FAMILY_TIERS[family] ?? null : null;
  }
  return GROK_MODEL_TIERS[id] ?? null;
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
  for (const tier of [1, 2, 3, 4] as const) {
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
  const rows = table.map((row) =>
    `| ${row.tier} | ${MODEL_TIER_WORK[row.tier]} | ${row.models.map((entry) => `\`${entry.model}\``).join(', ')} |`);
  return `## Model Class Check

Before starting a work item, rate the task's tier and compare it with your own model.
${identity}
A session override (\`--model\`, \`agent_spawn\`, or the model named in your runtime
identity) takes precedence. If you cannot determine your model, state that
assumption once and proceed; never abort on a guess.

| Tier | Typical work | Models available on this host |
| --- | --- | --- |
${rows.join('\n')}

- **Underclassed** (task tier above yours): do not start. Report
  \`Underclassed: Tier <n> required, running <model> (Tier <m>). Recommended: <model>.\`
  Recommend the lowest listed model that fits, preferring your own engine. For accepted
  work, finish with \`agent_task_result\` status \`blocked\` and that line as summary.
- **Overclassed** (task two or more tiers below yours): you may note
  \`Overclassed: <model> (Tier <m>) for a Tier <n> task; <model> would suffice.\` once, then proceed.
- Otherwise proceed without comment. Re-check when the scope grows mid-task.
`;
}
