/**
 * Cross-engine model classes for the managed "Model Class Check" guidance.
 *
 * Tiers rank capability across providers. Each registry entry carries its
 * default tier (`model-registry/data.ts`, operator ruling in docs/model-tiers.md);
 * the operator can move models between tiers in the admin console, stored as
 * deviations under `model_tier_overrides`. A `TierResolver` combines both: an
 * exact id or alias resolves to its placement; a Claude `[1m]` variant or a dated
 * snapshot to its base id; other unknown Codex and Claude ids (the CLI's bare
 * aliases, a new version) to their family. A family split by an override falls
 * back to its newest member (the first registry entry). Grok and Kimi rank by
 * exact id only. The engine-maintenance prompt
 * (docs/prompts/engine-maintenance.md) owns keeping the registry current.
 */
import { ENGINE_CLAUDE, ENGINE_CODEX, ENGINES, isEngine, type Engine } from '../util/engine.js';
import { registryModels, type ModelEntry, type ModelTier } from './model-registry/index.js';

export type { ModelTier } from './model-registry/index.js';

export const MODEL_TIER_CHECK_ENABLED_KEY = 'model_tier_check_enabled';
export const SUBAGENT_MODEL_SELECTION_ENABLED_KEY = 'subagent_model_selection_enabled';
/** `versions` key of the operator's tier placements (JSON `ModelTierOverrides`). */
export const MODEL_TIER_OVERRIDES_KEY = 'model_tier_overrides';

export const MODEL_TIERS = [1, 2, 3, 4, 5] as const satisfies readonly ModelTier[];

/** Operator placements that differ from the registry: engine -> registry id -> tier. */
export type ModelTierOverrides = Partial<Record<Engine, Record<string, ModelTier>>>;

/** The fleet's tier lookup: registry defaults with the operator's placements on top. */
export interface TierResolver {
  /** Normalized deviations from the registry (empty when none). */
  readonly overrides: ModelTierOverrides;
  tier(engine: Engine, model: string | null | undefined): ModelTier | null;
}

const isTier = (value: unknown): value is ModelTier => (MODEL_TIERS as readonly unknown[]).includes(value);
const accepted = (engine: Engine): readonly ModelEntry[] => registryModels(engine).filter((entry) => entry.status !== 'retired');
const FAMILY_ENGINES: readonly Engine[] = [ENGINE_CODEX, ENGINE_CLAUDE];

function createResolver(overrides: ModelTierOverrides): TierResolver {
  const placed = (engine: Engine, entry: ModelEntry): ModelTier => overrides[engine]?.[entry.id] ?? entry.tier;
  const exact = {} as Record<Engine, Map<string, ModelTier>>;
  const family = {} as Record<Engine, Map<string, ModelTier>>;
  for (const engine of ENGINES) {
    const tiers = new Map<string, ModelTier>();
    for (const entry of accepted(engine)) {
      tiers.set(entry.id.toLowerCase(), placed(engine, entry));
      for (const alias of entry.aliases ?? []) tiers.set(alias.toLowerCase(), placed(engine, entry));
    }
    exact[engine] = tiers;
    // Families group every registered entry (retired ones keep their registry tier). A family
    // whose members share one tier resolves to it; one an override split follows its newest member.
    const families = new Map<string, ModelTier>();
    if (FAMILY_ENGINES.includes(engine)) {
      const members = new Map<string, ModelEntry[]>();
      for (const entry of registryModels(engine)) members.set(entry.family, [...(members.get(entry.family) ?? []), entry]);
      for (const [name, entries] of members) {
        const tiers = new Set(entries.map((entry) => (entry.status === 'retired' ? entry.tier : placed(engine, entry))));
        const newest = entries.find((entry) => entry.status !== 'retired');
        if (tiers.size === 1) families.set(name, [...tiers][0]!);
        else if (newest && Object.keys(overrides[engine] ?? {}).length > 0) families.set(name, placed(engine, newest));
      }
    }
    family[engine] = families;
  }
  return {
    overrides,
    tier(engine, model) {
      if (typeof model !== 'string') return null;
      const id = model.trim().toLowerCase();
      if (id === '') return null;
      const hit = exact[engine].get(id);
      if (hit !== undefined) return hit;
      if (engine === ENGINE_CODEX) {
        const name = /^gpt-\d+(?:\.\d+)*-([a-z]+)$/.exec(id)?.[1];
        return name ? family.codex.get(name) ?? null : null;
      }
      if (engine === ENGINE_CLAUDE) {
        // A `[1m]` context variant or a dated snapshot of a known id takes that id's placement.
        const base = id.replace(/\[[^\]]*\]$/, '').replace(/-\d{8}$/, '');
        const known = base !== id ? exact.claude.get(base) : undefined;
        if (known !== undefined) return known;
        // Accepts dated ids, `[1m]` variants and the CLI's bare aliases.
        const name = /^(?:claude-)?(haiku|sonnet|opus|fable)\b/.exec(id)?.[1];
        return name ? family.claude.get(name) ?? null : null;
      }
      return null;
    },
  };
}

/** Registry tiers only: tests, tools and callers that never read the operator's placements. */
export const DEFAULT_TIER_RESOLVER: TierResolver = createResolver({});

/**
 * Tolerant read of the stored placements: an unknown engine, a retired or unknown id, an invalid
 * tier or a placement equal to the registry default is dropped, so a registry update never breaks
 * the guidance.
 */
export function parseModelTierOverrides(raw: string | null | undefined): ModelTierOverrides {
  if (!raw) return {};
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const out: ModelTierOverrides = {};
  for (const [engine, models] of Object.entries(value as Record<string, unknown>)) {
    if (!isEngine(engine) || !models || typeof models !== 'object' || Array.isArray(models)) continue;
    for (const [id, tier] of Object.entries(models as Record<string, unknown>)) {
      const entry = accepted(engine).find((candidate) => candidate.id === id);
      if (!entry || !isTier(tier) || tier === entry.tier) continue;
      (out[engine] ??= {})[id] = tier;
    }
  }
  return out;
}

/** Strict check of an admin write; placements equal to the registry default are dropped. */
export function validateModelTierOverrides(input: unknown): { overrides: ModelTierOverrides; errors: string[] } {
  const errors: string[] = [];
  const out: ModelTierOverrides = {};
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { overrides: out, errors: ['tiers must be an object of engine -> model id -> tier'] };
  for (const [engine, models] of Object.entries(input as Record<string, unknown>)) {
    if (!isEngine(engine)) { errors.push(`unknown engine ${engine}`); continue; }
    if (!models || typeof models !== 'object' || Array.isArray(models)) { errors.push(`${engine} must be an object of model id -> tier`); continue; }
    for (const [id, tier] of Object.entries(models as Record<string, unknown>)) {
      const entry = accepted(engine).find((candidate) => candidate.id === id);
      if (!entry) { errors.push(`${engine}/${id} is not a registered model`); continue; }
      if (!isTier(tier)) { errors.push(`${engine}/${id}: tier must be 1 to 5`); continue; }
      if (tier !== entry.tier) (out[engine] ??= {})[id] = tier;
    }
  }
  return { overrides: out, errors };
}

/** Canonical JSON of placements: engines and ids in registry order, so equal maps store equal text. */
export function serializeModelTierOverrides(overrides: ModelTierOverrides): string {
  const ordered: Record<string, Record<string, ModelTier>> = {};
  for (const engine of ENGINES) {
    const own = overrides[engine];
    if (!own) continue;
    for (const entry of accepted(engine)) if (own[entry.id] !== undefined) (ordered[engine] ??= {})[entry.id] = own[entry.id]!;
  }
  return JSON.stringify(ordered);
}

const resolvers = new Map<string, TierResolver>();
/** The resolver for a stored `model_tier_overrides` value, memoised on the raw text. */
export function tierResolver(raw: string | null | undefined): TierResolver {
  const key = raw ?? '';
  const known = resolvers.get(key);
  if (known) return known;
  const overrides = parseModelTierOverrides(raw);
  const resolver = Object.keys(overrides).length ? createResolver(overrides) : DEFAULT_TIER_RESOLVER;
  if (resolvers.size >= 16) resolvers.clear();
  resolvers.set(key, resolver);
  return resolver;
}

/** One registry model as the admin console places it. */
export interface ModelTierCatalogEntry {
  engine: Engine;
  id: string;
  label: string;
  family: string;
  status: ModelEntry['status'];
  default_tier: ModelTier;
  tier: ModelTier;
}

/** Every non-retired registry model with its default and effective tier, in canonical order. */
export function modelTierCatalog(resolver: TierResolver): ModelTierCatalogEntry[] {
  return ENGINES.flatMap((engine) => accepted(engine).map((entry) => ({
    engine,
    id: entry.id,
    label: entry.label,
    family: entry.family,
    status: entry.status,
    default_tier: entry.tier,
    tier: resolver.overrides[engine]?.[entry.id] ?? entry.tier,
  })));
}

/** Provider named in the session greeting; the engine is fixed per host section. */
export const ENGINE_VENDOR: Readonly<Record<Engine, string>> = {
  codex: 'OpenAI',
  claude: 'Anthropic',
  grok: 'xAI',
  kimi: 'MoonshotAI',
};

export const MODEL_TIER_WORK: Readonly<Record<ModelTier, string>> = {
  1: 'Lookups, renames, single-file edits, formatting',
  2: 'Feature work, multi-file changes, debugging with a clear repro',
  3: 'Cross-cutting refactors, concurrency, security-sensitive or migration work',
  4: 'Architecture, complex multi-factor redesigns',
  5: 'Open-ended diagnosis, frontier review',
};

/** Tier of a model id, or null for an unknown or custom-provider id. Registry tiers unless a resolver is given. */
export function modelTier(engine: Engine, model: string | null | undefined, resolver: TierResolver = DEFAULT_TIER_RESOLVER): ModelTier | null {
  return resolver.tier(engine, model);
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
  resolver: TierResolver = DEFAULT_TIER_RESOLVER,
): ModelTierRow[] {
  const rows: ModelTierRow[] = [];
  for (const tier of MODEL_TIERS) {
    const models: ModelTierEntry[] = [];
    for (const engine of ENGINES) {
      if (!engines.includes(engine)) continue;
      for (const model of modelsByEngine[engine] ?? []) {
        if (resolver.tier(engine, model) === tier) models.push({ engine, model });
      }
    }
    if (models.length > 0) rows.push({ tier, models });
  }
  return rows;
}

export interface ConfiguredModel {
  engine: Engine;
  model: string | null;
  /** Its tier under the fleet's placements; resolved from the registry when absent. */
  tier?: ModelTier | null;
}

/** Advisory only: runtime instructions still govern delegation and model overrides. */
export function renderSubagentModelGuidance(table: readonly ModelTierRow[], engine: Engine): string {
  const rows = table.map(({ tier, models }) => {
    const own = models.filter((entry) => entry.engine === engine).map((entry) => `\`${entry.model}\``);
    return own.length ? `- Tier ${tier}: ${own.join(', ')}` : null;
  }).filter((row): row is string => row !== null);
  return `## Subagent Model Selection

When delegation is permitted and useful, assess each delegated task's judgment,
complexity, uncertainty and verification needs. Select a model capable of the
required quality: a stronger or lighter model than yours can be appropriate.
Quality comes first; avoid underclassing and unnecessary overshooting. Delegate
when it benefits the task, not merely to change models.

Use an available model supported by the subagent launcher and its engine. If no
fitting model is available or model choice is unsupported, say so and follow the
applicable task and model-class rules. Explicit user choices and higher-level
runtime instructions take precedence. The parent reviews and verifies results,
and increases capability when evidence warrants it.

Available ${engine} models by fleet tier:
${rows.join('\n') || '- No classified models available'}
`;
}

export function renderModelTierGuidance(table: readonly ModelTierRow[], configured: ConfiguredModel, allowDelegation = false): string {
  const tier = configured.tier !== undefined ? configured.tier : modelTier(configured.engine, configured.model);
  const identity = configured.model !== null && tier !== null
    ? `This host's configured ${configured.engine} model is \`${configured.model}\` (Tier ${tier}).`
    : configured.model !== null
      ? `This host's configured ${configured.engine} model is \`${configured.model}\`, which has no fleet tier.`
      : `No ${configured.engine} model is pinned for this host.`;
  const sessionModel = configured.engine === ENGINE_CODEX
    ? 'Call `agent_self` and use `session_model.id` as the native model of the bound Codex session.\n'
      + 'Refresh after resume, a model change, or when asked which model is running. If the field is null\n'
      + 'or absent, state that the session model is unknown and proceed. The host model is only a default.'
    : 'A concrete session model overrides config; generic `GPT-6` does not. If genuinely unknown,\n'
      + 'state it and proceed; never abort on a guess.';
  // Task definitions survive even when this host has no model at that tier.
  const rows = MODEL_TIERS.map((tier) => {
    const models = table.find((row) => row.tier === tier)?.models ?? [];
    return `| ${tier} | ${MODEL_TIER_WORK[tier]} | ${models.map((entry) => `\`${entry.model}\``).join(', ') || 'None available'} |`;
  });
  return `## Model Class Check

Preflight before task-specific scouting, planning or execution. ${identity}
${sessionModel}

Greeting: in a new session's first reply (not after resume or in delivered work turns),
open with one line in the operator's language, e.g.
\`Hey, ich bin <launch name> von ${ENGINE_VENDOR[configured.engine]} und bin ein <model family> (Tier <n>).\`
Use your actual model; omit unknown parts, never guess.

| Tier | Typical work | Models available on this host |
| --- | --- | --- |
${rows.join('\n')}

Rate by judgment needed, not keywords: read-only scouting (\`scout and prepare\`)
takes the tier of the decisions it feeds; mechanical inventory can be Tier 1. Security or
irreversibility sets checks, not tier. For Tier 3+, state task tier, model tier, reason.

Report \`Underclassed: Tier <n> required, running <model> (Tier <m>). Recommended: <model>.\`
with the lowest fitting available model, own engine first; if none fits, say so.

- **Task one tier above yours:** report and proceed.
- **Task two or more tiers above yours:** ${allowDelegation ? 'if delegation is useful, higher-level instructions permit it and a fitting model is available, delegate the assignment to that model and review its evidence; otherwise stop before scouting or planning. If unable to delegate, accepted work ends' : 'stop before scouting or planning; accepted work ends'}
  \`agent_task_result\` \`blocked\`. Only an explicit operator override acknowledging this mismatch
  permits proceeding with the underclassed model; selecting a model or assigning the task is not an override.
- Otherwise proceed; re-check when scope grows.
`;
}
