import { describe, expect, it, vi } from 'vitest';
import { hosts } from '../../../src/db/schema.js';
import { normalizeSettings, SUPPORTED_MODELS } from '../../../src/services/config-normalizer.js';
import { normalizeCodexNativeSettings } from '../../../src/services/codex-native-settings.js';
import { renderTomlForHost } from '../../../src/services/client-config.js';
import { HostManagementService } from '../../../src/services/host-management.js';
import { modelLaunchCatalog } from '../../../src/services/model-defaults.js';
import { createDbFake } from '../../helpers/db-fake.js';

describe('deprecated Codex model migration', () => {
  it('removes GPT-5.5 from current fleet and signed launchpad catalogs before retirement', () => {
    expect(SUPPORTED_MODELS).not.toContain('gpt-5.5');
    expect(modelLaunchCatalog('codex').models.map(model => model.model)).toEqual(SUPPORTED_MODELS);
  });

  it.each(['low', 'medium', 'high', 'xhigh'])('preserves valid %s effort for fleet, profile and host selections', effort => {
    const settings = { model: 'gpt-5.5', model_reasoning_effort: effort, profile: 'work', profiles: [
      { name: 'work', model: 'gpt-5.5', model_reasoning_effort: effort },
    ] };
    const normalized = normalizeSettings(settings);
    expect(normalized).toMatchObject({ model: 'gpt-6.1-sol', model_reasoning_effort: effort });
    expect(normalized.profiles[0]).toMatchObject({ model: 'gpt-6.1-sol', model_reasoning_effort: effort });
    const result = renderTomlForHost({ settings, host: { modelOverride: 'gpt-5.5', reasoningEffortOverride: effort } as never, baseUrl: null, apiKey: null });
    expect(result.content).toContain('model = "gpt-6.1-sol"');
    expect(result.content).toContain(`model_reasoning_effort = "${effort}"`);
    expect(result.profiles?.[0]?.content).toContain(`model_reasoning_effort = "${effort}"`);
    expect(JSON.stringify(result)).not.toContain('gpt-5.5');
  });

  it.each([undefined, null, 'minimal'])('uses replacement default for missing or invalid effort %j', effort => {
    expect(normalizeSettings({ model: 'gpt-5.5', model_reasoning_effort: effort })).toMatchObject({ model: 'gpt-6.1-sol', model_reasoning_effort: 'low' });
  });

  it('migrates all native model scopes and profile sidecars without rewriting arbitrary strings', () => {
    const native = { review_model: 'gpt-5.5', agents: { default_subagent_model: 'gpt-5.5' }, memories: { extract_model: 'gpt-5.5', consolidation_model: 'gpt-5.5' }, developer_instructions: 'Compare gpt-5.5 historical results.' };
    const normalized = normalizeCodexNativeSettings(native);
    expect(normalized).toMatchObject({ review_model: 'gpt-6.1-sol', agents: { default_subagent_model: 'gpt-6.1-sol' }, memories: { extract_model: 'gpt-6.1-sol', consolidation_model: 'gpt-6.1-sol' }, developer_instructions: native.developer_instructions });
    expect(native.review_model).toBe('gpt-5.5');
    const result = renderTomlForHost({ settings: { native_settings: native, profiles: [{ name: 'review', native_settings: native }] }, host: null, baseUrl: null, apiKey: null });
    for (const content of [result.content, result.profiles![0]!.content]) {
      expect(content).toContain('review_model = "gpt-6.1-sol"');
      expect(content).toContain('default_subagent_model = "gpt-6.1-sol"');
      expect(content).not.toContain('= "gpt-5.5"');
    }
  });

  it('preserves current and unknown custom provider ids in all native scopes', () => {
    const native = { review_model: 'local-review-v3', agents: { default_subagent_model: 'gpt-6-astra' }, memories: { extract_model: 'local-extract-v1' } };
    expect(normalizeCodexNativeSettings(native)).toEqual(native);
    expect(normalizeSettings({ model: 'custom-model', model_reasoning_effort: 'high' }).model).toBe('custom-model');
  });

  it.each(['low', 'medium', 'xhigh', null])('migrates a saved host override while preserving effort %j', async effort => {
    const db = createDbFake();
    db.tables.set(hosts, [{ id: 1, fqdn: 'host.test', modelOverride: 'gpt-5.5', reasoningEffortOverride: effort }]);
    const service = new HostManagementService({ db, events: { appendAndPublish: vi.fn() } } as never);
    const result = await service.setModelOverrides(1, { model_override: 'gpt-5.5' });
    expect(result).toMatchObject({ modelOverride: 'gpt-6.1-sol', reasoningEffortOverride: effort ?? 'low' });
  });
});
