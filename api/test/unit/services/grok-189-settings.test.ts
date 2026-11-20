import { describe, expect, it } from 'vitest';
import { ClientConfigService, renderTomlForHost } from '../../../src/services/client-config.js';
import { grokNativeOwnedPaths, normalizeGrokNativeSettings, renderGrokNativeToml } from '../../../src/services/grok-native-settings.js';
import { assertNativeConfigSupport } from '../../../src/services/native-config-support.js';
import { clientConfigDocuments } from '../../../src/db/schema.js';
import { createDbFake } from '../../helpers/db-fake.js';

const features = { auto_title_border: false, dashboard_workspace_mode: false, slow_link_paint_floor: false };
const additions = { features, ui: { contextual_hints: { thinking_collapse: false } } };
const at = (path: string[], value: unknown): Record<string, unknown> => path.reduceRight<unknown>((child, key) => ({ [key]: child }), value) as Record<string, unknown>;
const check = (version: string | null, native_settings: unknown) => assertNativeConfigSupport({ native_settings }, { grokClientVersion: version } as never, 'grok');

describe('Grok 1.0.89 user settings', () => {
  it('roundtrips preview/store/read/edit/removal with exact ownership and stale-revision protection', async () => {
    const db = createDbFake(), configs = new ClientConfigService(db as never);
    let revision: string | null = null;
    const edited = { features: { ...features, auto_title_border: true }, ui: { contextual_hints: { thinking_collapse: true } } };
    for (const native_settings of [additions, edited, {}]) {
      const preview = configs.render({ native_settings }, 'grok');
      const saved = await configs.store({ settings: { native_settings }, expected_revision: revision }, null, 'grok');
      const previous = revision; revision = saved.revision;
      db.tables.get(clientConfigDocuments)!.sort((a, b) => Number(b.id) - Number(a.id));
      const fetched = await configs.adminFetch('grok');
      expect(fetched.settings?.native_settings ?? {}).toEqual(native_settings);
      const rendered = renderTomlForHost({ engine: 'grok', settings: fetched.settings,
        host: { grokClientVersion: '1.0.89', grokWrapperVersion: '0.9.181' } as never, baseUrl: null, apiKey: null });
      expect(rendered.content).toBe(saved.content); expect(preview.content).toBe(saved.content);
      if ('features' in native_settings) {
        expect(rendered.content).toContain('auto_title_border = ');
        expect(rendered.content).toContain('dashboard_workspace_mode = false');
        expect(rendered.content).toContain('slow_link_paint_floor = false');
        expect(rendered.content).toContain('thinking_collapse = ');
        expect(rendered.owned_paths).toEqual(expect.arrayContaining(['features.auto_title_border', 'features.dashboard_workspace_mode',
          'features.slow_link_paint_floor', 'ui.contextual_hints.thinking_collapse']));
        await expect(configs.store({ settings: { native_settings: {} }, expected_revision: previous }, null, 'grok')).rejects.toMatchObject({ status: 409 });
      } else {
        for (const key of ['auto_title_border', 'dashboard_workspace_mode', 'slow_link_paint_floor', 'thinking_collapse']) expect(rendered.content).not.toContain(key);
        expect(rendered.owned_paths).not.toContain('features.auto_title_border');
      }
    }
  });
  it('keeps omitted defaults absent and normalizes authored false values verbatim', () => {
    expect(normalizeGrokNativeSettings({})).toEqual({});
    expect(normalizeGrokNativeSettings(additions)).toEqual(additions);
    expect(renderGrokNativeToml(additions)).toContain('thinking_collapse = false');
    expect(grokNativeOwnedPaths(additions)).toEqual(expect.arrayContaining(['features.slow_link_paint_floor', 'ui.contextual_hints.thinking_collapse']));
  });
  it.each([
    [at(['features', 'auto_title_border'], 'true'), 'auto_title_border: expected boolean'],
    [at(['features', 'dashboard_workspace_mode'], 1), 'dashboard_workspace_mode: expected boolean'],
    [at(['features', 'slow_link_paint_floor'], 'false'), 'slow_link_paint_floor: expected boolean'],
    [at(['ui', 'contextual_hints', 'thinking_collapse'], 'yes'), 'thinking_collapse: expected boolean'],
  ])('rejects wrong types before storage %#', async (native_settings, error) => {
    expect(() => normalizeGrokNativeSettings(native_settings)).toThrow(error);
    const db = createDbFake(), configs = new ClientConfigService(db as never);
    await expect(configs.store({ settings: { native_settings } }, null, 'grok')).rejects.toMatchObject({ status: 422 });
    expect(db.tables.get(clientConfigDocuments)).toBeUndefined();
  });
});

describe('Grok 1.0.89 conservative capability floor', () => {
  const candidates = [...Object.entries(features).map(([key, value]) => at(['features', key], value)),
    at(['ui', 'contextual_hints', 'thinking_collapse'], false)];
  it.each(candidates)('requires 1.0.89 for authored values including false %#', native => {
    expect(() => check('1.0.88', native)).toThrow('CLI 1.0.89 or newer');
    expect(() => check(null, native)).toThrow('observed unreported');
    expect(() => check('grok 1.0.89 (28be5bb1bf65)', native)).not.toThrow();
  });
  it('does not gate unrelated contextual hints or dotted map names', () => {
    expect(() => check('1.0.50', { ui: { contextual_hints: { undo: false } } })).not.toThrow();
    expect(() => check('1.0.50', { model: { 'features.auto_title_border': { description: 'ui.contextual_hints.thinking_collapse' } } })).not.toThrow();
  });
  it('lets inactive version_overrides layers neither raise the floor nor hide an active one', () => {
    const layer = (extra: Record<string, unknown>) => ({ version_overrides: [{ ...extra, features: { slow_link_paint_floor: true } }] });
    expect(() => check('1.0.77', layer({ minimum_version: '1.0.89' }))).not.toThrow();
    expect(() => check('1.0.89', layer({ maximum_version: '1.0.88' }))).not.toThrow();
    expect(() => check('1.0.88', layer({ maximum_version: '1.0.88' }))).toThrow('CLI 1.0.89');
    expect(() => check('1.0.89', layer({ minimum_version: '1.0.89' }))).not.toThrow();
  });
});
