import { describe, expect, it } from 'vitest';
import { normalizeSettings, normalizeStoredCodexEffort, normalizeStoredModel } from '../../../src/services/config-normalizer.js';
import { normalizeCodexNativeSettings } from '../../../src/services/codex-native-settings.js';
import { renderTomlForHost, ClientConfigService } from '../../../src/services/client-config.js';
import { resolveRequestedModel } from '../../../src/services/openai-models.js';
import { createDbFake } from '../../helpers/db-fake.js';

describe('known Codex model migrations', () => {
  it.each([['gpt-5.4', 'gpt-6-sol'], ['gpt-5.4-mini', 'gpt-6-luna']])('uses the current documented successor of %s', (old, current) => {
    expect(normalizeStoredModel(old)).toBe(current);
    expect(resolveRequestedModel(old)).toBe(current);
    const result = normalizeSettings({ model: old, model_reasoning_effort: 'low', profiles: [{ name: 'old', model: old, model_reasoning_effort: 'xhigh' }] });
    expect(result).toMatchObject({ model: current, model_reasoning_effort: 'low', profiles: [{ model: current, model_reasoning_effort: 'xhigh' }] });
    const host = renderTomlForHost({ settings: result, host: { modelOverride: old, reasoningEffortOverride: 'max', clientVersion: '0.164.0' } as never, baseUrl: null, apiKey: null });
    expect(host.content).toContain(`model = "${current}"`);
    expect(host.content).toContain('model_reasoning_effort = "max"');
  });

  it.each(['gpt-5.4', 'gpt-5.4-mini', 'gpt-5.2', 'gpt-5.5', 'gpt-5.3-codex-spark'])('preserves compatible efforts for %s and defaults invalid efforts', old => {
    expect(normalizeStoredCodexEffort('low', old)).toBe('low');
    expect(normalizeStoredCodexEffort('minimal', old)).toBe(old === 'gpt-5.5' ? 'low' : 'medium');
    expect(normalizeStoredCodexEffort(null, old)).toBe(old === 'gpt-5.5' ? 'low' : 'medium');
  });

  it('defaults an incompatible retired-mini effort and preserves current/custom selections', () => {
    expect(normalizeStoredCodexEffort('ultra', 'gpt-5.4-mini')).toBe('medium');
    expect(normalizeSettings({ model: 'gpt-6-astra', model_reasoning_effort: 'high' })).toMatchObject({ model: 'gpt-6-astra', model_reasoning_effort: 'high' });
    expect(normalizeSettings({ model: 'vendor.custom', model_reasoning_effort: 'ultra' })).toMatchObject({ model: 'vendor.custom', model_reasoning_effort: 'ultra' });
    expect(normalizeStoredCodexEffort(null, 'vendor.custom')).toBeNull();
  });

  it('migrates native model references and their associated subagent effort', () => {
    expect(normalizeCodexNativeSettings({ review_model: 'gpt-5.4', agents: { default_subagent_model: 'gpt-5.4-mini', default_subagent_reasoning_effort: 'ultra' }, memories: { extract_model: 'gpt-5.4-mini', consolidation_model: 'gpt-5.4' } })).toEqual({ review_model: 'gpt-6-sol', agents: { default_subagent_model: 'gpt-6-luna', default_subagent_reasoning_effort: 'medium' }, memories: { extract_model: 'gpt-6-luna', consolidation_model: 'gpt-6-sol' } });
    expect(normalizeCodexNativeSettings({ agents: { default_subagent_model: 'vendor.custom', default_subagent_reasoning_effort: 'ultra' } })).toEqual({ agents: { default_subagent_model: 'vendor.custom', default_subagent_reasoning_effort: 'ultra' } });
  });

  it('roundtrips migrated root/profile/native values without losing unrelated settings or revision checks', async () => {
    const service = new ClientConfigService(createDbFake() as never);
    await service.store({ settings: { model: 'gpt-5.4', model_reasoning_effort: 'low', native_settings: { review_model: 'gpt-5.4-mini' }, profiles: [{ name: 'small', model: 'gpt-5.4-mini', model_reasoning_effort: 'xhigh' }] } });
    const first = await service.adminFetch();
    expect(first.settings).toMatchObject({ model: 'gpt-6-sol', model_reasoning_effort: 'low', native_settings: { review_model: 'gpt-6-luna' }, profiles: [{ name: 'small', model: 'gpt-6-luna', model_reasoning_effort: 'xhigh' }] });
    const changed = await service.store({ settings: { ...first.settings, model_reasoning_effort: 'medium' }, expected_revision: first.revision });
    expect(changed.settings.model_reasoning_effort).toBe('medium');
    await expect(service.store({ settings: first.settings, expected_revision: null })).rejects.toMatchObject({ status: 409, code: 'config_revision_conflict' });
  });
});
