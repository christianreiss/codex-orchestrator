import { ownerRuntimeFor } from '../control-plane/state/runtime.js';
import { setOwnedModelEnabled } from './model-availability.js';
import { SettingsService } from './settings.js';
/**
 * Kimi Build subscription catalog service. The model list itself lives in the
 * fleet model registry with its evidence; API-key catalog IDs are separate.
 */
import { eq } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { versions } from '../db/schema.js';
import { ApiError } from '../http/errors.js';
import { MODEL_REGISTRY, modelTable, offeredModelIds, type KimiModel } from './model-registry/index.js';

export { KIMI_MIN_CLIENT_VERSION } from './kimi-auth.js';
/** Defaults, ids and efforts come from the fleet model registry (`model-registry/data.ts`). */
export const KIMI_DEFAULT_MODEL = MODEL_REGISTRY.kimi.defaultModel as KimiModel;
export const KIMI_SUPPORTED_MODELS = offeredModelIds('kimi') as readonly KimiModel[];
export type { KimiModel } from './model-registry/index.js';
export const KIMI_MODEL_REASONING_EFFORTS = modelTable('kimi', (entry) => entry.efforts) as Record<
  KimiModel,
  readonly string[]
>;
export const KIMI_MODEL_DEFAULT_REASONING_EFFORTS = modelTable(
  'kimi',
  (entry) => entry.defaultEffort ?? undefined,
) as Record<KimiModel, string>;
export const KIMI_MODEL_CONTEXT_TOKENS = 1_048_576;
/** Native subscription catalog windows (Kimi Build 1.0.46, 2026-10-03). */
export const KIMI_CONTEXT_WINDOWS = [262_144, 1_048_576] as const;
export const KIMI_DEFAULT_CONTEXT_WINDOW = 262_144;

export function normalizeKimiContextWindow(value: unknown): number | null {
  return typeof value === 'number' && (KIMI_CONTEXT_WINDOWS as readonly number[]).includes(value)
    ? value
    : null;
}

export function normalizeKimiModel(value: unknown): KimiModel | null {
  return typeof value === 'string' && (KIMI_SUPPORTED_MODELS as readonly string[]).includes(value.trim())
    ? (value.trim() as KimiModel)
    : null;
}

export function normalizeKimiEffort(value: unknown, model: unknown = KIMI_DEFAULT_MODEL): string | null {
  const selected = normalizeKimiModel(model) ?? KIMI_DEFAULT_MODEL;
  return typeof value === 'string' && KIMI_MODEL_REASONING_EFFORTS[selected].includes(value.trim())
    ? value.trim()
    : null;
}

export function createKimiModelsService(db: Database) {
  async function disabledSet() {
    const owner = ownerRuntimeFor(db);
    if (owner) {
      owner.assertOwner();
      return new Set(
        (owner.state.snapshot().setting('kimi_models_disabled') ?? '').split(',').filter(Boolean),
      );
    }
    const rows = await db.select().from(versions).where(eq(versions.name, 'kimi_models_disabled')).limit(1);
    return new Set((rows[0]?.version ?? '').split(',').filter(Boolean));
  }
  async function catalog() {
    const disabled = await disabledSet();
    return KIMI_SUPPORTED_MODELS.map((id) => ({
      id,
      enabled: !disabled.has(id),
      ownedBy: 'moonshotai' as const,
    }));
  }
  return {
    supportedModels: () => KIMI_SUPPORTED_MODELS,
    disabledSet,
    catalog,
    async setEnabled(model: KimiModel, enabled: boolean) {
      if (ownerRuntimeFor(db)) return setOwnedModelEnabled(db, 'kimi_models_disabled', model, enabled);
      const disabled = await disabledSet();
      if (enabled) disabled.delete(model);
      else disabled.add(model);
      await db
        .insert(versions)
        .values({
          name: 'kimi_models_disabled',
          version: [...disabled].sort().join(','),
          updatedAt: new Date().toISOString(),
        })
        .onDuplicateKeyUpdate({
          set: { version: [...disabled].sort().join(','), updatedAt: new Date().toISOString() },
        });
    },
    async resolveRequestedModel(value: unknown): Promise<KimiModel> {
      const defaultRequested = value === undefined || value === null || value === '';
      const saved = defaultRequested ? await new SettingsService(db).getString('kimi_default_model') : null;
      const model = defaultRequested
        ? (normalizeKimiModel(saved) ?? KIMI_DEFAULT_MODEL)
        : normalizeKimiModel(value);
      if (!model)
        throw new ApiError('Unsupported Kimi model', {
          status: 404,
          code: 'model_not_found',
          param: 'model',
        });
      if ((await disabledSet()).has(model))
        throw new ApiError('Kimi model is disabled', { status: 403, code: 'model_disabled', param: 'model' });
      return model;
    },
    async modelsResponse() {
      return {
        object: 'list' as const,
        data: (await catalog())
          .filter((m) => m.enabled)
          .map((m) => ({ id: m.id, object: 'model' as const, created: 1790812800, owned_by: 'moonshotai' })),
      };
    },
  };
}

export const KIMI_MODEL_CONTEXT_WINDOWS: Record<KimiModel, number> = {
  'k3.1-pro': 1_048_576,
  'k3.1-pro-highspeed': 1_048_576,
  k3: 1_048_576,
  'k3-256k': 262_144,
  'kimi-for-coding': 262_144,
  'kimi-for-coding-highspeed': 262_144,
};
