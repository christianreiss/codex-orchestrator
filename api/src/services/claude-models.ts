/**
 * Claude (Anthropic) model catalog. Port of src/Services/ClaudeModelService.php
 * + src/Support/ConfigNormalizer::CLAUDE_SUPPORTED_MODELS.
 *
 * Static list, plus optional admin overrides stored in the `versions` table
 * under `claude_models_disabled` (comma-separated model ids) — admins may
 * temporarily disable a model without redeploying.
 */
import { eq } from 'drizzle-orm';
import { versions } from '../db/schema.js';
import type { Database } from '../db/client.js';
import { ApiError } from '../http/errors.js';

export const CLAUDE_DEFAULT_MODEL = 'claude-sonnet-5';

/** Current models first, followed by supported pinned predecessors. */
export const CLAUDE_SUPPORTED_MODELS = [
  'claude-fable-5',
  'claude-opus-4-8',
  'claude-sonnet-5',
  'claude-opus-4-7',
  'claude-sonnet-4-6',
  'claude-haiku-4-5-20251001',
] as const;

export type ClaudeModel = (typeof CLAUDE_SUPPORTED_MODELS)[number];

/**
 * Legacy / vendor-public-id aliases that map onto our short ids. Keeps the
 * Anthropic SDK's "current generation" model names working out of the box.
 */
export const CLAUDE_LEGACY_MODEL_UPGRADES: Record<string, ClaudeModel> = {
  'claude-3-opus-20240229': 'claude-opus-4-8',
  'claude-3-5-sonnet-20240620': 'claude-sonnet-5',
  'claude-3-5-sonnet-20241022': 'claude-sonnet-5',
  'claude-3-5-sonnet-latest': 'claude-sonnet-5',
  'claude-3-haiku-20240307': 'claude-haiku-4-5-20251001',
  'claude-3-5-haiku-latest': 'claude-haiku-4-5-20251001',
  'claude-opus-4-20250514': 'claude-opus-4-8',
  'claude-sonnet-4-20250514': 'claude-sonnet-5',
  'claude-sonnet-4-5': 'claude-sonnet-5',
  // Heal ids issued by the pre-2026-06-15 admin picker, which offered the short
  // `claude-opus-4-6` / `claude-haiku-4-5` ids that this gate never accepted.
  // Upgrade already-stored overrides/requests instead of 400-ing them.
  'claude-opus-4-6': 'claude-opus-4-8',
  'claude-haiku-4-5': 'claude-haiku-4-5-20251001',
};

/**
 * Per-model metadata surfaced by the Models API: human-readable name, context
 * window (`max_input_tokens`) and output cap (`max_tokens`). Values track the
 * published vendor catalog. The `capabilities` tree the upstream API also
 * returns is deliberately not synthesised here — see docs/API.md.
 */
export const CLAUDE_MODEL_METADATA: Record<
  ClaudeModel,
  { displayName: string; maxInputTokens: number; maxTokens: number }
> = {
  'claude-fable-5': { displayName: 'Claude Fable 5', maxInputTokens: 1_000_000, maxTokens: 128_000 },
  'claude-opus-4-8': { displayName: 'Claude Opus 4.8', maxInputTokens: 1_000_000, maxTokens: 128_000 },
  'claude-sonnet-5': { displayName: 'Claude Sonnet 5', maxInputTokens: 1_000_000, maxTokens: 128_000 },
  'claude-opus-4-7': { displayName: 'Claude Opus 4.7', maxInputTokens: 1_000_000, maxTokens: 128_000 },
  'claude-sonnet-4-6': { displayName: 'Claude Sonnet 4.6', maxInputTokens: 1_000_000, maxTokens: 128_000 },
  'claude-haiku-4-5-20251001': { displayName: 'Claude Haiku 4.5', maxInputTokens: 200_000, maxTokens: 64_000 },
};

export interface ClaudeModelInfo {
  id: ClaudeModel;
  enabled: boolean;
  ownedBy: 'anthropic';
}

/**
 * A single entry of the Anthropic Models API response.
 *
 * `type` / `display_name` / `created_at` are the canonical Anthropic fields —
 * the official SDKs (`client.models.list()` / `.retrieve()`) read these.
 * `object` / `created` / `owned_by` are retained for the OpenAI-shaped clients
 * that this gateway has always served; they are deprecated but harmless extras.
 */
export interface ClaudeModelObject {
  type: 'model';
  id: ClaudeModel;
  display_name: string;
  created_at: string;
  max_input_tokens: number;
  max_tokens: number;
  /** @deprecated OpenAI-compat alias for `type`. */
  object: 'model';
  /** @deprecated OpenAI-compat unix-seconds alias for `created_at`. */
  created: number;
  /** @deprecated OpenAI-compat extra. */
  owned_by: 'anthropic';
}

export interface ClaudeModelsService {
  /** All known model identifiers, regardless of enabled state. */
  supportedModels(): readonly ClaudeModel[];
  /** Catalog with current admin-toggle state. */
  catalog(): Promise<ClaudeModelInfo[]>;
  /** Admin set of disabled model ids. */
  disabledSet(): Promise<Set<string>>;
  /** Set the disabled flag for a model. */
  setEnabled(model: ClaudeModel, enabled: boolean): Promise<void>;
  /**
   * Resolve a caller-supplied model string to a supported id. Empty/missing
   * falls back to the default. Throws ApiError(404) for unknown ids and
   * ApiError(403) for admin-disabled ones, matching upstream semantics.
   */
  resolveRequestedModel(value: unknown): Promise<ClaudeModel>;
  /** Anthropic-shaped `GET /models` response body. */
  modelsResponse(): Promise<{
    data: ClaudeModelObject[];
    has_more: boolean;
    first_id: string | null;
    last_id: string | null;
    /** @deprecated OpenAI-compat extra. */
    object: 'list';
  }>;
  /** Anthropic-shaped `GET /models/{id}` response body. */
  modelResponse(value: unknown): Promise<ClaudeModelObject>;
}

const FLAG = 'claude_models_disabled';

export function createClaudeModelsService(db: Database): ClaudeModelsService {
  let cache: { disabled: Set<string>; ts: number } | null = null;
  const TTL_MS = 5_000;

  async function loadDisabled(): Promise<Set<string>> {
    if (cache && Date.now() - cache.ts < TTL_MS) return cache.disabled;
    const rows = await db.select().from(versions).where(eq(versions.name, FLAG)).limit(1);
    const raw = rows[0]?.version ?? '';
    const set = new Set(
      raw
        .split(',')
        .map((s) => s.trim().toLowerCase())
        .filter((s) => s.length > 0),
    );
    cache = { disabled: set, ts: Date.now() };
    return set;
  }

  return {
    supportedModels(): readonly ClaudeModel[] {
      return CLAUDE_SUPPORTED_MODELS;
    },

    async catalog(): Promise<ClaudeModelInfo[]> {
      const disabled = await loadDisabled();
      return CLAUDE_SUPPORTED_MODELS.map((id) => ({
        id,
        enabled: !disabled.has(id),
        ownedBy: 'anthropic' as const,
      }));
    },

    async disabledSet(): Promise<Set<string>> {
      return loadDisabled();
    },

    async setEnabled(model, enabled) {
      const current = new Set(await loadDisabled());
      if (enabled) current.delete(model);
      else current.add(model);
      const serialized = Array.from(current).sort().join(',');
      const now = new Date().toISOString();
      const existing = await db.select().from(versions).where(eq(versions.name, FLAG)).limit(1);
      if (existing[0]) {
        await db
          .update(versions)
          .set({ version: serialized, updatedAt: now })
          .where(eq(versions.name, FLAG));
      } else {
        await db.insert(versions).values({ name: FLAG, version: serialized, updatedAt: now });
      }
      cache = null;
    },

    async resolveRequestedModel(value) {
      const raw = typeof value === 'string' ? value.trim() : '';
      if (raw === '') return CLAUDE_DEFAULT_MODEL;
      const lower = raw.toLowerCase();
      const canonical: ClaudeModel | undefined =
        (CLAUDE_SUPPORTED_MODELS as readonly string[]).includes(lower)
          ? (lower as ClaudeModel)
          : CLAUDE_LEGACY_MODEL_UPGRADES[lower];
      if (!canonical) {
        // Upstream returns 404 not_found_error for an unknown/typo'd model id.
        throw new ApiError(
          `Unsupported model "${raw}". Supported models: ${CLAUDE_SUPPORTED_MODELS.join(', ')}`,
          { status: 404, code: 'model_not_found', type: 'not_found_error', param: 'model' },
        );
      }
      const disabled = await loadDisabled();
      if (disabled.has(canonical)) {
        // Same shape upstream uses when a key may not reach a model.
        throw new ApiError(`Model "${canonical}" is disabled by administrator`, {
          status: 403,
          code: 'model_disabled',
          type: 'permission_error',
          param: 'model',
        });
      }
      return canonical;
    },

    async modelsResponse() {
      const catalog = await this.catalog();
      const enabled = catalog.filter((m) => m.enabled);
      const data = enabled.map((m) => modelObject(m.id));
      return {
        data,
        has_more: false,
        first_id: data[0]?.id ?? null,
        last_id: data[data.length - 1]?.id ?? null,
        object: 'list' as const,
      };
    },

    async modelResponse(value) {
      // Unlike a generation request, a lookup has no sensible default: an empty
      // id is a 404, not the fallback model.
      if (typeof value !== 'string' || value.trim() === '') {
        throw new ApiError('Model not found', {
          status: 404,
          code: 'model_not_found',
          type: 'not_found_error',
          param: 'model_id',
        });
      }
      return modelObject(await this.resolveRequestedModel(value));
    },
  };
}

/**
 * Stable placeholder creation time. This gateway does not track vendor release
 * dates, but the field must not move between polls the way `Date.now()` would —
 * upstream `created_at` is a fixed per-model release date.
 */
const CATALOG_CREATED_AT = Math.floor(Date.UTC(2026, 0, 1) / 1000);

function modelObject(id: ClaudeModel): ClaudeModelObject {
  const created = CATALOG_CREATED_AT;
  const meta = CLAUDE_MODEL_METADATA[id];
  return {
    type: 'model',
    id,
    display_name: meta.displayName,
    created_at: new Date(created * 1000).toISOString(),
    max_input_tokens: meta.maxInputTokens,
    max_tokens: meta.maxTokens,
    object: 'model',
    created,
    owned_by: 'anthropic',
  };
}
