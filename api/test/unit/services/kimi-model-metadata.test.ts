import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { ClientConfigService, kimiSettingsDocument, normalizeKimiSettings, renderKimiSettings, renderTomlForHost } from '../../../src/services/client-config.js';
import { ModelDefaultsService, modelDefaultsCatalog } from '../../../src/services/model-defaults.js';
import { KIMI_SUPPORTED_MODELS } from '../../../src/services/kimi-models.js';
import { clientConfigDocuments } from '../../../src/db/schema.js';
import { createDbFake } from '../../helpers/db-fake.js';

type Row = Record<string, unknown>;
interface NativeThinkingMeta { supportEfforts?: string[]; defaultEffort?: string; offEffort?: string; alwaysThinking?: boolean; adaptiveThinking?: boolean }
interface NativeSpec { provider: string; name: string; capability: Record<string, boolean>; thinking?: NativeThinkingMeta }
interface NativeOverrides extends NativeThinkingMeta { capability?: Record<string, boolean> }
// Kimi 2.7.2 LlmModelSpec-based catalog definition.
interface NativeModel { id: string; spec: NativeSpec; overrides?: NativeOverrides }
interface NativeCatalog {
  toCatalogModelDefinition(alias: string, row: Row, provider: string): NativeModel;
}
interface NativeThinking {
  resolveThinkingEffortForModel(requested: string | undefined, defaults: Row, model: NativeSpec, strict: boolean): string;
}

// Execute upstream functions themselves. Imports, DI registrations and classes
// are excluded by syntax kind; no implementation is copied into the test.
function nativeFunctions<T>(name: string, sha256: string): T {
  const source = readFileSync(new URL(`../../fixtures/kimi-native-2.6/${name}.ts.txt`, import.meta.url), 'utf8');
  expect(createHash('sha256').update(source).digest('hex')).toBe(sha256);
  const parsed = ts.createSourceFile(`${name}.ts`, source, ts.ScriptTarget.Latest, true);
  const functions = parsed.statements.filter(ts.isFunctionDeclaration).map(node => node.getText(parsed)).join('\n');
  const js = ts.transpileModule(functions, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const exports = {};
  runInNewContext(js, { exports }, { timeout: 1000 });
  return exports as T;
}

const catalog = nativeFunctions<NativeCatalog>('catalog-runtime', 'dd5fcd63e2a401a86022187e0a25372094d269771f01c16c7dacb5bd3c6d2874');
const thinking = nativeFunctions<NativeThinking>('thinking', 'fce8e63b44c56b0bb7b8c987cdf72d49419b76c9bd3b068dbedbab2d25b75b31');

// Native configSection.modelsFromToml translates field casing recursively.
function fromToml(value: unknown): unknown {
  if (Array.isArray(value)) return value;
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key.replace(/_([a-z])/g, (_, char: string) => char.toUpperCase()), fromToml(item)]));
}
function nativeModel(row: Row): NativeModel {
  return catalog.toCatalogModelDefinition('test', fromToml(row) as Row, 'managed:kimi-code');
}
// Mirrors upstream provider-catalog applyModelOverrides precedence (2.7.2):
// an override wins over the model's own spec, field by field.
function effectiveSpec(model: NativeModel): NativeSpec {
  const o = model.overrides;
  if (!o) return model.spec;
  const meta = model.spec.thinking;
  const hasThinkingOverride = ['supportEfforts', 'defaultEffort', 'offEffort', 'alwaysThinking', 'adaptiveThinking'].some(key => o[key as keyof NativeOverrides] !== undefined);
  return { ...model.spec, capability: o.capability ?? model.spec.capability,
    thinking: meta === undefined && !hasThinkingOverride ? undefined : {
      supportEfforts: o.supportEfforts ?? meta?.supportEfforts, defaultEffort: o.defaultEffort ?? meta?.defaultEffort,
      offEffort: o.offEffort ?? meta?.offEffort, alwaysThinking: o.alwaysThinking ?? meta?.alwaysThinking,
      adaptiveThinking: o.adaptiveThinking ?? meta?.adaptiveThinking } };
}
function effectiveEffort(model: NativeModel, requested?: string, defaults: Row = {}): string {
  return thinking.resolveThinkingEffortForModel(requested, defaults, effectiveSpec(model), true);
}

describe('Kimi native model metadata consumer', () => {
  const document = kimiSettingsDocument(normalizeKimiSettings({}));
  const models = document.models as Record<string, Row>;

  it.each(KIMI_SUPPORTED_MODELS)('enables declared thinking and media for %s in the actual consumer', id => {
    const model = nativeModel(models[`kimi-code/${id}`]!);
    expect(model.spec.capability.thinking).toBe(true);
    expect(model.spec.capability.image_in).toBe(true);
    expect(model.spec.capability.video_in).toBe(id !== 'k3-256k');
    expect(model.spec.capability.audio_in).toBe(false);
    expect(model.spec.capability.tool_use).toBe(true);
    expect(model.spec.thinking?.alwaysThinking).toBe(id.startsWith('k3.1-pro'));
    const expected = id === 'kimi-for-coding-highspeed' ? 'on' : id === 'kimi-for-coding' ? 'high' : 'max';
    expect(effectiveEffort(model)).toBe(expected);
  });

  it('demonstrates the original regression and applies each supported effort', () => {
    const row = models['kimi-code/k3.1-pro']!;
    expect(effectiveEffort(nativeModel({ ...row, capabilities: undefined }), 'max')).toBe('off');
    const model = nativeModel(row);
    for (const effort of ['low', 'high', 'max']) expect(effectiveEffort(model, effort)).toBe(effort);
    expect(effectiveEffort(model, 'off')).toBe('max');
    expect(effectiveEffort(model, undefined, { enabled: false })).toBe('max');
    expect(effectiveEffort(nativeModel(models['kimi-code/k3']!), 'off')).toBe('off');
  });

  it('clears obsolete Highspeed effort settings and exposes no adjustable effort', () => {
    const settings = normalizeKimiSettings({ model: 'kimi-for-coding-highspeed', reasoning_effort: 'max', native_settings: {
      thinking: { effort: 'high', enabled: true }, models: { 'kimi-code/kimi-for-coding-highspeed': { default_effort: 'max' } },
    } }, true);
    const output = kimiSettingsDocument(settings);
    const row = (output.models as Record<string, Row>)['kimi-code/kimi-for-coding-highspeed']!;
    expect(settings.reasoning_effort).toBeUndefined();
    expect(output.thinking).toEqual({ enabled: true });
    expect(row.support_efforts).toEqual([]);
    expect(row).not.toHaveProperty('default_effort');
    expect(effectiveEffort(nativeModel(row), 'max')).toBe('on');
    expect(effectiveEffort(nativeModel(row), 'on')).toBe('on');
    expect(effectiveEffort(nativeModel(row), 'off')).toBe('off');
    expect(effectiveEffort(nativeModel(row), undefined, { enabled: false })).toBe('off');
    expect(modelDefaultsCatalog('kimi').find(entry => entry.model === 'kimi-for-coding-highspeed')).toMatchObject({ persistent_efforts: [], default_effort: null });
    expect(renderKimiSettings(settings)).not.toMatch(/= (undefined|null)/);
  });

  it.each(['high', 'max'])('heals stored Highspeed %s on read and rejects new adjustable effort through the defaults API service', async effort => {
    const db = createDbFake();
    db.tables.set(clientConfigDocuments, [{ id: 1, engine: 'kimi', sha256: 'a'.repeat(64), body: '',
      settings: { model: 'kimi-for-coding-highspeed', reasoning_effort: effort }, sourceHostId: null,
      createdAt: '2026-11-12T00:00:00Z', updatedAt: '2026-11-12T00:00:00Z' }]);
    const service = new ModelDefaultsService(db as never);
    expect(await service.get('kimi')).toMatchObject({ model: 'kimi-for-coding-highspeed', reasoning_effort: null });
    await expect(service.set('kimi', { model: 'kimi-for-coding-highspeed', reasoning_effort: effort }))
      .rejects.toMatchObject({ status: 422, param: 'reasoning_effort' });
    expect(db.inserts).toHaveLength(0);
    expect(await service.set('kimi', { model: 'kimi-for-coding-highspeed', reasoning_effort: null }))
      .toMatchObject({ reasoning_effort: null });
  });

  it('heals an obsolete Highspeed host effort override in the real host render path', () => {
    const output = renderTomlForHost({
      settings: { model: 'k3', reasoning_effort: 'max' }, engine: 'kimi',
      host: { id: 7, fqdn: 'test.example', secure: 1, kimiClientVersion: '2.6.2', kimiModelOverride: 'kimi-for-coding-highspeed', kimiReasoningEffortOverride: 'high' } as never,
      baseUrl: 'https://coord.example', apiKey: 'not-a-real-key', home: '/home/test',
    });
    expect(output.content).toContain('default_model = "kimi-code/kimi-for-coding-highspeed"');
    expect(output.content).not.toMatch(/^effort = /m);
  });

  it('preserves custom models and native overrides through rendering and the native catalog', () => {
    const custom = { provider: 'custom', model: 'private-model', capabilities: ['audio_in'], max_context_size: 262144 };
    const overrides = { capabilities: ['thinking', 'image_in'], support_efforts: ['low', 'high'], default_effort: 'low' };
    const output = kimiSettingsDocument(normalizeKimiSettings({ native_settings: { models: {
      custom, 'kimi-code/k3': { display_name: 'My model', overrides },
    } } }));
    const entries = output.models as Record<string, Row>;
    expect(entries.custom).toEqual(custom);
    expect(nativeModel(entries.custom!).spec.capability.audio_in).toBe(true);
    expect(entries['kimi-code/k3']).toMatchObject({ display_name: 'My model', overrides });
    const base = nativeModel(entries['kimi-code/k3']!);
    expect(effectiveEffort(base)).toBe('low');
    expect(effectiveSpec(base).capability.video_in).toBe(false);
    expect(base.spec.capability.video_in).toBe(true);
  });
});

describe('Kimi effort authoring versus stored projection', () => {
  it.each(['high', 'max'])('rejects newly authored Highspeed %s through generic preview and store', async effort => {
    for (const settings of [
      { model: 'kimi-for-coding-highspeed', reasoning_effort: effort },
      { model: 'kimi-for-coding-highspeed', native_settings: { thinking: { effort } } },
    ]) {
      const db = createDbFake();
      const service = new ClientConfigService(db as never);
      expect(() => service.render(settings, 'kimi')).toThrow();
      await expect(service.store({ settings, expected_revision: null }, null, 'kimi'))
        .rejects.toMatchObject({ status: 422 });
      expect(db.inserts).toHaveLength(0);
    }
  });

  it('rejects unsupported effort and conflicting controls instead of discarding authored input', () => {
    const service = new ClientConfigService({} as never);
    expect(() => service.render({ model: 'k3', reasoning_effort: 'bogus' }, 'kimi')).toThrow();
    expect(() => service.render({ model: 'k3', native_settings: { thinking: { effort: 'bogus' } } }, 'kimi')).toThrow();
    expect(() => service.render({ model: 'k3', reasoning_effort: 'high', native_settings: { thinking: { effort: 'low' } } }, 'kimi')).toThrow();
  });

  it.each(['on', 'off'])('renders native %s through generic and host paths without changing enabled or custom model overrides', effort => {
    const settings = { model: 'k3', native_settings: { thinking: { effort, enabled: false }, models: {
      custom: { model: 'custom', overrides: { capabilities: ['audio_in'] } },
    } } };
    const service = new ClientConfigService({} as never);
    const rendered = service.render(settings, 'kimi');
    const host = renderTomlForHost({ settings, engine: 'kimi', host: { kimiClientVersion: '2.6.3' } as never, baseUrl: null, apiKey: null });
    for (const output of [rendered, host]) {
      expect(output.content).toContain(`effort = "${effort}"`);
      expect(output.content).toContain('enabled = false');
      expect(output.settings.native_settings).toEqual(settings.native_settings);
    }
    expect(effectiveEffort(nativeModel((kimiSettingsDocument(rendered.settings).models as Record<string, Row>)['kimi-code/k3']!), effort)).toBe(effort === 'on' ? 'max' : 'off');
    expect(effectiveEffort(nativeModel((kimiSettingsDocument(rendered.settings).models as Record<string, Row>)['kimi-code/k3']!), undefined, settings.native_settings.thinking)).toBe('off');
  });

  it('lets the explicit defaults API replace an earlier native effort without retaining a conflicting control', async () => {
    const db = createDbFake();
    const service = new ClientConfigService(db as never);
    await service.store({ settings: { model: 'k3', native_settings: { thinking: { effort: 'low', enabled: false } } }, expected_revision: null }, null, 'kimi');
    expect(await new ModelDefaultsService(db as never).set('kimi', { model: 'k3', reasoning_effort: 'high' }))
      .toMatchObject({ reasoning_effort: 'high' });
    const rows = db.tables.get(clientConfigDocuments)!;
    const latest = rows.find(row => row.id === Math.max(...rows.map(row => Number(row.id))))!;
    expect((latest.settings as Row).native_settings).toEqual({ thinking: { enabled: false } });
  });

  it.each(['high', 'max'])('heals only historical Highspeed %s while preserving stored evidence', async effort => {
    const db = createDbFake();
    const row = { id: 1, engine: 'kimi', settings: { model: 'kimi-for-coding-highspeed', reasoning_effort: effort,
      native_settings: { thinking: { effort, enabled: false } } }, body: 'historical TOML', sha256: 'historical SHA', updatedAt: '2026-11-17T00:00:00Z' };
    db.tables.set(clientConfigDocuments, [row]);
    const service = new ClientConfigService(db as never);
    const read = await service.adminFetch('kimi');
    expect(read).toMatchObject({ content: row.body, sha256: row.sha256 });
    expect(read).not.toHaveProperty('validation_error');
    const projected = renderTomlForHost({ settings: row.settings, engine: 'kimi', host: null, baseUrl: null, apiKey: null });
    expect(projected.content).not.toMatch(/^effort = /m);
    expect(projected.content).toContain('enabled = false');
    expect(row.settings.reasoning_effort).toBe(effort);
    expect(row.settings.native_settings.thinking.effort).toBe(effort);
  });

  it('returns malformed historical effort for correction without changing body/hash', async () => {
    const db = createDbFake();
    const row = { id: 1, engine: 'kimi', settings: { model: 'k3', reasoning_effort: 'bogus' }, body: 'historical TOML', sha256: 'historical SHA', updatedAt: '2026-11-17T00:00:00Z' };
    db.tables.set(clientConfigDocuments, [row]);
    expect(await new ClientConfigService(db as never).adminFetch('kimi')).toMatchObject({ content: row.body, sha256: row.sha256,
      settings: row.settings, validation_error: { code: 'validation_failed', param: 'settings.reasoning_effort' } });
  });
});
