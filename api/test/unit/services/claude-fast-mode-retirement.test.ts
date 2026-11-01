import { describe, expect, it } from 'vitest';
import { normalizeSettings } from '../../../src/services/config-normalizer.js';
import { ClientConfigService, renderClaudeSettingsPartial, renderClaudeSettingsPartialForHost, renderTomlForHost } from '../../../src/services/client-config.js';

const normalize = (settings: unknown) => normalizeSettings(settings, { engine: 'claude', applyCodexDefaults: false });
const service = new ClientConfigService({} as never);

describe('Opus 4.8 fast-mode retirement', () => {
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
