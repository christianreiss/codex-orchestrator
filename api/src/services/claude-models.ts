import { ownerRuntimeFor } from '../control-plane/state/runtime.js';
import { setOwnedModelEnabled } from './model-availability.js';
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
import { MODEL_REGISTRY, modelTable, offeredModelIds, registryModels, upgradeMap, type ClaudeModel, type ClaudeModelLine } from './model-registry/index.js';

export const CLAUDE_DEFAULT_MODEL = MODEL_REGISTRY.claude.defaultModel as ClaudeModel;

/**
 * Claude models the fleet offers, in picker order, from the fleet model
 * registry (`model-registry/data.ts` records the vendor/native evidence).
 * Account and provider restrictions still apply; membership grants no access.
 */
export const CLAUDE_SUPPORTED_MODELS = offeredModelIds('claude') as readonly ClaudeModel[];

export type { ClaudeModel, ClaudeModelLine } from './model-registry/index.js';

/**
 * Legacy / vendor-public-id aliases that map onto our short ids: each registry
 * entry's `upgradesFrom` (the vendor's "Recommended replacement") plus its
 * active short `aliases`. Active models are never rewritten.
 */
export const CLAUDE_LEGACY_MODEL_UPGRADES = upgradeMap('claude') as Record<string, ClaudeModel>;

export const CLAUDE_MODEL_ENV_KEYS: readonly string[] = ['ANTHROPIC_MODEL', 'ANTHROPIC_DEFAULT_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL', 'ANTHROPIC_DEFAULT_FABLE_MODEL', 'ANTHROPIC_SMALL_FAST_MODEL', 'CLAUDE_CODE_SUBAGENT_MODEL'];

/** Canonicalize known retired/deprecated IDs without rewriting custom providers. */
export function normalizeClaudeModelReference(value: string): string {
  const trimmed = value.trim();
  const suffix = /\[1m\]$/i.test(trimmed) ? '[1m]' : '';
  const base = suffix ? trimmed.slice(0, -4) : trimmed;
  const key = base.toLowerCase();
  const replacement = Object.hasOwn(CLAUDE_LEGACY_MODEL_UPGRADES, key)
    ? CLAUDE_LEGACY_MODEL_UPGRADES[key]
    : undefined;
  return replacement ? replacement + suffix : trimmed;
}

/**
 * Per-model metadata surfaced by the Models API: human-readable name, context
 * window (`max_input_tokens`) and output cap (`max_tokens`), from the registry.
 * The `capabilities` tree the upstream API also returns is deliberately not
 * synthesised here — see docs/API.md.
 */
export const CLAUDE_MODEL_METADATA = Object.fromEntries(registryModels('claude').flatMap((entry) =>
  entry.api ? [[entry.id, { displayName: `Claude ${entry.label}`, maxInputTokens: entry.api.maxInputTokens, maxTokens: entry.api.maxTokens }]] : [],
)) as Record<ClaudeModel, { displayName: string; maxInputTokens: number; maxTokens: number }>;

/**
 * Models API `line` per catalog model. Explicit registry data, never parsed
 * from the id: platform.claude.com/docs/en/api/models/list (fetched
 * 2026-10-28) says clients must not infer a line from the `id`.
 */
export const CLAUDE_MODEL_LINES = Object.fromEntries(registryModels('claude').flatMap((entry) =>
  entry.api ? [[entry.id, entry.api.line]] : [],
)) as Readonly<Record<ClaudeModel, ClaudeModelLine>>;

/** Persisted native effort levels (registry `efforts`); `max` is session-only. */
export const CLAUDE_MODEL_REASONING_EFFORTS: Readonly<Record<string, readonly string[]>> = modelTable('claude', (entry) => entry.efforts);

/** Native Claude Code availability (registry `minCliVersion`), not an API model minimum. */
export const CLAUDE_MODEL_MIN_CLI_VERSIONS: Readonly<Record<string, string>> = modelTable('claude', (entry) => entry.minCliVersion);

/** Native CLI defaults, independent of API request defaults and account policy. */
export const CLAUDE_MODEL_DEFAULT_REASONING_EFFORTS: Readonly<Record<string, string | null>> = modelTable('claude', (entry) => entry.defaultEffort);

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
  /** Models API model line (`opus`, `sonnet`, ...); see {@link CLAUDE_MODEL_LINES}. */
  line: ClaudeModelLine;
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
    const owner=ownerRuntimeFor(db);if(owner){owner.assertOwner();return new Set((owner.state.snapshot().setting(FLAG)??'').split(',').map(value=>value.trim().toLowerCase()).filter(Boolean));}
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
      if(ownerRuntimeFor(db))return setOwnedModelEnabled(db,FLAG,model,enabled);
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
      // Own properties only: a bare index would resolve an id like `toString`
      // or `constructor` to an inherited Object.prototype member instead of 404ing.
      const legacy = Object.prototype.hasOwnProperty.call(CLAUDE_LEGACY_MODEL_UPGRADES, lower)
        ? CLAUDE_LEGACY_MODEL_UPGRADES[lower]
        : undefined;
      const canonical: ClaudeModel | undefined =
        (CLAUDE_SUPPORTED_MODELS as readonly string[]).includes(lower)
          ? (lower as ClaudeModel)
          : legacy;
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

export function modelObject(id: ClaudeModel): ClaudeModelObject {
  const created = CATALOG_CREATED_AT;
  const meta = CLAUDE_MODEL_METADATA[id];
  return {
    type: 'model',
    id,
    display_name: meta.displayName,
    created_at: new Date(created * 1000).toISOString(),
    max_input_tokens: meta.maxInputTokens,
    max_tokens: meta.maxTokens,
    line: CLAUDE_MODEL_LINES[id],
    object: 'model',
    created,
    owned_by: 'anthropic',
  };
}
