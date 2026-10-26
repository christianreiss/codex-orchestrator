import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ClientConfigService, normalizeGrokSettings, renderTomlForHost } from '../../../src/services/client-config.js';
import { normalizeGrokNativeSettings } from '../../../src/services/grok-native-settings.js';
import { GROK_SUPPORTED_MODELS } from '../../../src/services/grok-models.js';
import { clientConfigDocuments } from '../../../src/db/schema.js';
import { createDbFake } from '../../helpers/db-fake.js';

const id = 'local.model.with.dots';
const native = (context_window: number) => ({ model: { [id]: {
  context_window, base_url: 'http://127.0.0.1:9/v1', temperature: 0.2,
  extra_headers: { 'X.Team': 'preserved' },
} } });

describe('Grok custom model context windows', () => {
  it('roundtrips custom windows, edits and withdrawal without subscription coercion', async () => {
    const db = createDbFake(), service = new ClientConfigService(db as never);
    for (const context of [128000, 64000]) {
      const saved = await service.store({ settings: { native_settings: native(context) } }, null, 'grok');
      db.tables.get(clientConfigDocuments)!.sort((a, b) => Number(b.id) - Number(a.id));
      const fetched = await service.adminFetch('grok');
      expect(fetched.validation_error).toBeUndefined();
      expect(fetched.settings?.native_settings).toEqual(native(context));
      expect(saved.settings).not.toHaveProperty('context_window');
      const rendered = renderTomlForHost({ engine: 'grok', settings: fetched.settings,
        host: { grokClientVersion: '1.0.70', grokWrapperVersion: '0.9.137' } as never, baseUrl: null, apiKey: null });
      expect(rendered.content).toContain(`[model."${id}"]\ncontext_window = ${context}`);
      expect(rendered.content).toContain('[model."grok-4.7"]\ncontext_window = 256000');
      expect(rendered.owned_paths).toContain(`model.${id}.context_window`);
      expect(rendered.owned_paths).toContain(`json:["model","${id}","extra_headers","X.Team"]`);
    }
    const removed = await service.store({ settings: { native_settings: { model: { [id]: { temperature: 0.2 } } } } }, null, 'grok');
    expect(removed.content).not.toContain('context_window = 64000');
    expect(removed.settings.native_settings).toEqual({ model: { [id]: { temperature: 0.2 } } });
  });

  it.each(GROK_SUPPORTED_MODELS)('retains subscription restrictions for %s', model => {
    expect(() => normalizeGrokSettings({ native_settings: { model: { [model]: { context_window: 128000 } } } }))
      .toThrow('unsupported subscription context window');
  });

  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])('rejects invalid custom token count %s in native and service validation', context => {
    expect(() => normalizeGrokNativeSettings(native(context))).toThrow('positive safe integer');
    expect(() => new ClientConfigService({} as never).render({ native_settings: native(context) }, 'grok'))
      .toThrow('positive safe integer');
  });

  it('keeps truly invalid saved values readable and permits a revision-checked correction', async () => {
    const settings = { native_settings: native(-1) }, body = '# historical invalid custom setting\n';
    const sha256 = createHash('sha256').update(body).digest('hex');
    const row = { id: 1, engine: 'grok', body, sha256, settings, createdAt: '2026-10-26T00:00:00Z', updatedAt: '2026-10-26T00:00:00Z' };
    const db = createDbFake(new Map([[clientConfigDocuments, [structuredClone(row)]]])), service = new ClientConfigService(db as never);
    const invalid = await service.adminFetch('grok');
    expect(invalid).toMatchObject({ content: body, sha256, settings, validation_error: {
      code: 'validation_failed', param: `settings.native_settings.model.${id}.context_window`,
    } });
    await expect(service.store({ settings: invalid.settings, expected_revision: '1' }, null, 'grok')).rejects.toMatchObject({ status: 422 });
    const saved = await service.store({ settings: { native_settings: native(128000) }, expected_revision: '1' }, null, 'grok');
    expect(saved.settings.native_settings).toEqual(native(128000));
    expect(db.tables.get(clientConfigDocuments)?.find(item => item.id === 1)).toEqual(row);
    db.tables.get(clientConfigDocuments)!.sort((a, b) => Number(b.id) - Number(a.id));
    await expect(service.store({ settings: { native_settings: native(64000) }, expected_revision: '1' }, null, 'grok'))
      .rejects.toMatchObject({ status: 409 });
  });
});
