import { describe, expect, it } from 'vitest';
import { normalizeSettings } from '../../../src/services/config-normalizer.js';
import { ClientConfigService, renderClaudeSettingsPartial, renderClaudeSettingsPartialForHost, renderTomlForHost } from '../../../src/services/client-config.js';
import { claudeFastModeCases } from '../../fixtures/claude-fast-mode-cases.js';

const normalize = (settings: unknown) => normalizeSettings(settings, { engine: 'claude', applyCodexDefaults: false });
const service = new ClientConfigService({} as never);

describe('Opus 4.8 fast-mode retirement', () => {
  it('owns omitted modes for old authored env selection and withdraws only that leaf when selection changes', () => {
    const before = renderClaudeSettingsPartial(normalize({ model: 'claude-opus-5-5', native_settings: { env: { ANTHROPIC_MODEL: 'claude-opus-4-8' }, language: 'de' } }));
    expect(before.partial.fastMode).toBe(false);
    expect(before.owned_paths).toContain('fastMode');
    expect(before.owned_paths).toContain('env.ANTHROPIC_MODEL');
    const after = renderClaudeSettingsPartial(normalize({ model: 'claude-opus-5-5', native_settings: { env: { ANTHROPIC_MODEL: 'claude-opus-4-8' }, language: 'de' }, env: { ANTHROPIC_MODEL: 'claude-opus-5-5' } }));
    expect(after.partial).not.toHaveProperty('fastMode');
    expect(after.owned_paths).not.toContain('fastMode');
    expect(after.partial).toMatchObject({ language: 'de', env: { ANTHROPIC_MODEL: 'claude-opus-5-5' } });
  });
  it.each(claudeFastModeCases)('resolves authored model precedence: %s', (_name, settings, deprecated) => {
    const input = structuredClone(settings);
    if (deprecated) expect(() => service.render(settings, 'claude')).toThrow(/fast mode on Opus 4.8 is deprecated/);
    else expect(JSON.parse(service.render(settings, 'claude').content).fastMode).toBe(true);
    const healed = normalize(settings);
    expect(healed.native_settings!.fastMode).toBe(!deprecated);
    expect(renderClaudeSettingsPartial(healed).partial.fastMode).toBe(!deprecated);
    expect(JSON.parse(renderTomlForHost({ settings, engine: 'claude', host: null, baseUrl: null, apiKey: null }).content).fastMode).toBe(!deprecated);
    expect(settings).toEqual(input);
  });

  it.each([
    ['claude-opus-5-5', 'claude-opus-4-8', false],
    ['claude-opus-4-8', 'claude-opus-5-5', true],
  ])('uses authored env %s over host override %s', (envModel, hostModel, disabled) => {
    const settings = { model: 'claude-opus-5-5', native_settings: { fastMode: true, env: { ANTHROPIC_MODEL: envModel } } };
    const host = { claudeModelOverride: hostModel, claudeClientVersion: '2.1.316', claudeWrapperVersion: '0.9.66' } as never;
    const partial = renderClaudeSettingsPartialForHost({ settings, host, baseUrl: null, apiKey: null });
    expect(partial.partial.fastMode).toBe(!disabled);
    expect(partial.owned_paths).toContain('fastMode');
    expect(JSON.parse(renderTomlForHost({ settings, host, engine: 'claude', baseUrl: null, apiKey: null }).content).fastMode).toBe(!disabled);
  });
  it.each(['claude-opus-4-8', 'claude-opus-4-8[1m]', ' CLAUDE-OPUS-4-8 '])('rejects newly authored deprecated combination for %s', model => {
    const settings = { model, native_settings: { fastMode: true, language: 'de' } };
    expect(() => service.render(settings, 'claude')).toThrow(/fast mode on Opus 4.8 is deprecated.*2026-11-30/);
    expect(settings.native_settings.fastMode).toBe(true);
  });

  it.each(['claude-opus-5-5', 'claude-opus-5', 'opus', 'vendor/claude-opus-4-8', 'claude-opus-4-8-custom'])('preserves active and custom choices for %s', model => {
    const rendered = service.render({ model, native_settings: { fastMode: true } }, 'claude');
    expect(JSON.parse(rendered.content)).toMatchObject({ model, fastMode: true });
  });

  it('heals historical true while preserving the active model, siblings and input snapshot', () => {
    const stored = { model: 'claude-opus-4-8', native_settings: { fastMode: true, fastModePerSessionOptIn: true, env: { LOCAL: 'kept' } } };
    const settings = normalize(stored);
    expect(settings.model).toBe(stored.model);
    expect(settings.native_settings).toEqual({ ...stored.native_settings, fastMode: false });
    expect(stored.native_settings.fastMode).toBe(true);
    expect(normalize(settings)).toEqual(settings);
    const rendered = service.render(settings, 'claude');
    expect(JSON.parse(rendered.content)).toMatchObject({ model: stored.model, fastMode: false, env: { LOCAL: 'kept' } });
  });

  it.each([undefined, false, true])('owns an explicit disabled leaf for the effective host model (template fastMode=%s)', fastMode => {
    const input = { model: 'claude-opus-5-5', native_settings: { language: 'de', ...(fastMode !== undefined && { fastMode }) } };
    const host = { claudeModelOverride: 'claude-opus-4-8', claudeClientVersion: '2.1.316', claudeWrapperVersion: '0.9.66' } as never;
    const rendered = renderClaudeSettingsPartialForHost({ settings: input, host, baseUrl: null, apiKey: null });
    expect(rendered.partial).toMatchObject({ model: 'claude-opus-4-8', fastMode: false, language: 'de' });
    expect(rendered.owned_paths).toContain('fastMode');
    expect(input.native_settings.fastMode).toBe(fastMode);
    const legacy = renderTomlForHost({ settings: input, host, engine: 'claude', baseUrl: null, apiKey: null });
    expect(JSON.parse(legacy.content).fastMode).toBe(false);
  });

  it('withdraws mode ownership after removal on an unaffected model without dropping siblings', () => {
    const withMode = renderClaudeSettingsPartial(normalize({ model: 'claude-opus-5-5', native_settings: { fastMode: true, language: 'de' } }));
    expect(withMode.owned_paths).toContain('fastMode');
    const removed = renderClaudeSettingsPartial(normalize({ model: 'claude-opus-5-5', native_settings: { language: 'de' } }));
    expect(removed.partial).not.toHaveProperty('fastMode');
    expect(removed.owned_paths).not.toContain('fastMode');
    expect(removed.partial.language).toBe('de');
  });
});
