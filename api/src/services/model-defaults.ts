import type { Database } from '../db/client.js';
import { ValidationError } from '../http/errors.js';
import {
  CLAUDE_MODEL_DEFAULT_REASONING_EFFORTS,
  CLAUDE_MODEL_REASONING_EFFORTS,
  DEFAULT_CODEX_MODEL,
  DEFAULT_CODEX_REASONING_EFFORT,
  MODEL_REASONING_EFFORTS,
} from './config-normalizer.js';
import { CLAUDE_DEFAULT_MODEL, CLAUDE_SUPPORTED_MODELS } from './claude-models.js';
import { ClientConfigService } from './client-config.js';
import { ENGINE_CLAUDE, type Engine } from '../util/engine.js';

export interface ModelDefaultsCatalogEntry {
  model: string;
  persistent_efforts: string[];
  default_effort: string | null;
}

export interface ModelDefaultsResponse {
  engine: Engine;
  model: string;
  reasoning_effort: string | null;
  catalog: ModelDefaultsCatalogEntry[];
}

export interface ModelDefaultsUpdate {
  model: string;
  reasoning_effort?: string | null;
}

const CODEX_CATALOG: readonly ModelDefaultsCatalogEntry[] = Object.entries(MODEL_REASONING_EFFORTS).map(
  ([model, efforts]) => ({
    model,
    persistent_efforts: [...efforts],
    default_effort: efforts.includes(DEFAULT_CODEX_REASONING_EFFORT)
      ? DEFAULT_CODEX_REASONING_EFFORT
      : (efforts[0] ?? null),
  }),
);

const CLAUDE_CATALOG: readonly ModelDefaultsCatalogEntry[] = CLAUDE_SUPPORTED_MODELS.map((model) => ({
  model,
  persistent_efforts: [...(CLAUDE_MODEL_REASONING_EFFORTS[model] ?? [])],
  default_effort: CLAUDE_MODEL_DEFAULT_REASONING_EFFORTS[model] ?? null,
}));

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function copyCatalog(entries: readonly ModelDefaultsCatalogEntry[]): ModelDefaultsCatalogEntry[] {
  return entries.map((entry) => ({ ...entry, persistent_efforts: [...entry.persistent_efforts] }));
}

export function modelDefaultsCatalog(engine: Engine): ModelDefaultsCatalogEntry[] {
  return copyCatalog(engine === ENGINE_CLAUDE ? CLAUDE_CATALOG : CODEX_CATALOG);
}

function defaultModel(engine: Engine): string {
  return engine === ENGINE_CLAUDE ? CLAUDE_DEFAULT_MODEL : DEFAULT_CODEX_MODEL;
}

function selectedCatalogEntry(
  engine: Engine,
  model: unknown,
): { entry: ModelDefaultsCatalogEntry; catalog: ModelDefaultsCatalogEntry[] } {
  const catalog = modelDefaultsCatalog(engine);
  const requested = typeof model === 'string' ? model : '';
  const entry =
    catalog.find((candidate) => candidate.model === requested) ??
    catalog.find((candidate) => candidate.model === defaultModel(engine));
  if (!entry) {
    throw new Error(`model defaults catalog is missing the ${engine} default`);
  }
  return { entry, catalog };
}

function responseFromSettings(engine: Engine, settings: Record<string, unknown>): ModelDefaultsResponse {
  const { entry, catalog } = selectedCatalogEntry(engine, settings.model);
  const rawEffort = engine === ENGINE_CLAUDE ? settings.effortLevel : settings.model_reasoning_effort;
  const reasoningEffort =
    typeof rawEffort === 'string' && entry.persistent_efforts.includes(rawEffort)
      ? rawEffort
      : entry.default_effort;
  return {
    engine,
    model: entry.model,
    reasoning_effort: reasoningEffort,
    catalog,
  };
}

function parseUpdate(
  engine: Engine,
  input: unknown,
): {
  model: string;
  reasoningEffort: string | null;
} {
  const body = asRecord(input);
  const allowedKeys = new Set(['model', 'reasoning_effort']);
  const extra = Object.keys(body).find((key) => !allowedKeys.has(key));
  if (extra) {
    throw new ValidationError(`Unexpected field: ${extra}`, { param: extra });
  }
  if (typeof body.model !== 'string' || body.model.trim() === '') {
    throw new ValidationError('model must be a supported model id', { param: 'model' });
  }
  const model = body.model.trim();
  const catalog = modelDefaultsCatalog(engine);
  const entry = catalog.find((candidate) => candidate.model === model);
  if (!entry) {
    throw new ValidationError(
      `model must be one of: ${catalog.map((candidate) => candidate.model).join(', ')}`,
      { param: 'model' },
    );
  }

  const rawEffort = body.reasoning_effort;
  if (rawEffort === undefined || rawEffort === null) {
    return { model, reasoningEffort: entry.default_effort };
  }
  if (typeof rawEffort !== 'string' || rawEffort.trim() === '') {
    throw new ValidationError('reasoning_effort must be a supported effort or null', {
      param: 'reasoning_effort',
    });
  }
  const reasoningEffort = rawEffort.trim();
  if (!entry.persistent_efforts.includes(reasoningEffort)) {
    const allowed = entry.persistent_efforts.length > 0 ? entry.persistent_efforts.join(', ') : 'none';
    throw new ValidationError(`reasoning_effort for ${model} must be one of: ${allowed}`, {
      param: 'reasoning_effort',
    });
  }
  return { model, reasoningEffort };
}

export class ModelDefaultsService {
  private readonly clientConfig: ClientConfigService;

  constructor(db: Database) {
    this.clientConfig = new ClientConfigService(db);
  }

  async get(engine: Engine): Promise<ModelDefaultsResponse> {
    const current = await this.clientConfig.adminFetch(engine);
    return responseFromSettings(engine, asRecord(current.settings));
  }

  async set(engine: Engine, input: unknown): Promise<ModelDefaultsResponse> {
    const update = parseUpdate(engine, input);
    const current = await this.clientConfig.adminFetch(engine);
    const settings: Record<string, unknown> = {
      ...asRecord(current.settings),
      model: update.model,
    };

    if (engine === ENGINE_CLAUDE) {
      delete settings.model_reasoning_effort;
      if (update.reasoningEffort === null) delete settings.effortLevel;
      else settings.effortLevel = update.reasoningEffort;
    } else {
      delete settings.effortLevel;
      if (update.reasoningEffort === null) delete settings.model_reasoning_effort;
      else settings.model_reasoning_effort = update.reasoningEffort;
    }

    const stored = await this.clientConfig.store(
      {
        settings,
        sha256: current.status === 'ok' ? current.sha256 : undefined,
      },
      null,
      engine,
    );
    return responseFromSettings(engine, asRecord(stored.settings));
  }
}
