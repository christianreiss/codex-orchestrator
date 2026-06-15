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

export const CLAUDE_DEFAULT_MODEL = 'claude-sonnet-4-6';

/** Order matters: first entry is the canonical default. */
export const CLAUDE_SUPPORTED_MODELS = [
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
  'claude-3-opus-20240229': 'claude-opus-4-7',
  'claude-3-5-sonnet-20240620': 'claude-sonnet-4-6',
  'claude-3-5-sonnet-20241022': 'claude-sonnet-4-6',
  'claude-3-5-sonnet-latest': 'claude-sonnet-4-6',
  'claude-3-haiku-20240307': 'claude-haiku-4-5-20251001',
  'claude-3-5-haiku-latest': 'claude-haiku-4-5-20251001',
  'claude-opus-4-20250514': 'claude-opus-4-7',
  'claude-sonnet-4-20250514': 'claude-sonnet-4-6',
  'claude-sonnet-4-5': 'claude-sonnet-4-6',
  // Heal ids issued by the pre-2026-06-15 admin picker, which offered the short
  // `claude-opus-4-6` / `claude-haiku-4-5` ids that this gate never accepted.
  // Upgrade already-stored overrides/requests instead of 400-ing them.
  'claude-opus-4-6': 'claude-opus-4-7',
  'claude-haiku-4-5': 'claude-haiku-4-5-20251001',
};

export interface ClaudeModelInfo {
  id: ClaudeModel;
  enabled: boolean;
  ownedBy: 'anthropic';
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
   * falls back to the default. Throws ApiError(400) for unsupported ids.
   */
  resolveRequestedModel(value: unknown): Promise<ClaudeModel>;
  /** Anthropic-shaped /models response body. */
  modelsResponse(): Promise<{
    data: Array<{ id: ClaudeModel; object: 'model'; created: number; owned_by: 'anthropic' }>;
    object: 'list';
  }>;
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
        throw new ApiError(
          `Unsupported model "${raw}". Supported models: ${CLAUDE_SUPPORTED_MODELS.join(', ')}`,
          { status: 400, code: 'model_not_found', type: 'invalid_request_error', param: 'model' },
        );
      }
      const disabled = await loadDisabled();
      if (disabled.has(canonical)) {
        throw new ApiError(`Model "${canonical}" is disabled by administrator`, {
          status: 400,
          code: 'model_disabled',
          type: 'invalid_request_error',
          param: 'model',
        });
      }
      return canonical;
    },

    async modelsResponse() {
      const catalog = await this.catalog();
      const created = Math.floor(Date.now() / 1000);
      return {
        data: catalog
          .filter((m) => m.enabled)
          .map((m) => ({
            id: m.id,
            object: 'model' as const,
            created,
            owned_by: 'anthropic' as const,
          })),
        object: 'list' as const,
      };
    },
  };
}
