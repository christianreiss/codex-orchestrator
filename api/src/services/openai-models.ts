/**
 * Catalog of OpenAI-compatible model identifiers exposed via `/v1/models`.
 *
 * Mirrors the shared Codex config catalog and legacy-upgrade map, so API keys,
 * baked config, and the admin picker cannot drift.
 */
import {
  DEFAULT_CODEX_MODEL,
  LEGACY_MODEL_UPGRADES,
  SUPPORTED_MODELS,
} from './config-normalizer.js';

export const OPENAI_MODELS = SUPPORTED_MODELS;

export const OPENAI_DEFAULT_MODEL = DEFAULT_CODEX_MODEL;

/** Older model IDs we silently upgrade to the current default. */
export const OPENAI_LEGACY_MODEL_UPGRADES = LEGACY_MODEL_UPGRADES;

export function isSupportedModel(value: string): boolean {
  return (OPENAI_MODELS as readonly string[]).includes(value);
}

/**
 * Resolve a client-supplied `model` field. Empty or missing → default. A legacy
 * alias is upgraded silently. Unknown values throw an `Unsupported model` error
 * for the route to translate into an `invalid_request_error` envelope.
 */
export function resolveRequestedModel(value: unknown): string {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  if (trimmed === '') return OPENAI_DEFAULT_MODEL;
  if (isSupportedModel(trimmed)) return trimmed;
  const lowered = trimmed.toLowerCase();
  const upgrade = OPENAI_LEGACY_MODEL_UPGRADES[lowered];
  if (upgrade) return upgrade;
  throw new UnsupportedModelError(trimmed);
}

export class UnsupportedModelError extends Error {
  constructor(public readonly model: string) {
    super(
      `Unsupported model "${model}". Supported models: ${OPENAI_MODELS.join(', ')}`,
    );
    this.name = 'UnsupportedModelError';
  }
}

export interface OpenAiModelObject {
  id: string;
  object: 'model';
  created: number;
  owned_by: string;
}

export interface OpenAiModelList {
  object: 'list';
  data: OpenAiModelObject[];
}

/**
 * Build the OpenAI-shape model catalog. Extra models can be passed in
 * (e.g. admin-curated additions); duplicates are deduped on `id`.
 */
export function buildModelList(extra: readonly string[] = []): OpenAiModelList {
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const id of [...OPENAI_MODELS, ...extra]) {
    if (!seen.has(id)) {
      seen.add(id);
      ids.push(id);
    }
  }
  const createdAt = Math.floor(Date.now() / 1000);
  return {
    object: 'list',
    data: ids.map((id) => ({
      id,
      object: 'model' as const,
      created: createdAt,
      owned_by: 'codex-orchestrator',
    })),
  };
}
