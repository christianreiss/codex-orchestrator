/**
 * Generated views of the model registry that live outside the API process:
 * the admin SPA's model constants and the tier table in docs/model-tiers.md.
 * `npm run models:generate` writes both; test/unit/contract/frontend-model-registry.test.ts
 * fails while either has drifted.
 */
import { ENGINES } from '../../util/engine.js';
import { CLAUDE_ADVISOR_ALIASES } from './data.js';
import { MODEL_REGISTRY, offeredModelIds, registryEntry, registryModels } from './index.js';
import type { ModelEntry, ModelTier } from './types.js';

export const FRONTEND_MODELS_PATH = 'frontend/src/lib/constants/models.generated.ts';
export const TIER_DOC_PATH = 'docs/model-tiers.md';
export const TIER_TABLE_BEGIN = '<!-- BEGIN GENERATED: model tier table (npm run models:generate) -->';
export const TIER_TABLE_END = '<!-- END GENERATED: model tier table -->';

const json = (value: unknown): string => JSON.stringify(value);

function pickerLabel(entry: ModelEntry): string {
  return entry.liveCatalogRequired ? `${entry.label} (unverified)` : entry.label;
}

function options(engine: (typeof ENGINES)[number]): string {
  return offeredModelIds(engine)
    .map((id) => `  { label: ${json(pickerLabel(registryEntry(engine, id)!))}, value: ${json(id)} },`)
    .join('\n');
}

function perEngine(pick: (entry: ModelEntry) => unknown): string {
  return ENGINES.map((engine) => {
    const rows = registryModels(engine)
      .filter((entry) => entry.status !== 'retired' && pick(entry) !== undefined)
      .map((entry) => `    ${json(entry.id)}: ${json(pick(entry))},`);
    return `  ${engine}: {${rows.length ? `\n${rows.join('\n')}\n  ` : ''}},`;
  }).join('\n');
}

/** Source of `frontend/src/lib/constants/models.generated.ts`. */
export function renderFrontendModels(): string {
  const advisor = Object.keys(CLAUDE_ADVISOR_ALIASES)
    .map((alias) => `  { label: ${json(alias[0]!.toUpperCase() + alias.slice(1))}, value: ${json(alias)} },`)
    .join('\n');
  return `// GENERATED from api/src/services/model-registry/data.ts — do not edit.
// Regenerate with \`cd api && npm run models:generate\`; the API contract test
// test/unit/contract/frontend-model-registry.test.ts fails while this file is stale.

/** A picker choice: the stored model id and its label. */
export interface ModelOption {
  label: string;
  value: string;
}

export type ModelEngine = "codex" | "claude" | "grok";

/** Claude models the fleet offers, in picker order. */
export const CLAUDE_MODEL_OPTIONS: ModelOption[] = [
${options('claude')}
];

/** Codex models the fleet offers, in picker order. */
export const CODEX_MODELS: ModelOption[] = [
${options('codex')}
];

/** Grok Build subscription models the fleet offers, in picker order. */
export const GROK_MODEL_OPTIONS: ModelOption[] = [
${options('grok')}
];

/** Native Claude advisor aliases (settings.json \`advisorModel\`). */
export const ADVISOR_MODEL_OPTIONS: ModelOption[] = [
${advisor}
];

/** Fleet default model per engine (new configs, empty gateway requests). */
export const DEFAULT_MODELS: Record<ModelEngine, string> = {
${ENGINES.map((engine) => `  ${engine}: ${json(MODEL_REGISTRY[engine].defaultModel)},`).join('\n')}
};

/** Persisted native efforts per model. */
export const MODEL_EFFORTS: Record<ModelEngine, Record<string, string[]>> = {
${perEngine((entry) => [...entry.efforts])}
};

/** Oldest native CLI that offers a model; absent means no documented floor. */
export const MODEL_MIN_CLI_VERSIONS: Record<ModelEngine, Record<string, string>> = {
${perEngine((entry) => entry.minCliVersion)}
};
`;
}

const TIER_CLASS: Readonly<Record<ModelTier, string>> = {
  5: 'Frontier reasoning, exceptional complexity',
  4: 'Advanced reasoning, architecture, complex engineering',
  3: 'Strong autonomous engineering, complex implementation',
  2: 'Routine to moderately complex tasks',
  1: 'Simple, bounded tasks',
};

/** The tier table block of docs/model-tiers.md, markers included. */
export function renderTierTable(): string {
  const rows = ([5, 4, 3, 2, 1] as const).map((tier) => {
    const names: string[] = [];
    for (const engine of ENGINES) {
      for (const entry of registryModels(engine)) {
        if (entry.tier !== tier || entry.status === 'retired') continue;
        // Codex and Claude rank by family; Grok by exact model.
        const name = engine === 'grok' ? entry.label : entry.family[0]!.toUpperCase() + entry.family.slice(1);
        if (!names.includes(name)) names.push(name);
      }
    }
    return `| ${tier} | ${names.join(', ')} | ${TIER_CLASS[tier]} |`;
  });
  return `${TIER_TABLE_BEGIN}
| Tier | Models | Class |
| --- | --- | --- |
${rows.join('\n')}
${TIER_TABLE_END}`;
}

/** Replace the marked block in a markdown document. */
export function replaceTierTable(markdown: string): string {
  const start = markdown.indexOf(TIER_TABLE_BEGIN);
  const end = markdown.indexOf(TIER_TABLE_END);
  if (start === -1 || end === -1) throw new Error(`no ${TIER_TABLE_BEGIN} … ${TIER_TABLE_END} block in ${TIER_DOC_PATH}`);
  return markdown.slice(0, start) + renderTierTable() + markdown.slice(end + TIER_TABLE_END.length);
}
