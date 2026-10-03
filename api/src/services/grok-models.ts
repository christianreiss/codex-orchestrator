/**
 * Official Grok Build 1.0.46's subscription catalog, re-verified 2026-10-03 against the
 * live `cli-chat-proxy.grok.com/v1/models` listing and its `default_model` setting.
 * API-key catalog IDs are separate.
 */
import { eq } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { versions } from '../db/schema.js';
import { ApiError } from '../http/errors.js';

export { GROK_MIN_CLIENT_VERSION } from './client-versions.js';
export const GROK_DEFAULT_MODEL = 'grok-4.7';
export const GROK_SUPPORTED_MODELS = ['grok-4.7', 'grok-4.7-build-fast', 'grok-4.6', 'grok-4.5'] as const;
export type GrokModel = (typeof GROK_SUPPORTED_MODELS)[number];
export const GROK_MODEL_REASONING_EFFORTS: Record<GrokModel, readonly string[]> = {
  'grok-4.7': ['low', 'medium', 'high', 'xhigh'],
  'grok-4.7-build-fast': ['low', 'medium', 'high', 'xhigh'],
  'grok-4.6': ['low', 'medium', 'high', 'xhigh'],
  'grok-4.5': ['low', 'medium', 'high'],
};
export const GROK_MODEL_DEFAULT_REASONING_EFFORTS: Record<GrokModel, string> = {
  'grok-4.7': 'high', 'grok-4.7-build-fast': 'high', 'grok-4.6': 'high', 'grok-4.5': 'high',
};
export const GROK_MODEL_CONTEXT_TOKENS = 500_000;

export function normalizeGrokModel(value: unknown): GrokModel | null {
  return typeof value === 'string' && (GROK_SUPPORTED_MODELS as readonly string[]).includes(value.trim())
    ? value.trim() as GrokModel : null;
}

export function normalizeGrokEffort(value: unknown, model: unknown = GROK_DEFAULT_MODEL): string | null {
  const selected = normalizeGrokModel(model) ?? GROK_DEFAULT_MODEL;
  return typeof value === 'string' && GROK_MODEL_REASONING_EFFORTS[selected].includes(value.trim())
    ? value.trim() : null;
}

export function createGrokModelsService(db: Database) {
  async function disabledSet() {
    const rows = await db.select().from(versions).where(eq(versions.name, 'grok_models_disabled')).limit(1);
    return new Set((rows[0]?.version ?? '').split(',').filter(Boolean));
  }
  async function catalog() {
    const disabled = await disabledSet();
    return GROK_SUPPORTED_MODELS.map(id => ({ id, enabled: !disabled.has(id), ownedBy: 'xai' as const }));
  }
  return {
    supportedModels: () => GROK_SUPPORTED_MODELS,
    disabledSet,
    catalog,
    async setEnabled(model: GrokModel, enabled: boolean) {
      const disabled = await disabledSet();
      if (enabled) disabled.delete(model); else disabled.add(model);
      await db.insert(versions).values({ name: 'grok_models_disabled', version: [...disabled].sort().join(','), updatedAt: new Date().toISOString() })
        .onDuplicateKeyUpdate({ set: { version: [...disabled].sort().join(','), updatedAt: new Date().toISOString() } });
    },
    async resolveRequestedModel(value: unknown): Promise<GrokModel> {
      const defaultRequested = value === undefined || value === null || value === '';
      const saved = defaultRequested ? (await db.select().from(versions).where(eq(versions.name, 'grok_default_model')).limit(1))[0]?.version : null;
      const model = defaultRequested ? normalizeGrokModel(saved) ?? GROK_DEFAULT_MODEL : normalizeGrokModel(value);
      if (!model) throw new ApiError('Unsupported Grok model', { status: 404, code: 'model_not_found', param: 'model' });
      if ((await disabledSet()).has(model)) throw new ApiError('Grok model is disabled', { status: 403, code: 'model_disabled', param: 'model' });
      return model;
    },
    async modelsResponse() {
      return { object: 'list' as const, data: (await catalog()).filter(m => m.enabled).map(m => ({ id: m.id, object: 'model' as const, created: 1790812800, owned_by: 'xai' })) };
    },
  };
}
