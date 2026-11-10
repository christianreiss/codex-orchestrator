import { describe, expect, it } from 'vitest';
import { CLAUDE_ADVISOR_ALIAS_TARGETS, claudeAdvisorPairIsValid, normalizeSettings } from '../../../src/services/config-normalizer.js';
import { claudeSessionEfforts, claudeSupportsLegacyUserEffort } from '../../../src/services/claude-effort.js';
import { createClaudeModelsService } from '../../../src/services/claude-models.js';
import { renderClaudeSettingsPartialForHost } from '../../../src/services/client-config.js';
import { ModelDefaultsService, modelLaunchCatalog } from '../../../src/services/model-defaults.js';
import { applyModelPolicy, buildModelPolicy } from '../../../src/services/model-policy.js';
import { createDbFake } from '../../helpers/db-fake.js';

const MODEL = 'claude-fable-5-2';

describe('public Fable 5.2 native contract', () => {
  it('offers API metadata without removing active older Fable versions or admitting restricted Mythos', async () => {
    const models = createClaudeModelsService(createDbFake() as never);
    expect(await models.modelResponse(MODEL)).toMatchObject({ id: MODEL, display_name: 'Claude Fable 5.2', line: 'fable', max_input_tokens: 1_000_000, max_tokens: 128_000 });
    for (const model of ['claude-fable-5-1', 'claude-fable-5']) {
      expect(await models.resolveRequestedModel(model)).toBe(model);
      expect(applyModelPolicy(buildModelPolicy('claude'), model)).toBe(model);
      expect(applyModelPolicy(buildModelPolicy('claude', true), model)).toBe(MODEL);
    }
    await expect(models.resolveRequestedModel('claude-mythos-5-2')).rejects.toMatchObject({ status: 404 });
  });

  it('persists every supported native effort and defaults to medium while max remains session-only', async () => {
    const service = new ModelDefaultsService(createDbFake() as never);
    expect(await service.set('claude', { model: MODEL })).toMatchObject({ model: MODEL, reasoning_effort: 'medium' });
    for (const effort of ['low', 'medium', 'high', 'xhigh']) {
      // The small fake preserves insertion order rather than SQL ORDER BY id.
      const service = new ModelDefaultsService(createDbFake() as never);
      expect(await service.set('claude', { model: MODEL, reasoning_effort: effort })).toMatchObject({ reasoning_effort: effort });
      expect(await service.get('claude')).toMatchObject({ model: MODEL, reasoning_effort: effort });
    }
    await expect(service.set('claude', { model: MODEL, reasoning_effort: 'max' })).rejects.toMatchObject({ status: 422 });
    expect(claudeSessionEfforts(MODEL)).toEqual(['max']);
    expect(claudeSupportsLegacyUserEffort(MODEL)).toBe(false);
  });

  it('uses its own canonical effort leaf for a 1m host override and preserves native siblings', () => {
    const settings = normalizeSettings({ model: 'claude-fable-5-1', effortLevel: 'xhigh', native_settings: { modelSettings: { [MODEL]: { autoCompactWindow: 300_000 }, 'vendor.model': { effortLevel: 'low' } } } }, { engine: 'claude', applyCodexDefaults: false });
    const render = (version: string) => renderClaudeSettingsPartialForHost({ settings, host: { claudeClientVersion: version, claudeWrapperVersion: '0.9.173', claudeModelOverride: `${MODEL}[1m]`, claudeReasoningEffortOverride: 'high' } as never, baseUrl: null, apiKey: null, engine: 'claude' });
    expect(() => render('2.1.320')).toThrow(/2\.1\.321.*clx update/);
    const out = render('2.1.321');
    expect(out.partial).toMatchObject({ model: `${MODEL}[1m]`, modelSettings: { [MODEL]: { effortLevel: 'high', autoCompactWindow: 300_000 }, 'vendor.model': { effortLevel: 'low' } } });
    expect(out.partial).not.toHaveProperty('effortLevel');
    expect(out.owned_paths).toContain(`modelSettings.${MODEL}.effortLevel`);
    expect(out.owned_paths).not.toContain('effortLevel');
  });

  it('signs the minimum even when omitted from an old host menu, leaving update recovery intact', () => {
    const old = modelLaunchCatalog('claude', undefined, '2.1.320');
    expect(old.models.map(entry => entry.model)).not.toContain(MODEL);
    expect(old.min_cli_versions?.[MODEL]).toBe('2.1.321');
    const current = modelLaunchCatalog('claude', undefined, '2.1.321');
    expect(current.models.find(entry => entry.model === MODEL)).toMatchObject({ default_effort: 'medium', min_cli_version: '2.1.321' });
  });

  it('resolves the advisor alias to rank 10 without silently downgrading a Fable 5.2 session', () => {
    expect(CLAUDE_ADVISOR_ALIAS_TARGETS.fable).toBe(MODEL);
    expect(claudeAdvisorPairIsValid(MODEL, 'fable')).toBe(true);
    expect(claudeAdvisorPairIsValid(MODEL, 'claude-fable-5-1')).toBe(false);
    expect(claudeAdvisorPairIsValid('claude-fable-5-1', MODEL)).toBe(true);
  });
});
