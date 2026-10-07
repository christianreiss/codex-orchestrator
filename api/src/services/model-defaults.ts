import type { Database } from '../db/client.js';
import { ValidationError } from '../http/errors.js';
import {
  CLAUDE_MODEL_DEFAULT_REASONING_EFFORTS,
  CLAUDE_MODEL_REASONING_EFFORTS,
  CODEX_MODEL_DEFAULT_REASONING_EFFORTS,
  DEFAULT_CODEX_MODEL,
  MODEL_REASONING_EFFORTS,
  SUPPORTED_MODELS,
} from './config-normalizer.js';
import { CLAUDE_DEFAULT_MODEL, CLAUDE_SUPPORTED_MODELS } from './claude-models.js';
import { ClientConfigService } from './client-config.js';
import { withGrokConfigWriteLock } from './grok-config-lock.js';
import { ENGINE_CLAUDE, ENGINE_GROK, type Engine } from '../util/engine.js';
import { GROK_CONTEXT_WINDOWS, GROK_DEFAULT_CONTEXT_WINDOW, GROK_DEFAULT_MODEL, GROK_MODEL_DEFAULT_REASONING_EFFORTS, GROK_MODEL_REASONING_EFFORTS, GROK_SUPPORTED_MODELS, normalizeGrokContextWindow } from './grok-models.js';

export interface ModelDefaultsCatalogEntry {
  model: string;
  persistent_efforts: string[];
  default_effort: string | null;
  context_windows?: number[];
  default_context_window?: number;
}

export interface ModelDefaultsResponse {
  engine: Engine;
  model: string;
  reasoning_effort: string | null;
  context_window?: number;
  catalog: ModelDefaultsCatalogEntry[];
}

export interface ModelDefaultsUpdate {
  model: string;
  reasoning_effort?: string | null;
  context_window?: number | null;
}

const CODEX_CATALOG: readonly ModelDefaultsCatalogEntry[] = SUPPORTED_MODELS.map(
  (model) => {
    const efforts = MODEL_REASONING_EFFORTS[model];
    const defaultEffort = CODEX_MODEL_DEFAULT_REASONING_EFFORTS[model];
    if (!efforts || !defaultEffort || !efforts.includes(defaultEffort)) {
      throw new Error(`Codex model catalog is incomplete for ${model}`);
    }
    return {
      model,
      persistent_efforts: [...efforts],
      default_effort: defaultEffort,
    };
  },
);

const CLAUDE_CATALOG: readonly ModelDefaultsCatalogEntry[] = CLAUDE_SUPPORTED_MODELS.map((model) => {
  const efforts = CLAUDE_MODEL_REASONING_EFFORTS[model];
  const hasDefault = Object.hasOwn(CLAUDE_MODEL_DEFAULT_REASONING_EFFORTS, model);
  const defaultEffort = CLAUDE_MODEL_DEFAULT_REASONING_EFFORTS[model] ?? null;
  if (!efforts || !hasDefault || (defaultEffort !== null && !efforts.includes(defaultEffort))) {
    throw new Error(`Claude model catalog is incomplete for ${model}`);
  }
  return {
    model,
    persistent_efforts: [...efforts],
    default_effort: defaultEffort,
  };
});

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function copyCatalog(entries: readonly ModelDefaultsCatalogEntry[]): ModelDefaultsCatalogEntry[] {
  return entries.map((entry) => ({ ...entry, persistent_efforts: [...entry.persistent_efforts] }));
}

export function modelDefaultsCatalog(engine: Engine): ModelDefaultsCatalogEntry[] {
  if (engine === ENGINE_GROK) return GROK_SUPPORTED_MODELS.map(model => ({
    model,
    persistent_efforts: [...GROK_MODEL_REASONING_EFFORTS[model]],
    default_effort: GROK_MODEL_DEFAULT_REASONING_EFFORTS[model],
    context_windows: [...GROK_CONTEXT_WINDOWS],
    default_context_window: GROK_DEFAULT_CONTEXT_WINDOW,
  }));
  return copyCatalog(engine === ENGINE_CLAUDE ? CLAUDE_CATALOG : CODEX_CATALOG);
}

function defaultModel(engine: Engine): string {
  if (engine === ENGINE_GROK) return GROK_DEFAULT_MODEL;
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
  const rawEffort = engine === ENGINE_CLAUDE ? settings.effortLevel : engine === ENGINE_GROK ? settings.reasoning_effort : settings.model_reasoning_effort;
  const reasoningEffort =
    typeof rawEffort === 'string' && entry.persistent_efforts.includes(rawEffort)
      ? rawEffort
      : entry.default_effort;
  return {
    engine,
    model: entry.model,
    reasoning_effort: reasoningEffort,
    ...(engine === ENGINE_GROK && { context_window: normalizeGrokContextWindow(settings.context_window) ?? GROK_DEFAULT_CONTEXT_WINDOW }),
    catalog,
  };
}

function parseUpdate(
  engine: Engine,
  input: unknown,
): {
  model: string;
  reasoningEffort: string | null;
  contextWindow?: number;
} {
  const body = asRecord(input);
  const allowedKeys = new Set(['model', 'reasoning_effort']);
  if (engine === ENGINE_GROK) allowedKeys.add('context_window');
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

  const contextWindow = body.context_window === null ? entry.default_context_window
    : body.context_window === undefined ? undefined : normalizeGrokContextWindow(body.context_window);
  if (contextWindow === null) {
    throw new ValidationError(`context_window must be one of: ${entry.context_windows?.join(', ')}`, { param: 'context_window' });
  }
  const rawEffort = body.reasoning_effort;
  if (rawEffort === undefined || rawEffort === null) {
    return { model, reasoningEffort: entry.default_effort, contextWindow };
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
  return { model, reasoningEffort, contextWindow };
}

export class ModelDefaultsService {
  private readonly clientConfig: ClientConfigService;

  constructor(private readonly db: Database, grokConfigLocked = false) {
    this.clientConfig = new ClientConfigService(db, grokConfigLocked);
  }

  /** Explicit Grok provisioning initializes the fleet config; reads stay read-only. */
  async ensureGrokDefaults(): Promise<boolean> {
    return withGrokConfigWriteLock(this.db, async (tx, existing) => {
      if (existing) return false;
      await new ModelDefaultsService(tx, true).set(ENGINE_GROK, {
        model: GROK_DEFAULT_MODEL,
        reasoning_effort: GROK_MODEL_DEFAULT_REASONING_EFFORTS[GROK_DEFAULT_MODEL],
      });
      return true;
    });
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

    if (engine === ENGINE_GROK) {
      delete settings.model_reasoning_effort;
      delete settings.effortLevel;
      settings.reasoning_effort = update.reasoningEffort;
      // Older model/effort-only callers must retain the saved window.
      if (update.contextWindow !== undefined) settings.context_window = update.contextWindow;
    } else if (engine === ENGINE_CLAUDE) {
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
