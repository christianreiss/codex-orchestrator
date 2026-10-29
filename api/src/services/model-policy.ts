/** One family/version policy shared by admin choices, gateways and signed launches. */
import type { Database } from '../db/client.js';
import type { Engine } from '../util/engine.js';
import { ApiError } from '../http/errors.js';
import { SettingsService } from './settings.js';
import { SUPPORTED_MODELS, LEGACY_MODEL_UPGRADES } from './config-normalizer.js';
import { CLAUDE_SUPPORTED_MODELS, CLAUDE_LEGACY_MODEL_UPGRADES } from './claude-models.js';
import { GROK_SUPPORTED_MODELS } from './grok-models.js';
import { liveCatalogRequired, registryEntry } from './model-registry/index.js';

export interface ModelPolicy {
  engine: Engine;
  latest_only: boolean;
  latest_models: string[];
  replacements: Record<string, string>;
  disabled_models?: string[];
}

export function modelPolicyKey(engine: Engine): string { return `${engine}_models_latest_only`; }

/** Family from the registry; the version ordering within it is parsed from the id. */
function familyVersion(engine: Engine, model: string): { family: string; version: number[] } {
  const family = registryEntry(engine, model)?.family;
  const match = engine === 'codex' ? /^gpt-(\d+(?:\.\d+)*?)-(.+)$/.exec(model)
    : engine === 'claude' ? /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?$/.exec(model)
    : /^grok-(\d+(?:\.\d+)*)(.*)$/.exec(model);
  if (!match || !family) throw new Error(`Missing model family metadata: ${engine}/${model}`);
  return engine === 'claude'
    ? { family, version: [Number(match[2]), Number(match[3] ?? 0)] }
    : { family, version: match[1]!.split('.').map(Number) };
}

export function buildModelPolicy(engine: Engine, latest_only = false): ModelPolicy {
  const models: readonly string[] = engine === 'codex' ? SUPPORTED_MODELS : engine === 'claude' ? CLAUDE_SUPPORTED_MODELS : GROK_SUPPORTED_MODELS;
  const latest = new Map<string, { model: string; version: number[] }>();
  // An unverified (live-catalog-gated) model is never a family-latest target:
  // latest-only must not rewrite working selections to an id an account may lack.
  for (const model of models.filter(model => !liveCatalogRequired(engine, model))) {
    const { family, version } = familyVersion(engine, model);
    const previous = latest.get(family);
    const order = previous ? version.reduce((result, part, i) => result || part - (previous.version[i] ?? 0), 0) : 1;
    if (order > 0) latest.set(family, { model, version });
  }
  const replacements = Object.fromEntries(models.map(model => [model,
    liveCatalogRequired(engine, model) ? model : latest.get(familyVersion(engine, model).family)!.model]));
  // Preserve the existing engine canonicalization for retired IDs as well.
  const legacy = engine === 'codex' ? LEGACY_MODEL_UPGRADES : engine === 'claude' ? CLAUDE_LEGACY_MODEL_UPGRADES : {};
  for (const [alias, canonical] of Object.entries(legacy)) {
    if (Object.hasOwn(replacements, canonical)) replacements[alias] = replacements[canonical]!;
  }
  return { engine, latest_only, latest_models: models.filter(model => replacements[model] === model && !liveCatalogRequired(engine, model)), replacements };
}

export async function readModelPolicy(db: Database, engine: Engine): Promise<ModelPolicy> {
  const settings = new SettingsService(db);
  const policy = buildModelPolicy(engine, await settings.getFlag(modelPolicyKey(engine)));
  if (policy.latest_only && engine !== 'codex') policy.disabled_models = (await settings.getString(`${engine}_models_disabled`) ?? '').split(',').filter(Boolean);
  return policy;
}

export function applyModelPolicy(policy: ModelPolicy, model: string): string {
  if (!policy.latest_only) return model;
  const next = Object.hasOwn(policy.replacements, model) ? policy.replacements[model] : undefined;
  if (!next) throw new ApiError(`Unsupported ${policy.engine} model: ${model}`, { status: 404, code: 'model_not_found', param: 'model' });
  return next;
}
