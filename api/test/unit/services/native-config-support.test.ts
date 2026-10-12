import { describe, expect, it } from 'vitest';
import { ClientConfigService, renderTomlForHost, renderClaudeSettingsPartialForHost } from '../../../src/services/client-config.js';
import { normalizeSettings } from '../../../src/services/config-normalizer.js';
import { normalizeCodexNativeSettings } from '../../../src/services/codex-native-settings.js';

describe('native config client capability gates', () => {
  const codex = (version: string | null, settings: unknown = { native_settings: { service_tier: 'priority' } }) =>
    renderTomlForHost({ settings, host: { clientVersion: version } as never, baseUrl: null, apiKey: null });
  const claude = (version: string | null, settings: unknown = { native_settings: { language: 'german' } }) =>
    renderClaudeSettingsPartialForHost({ settings, host: { claudeClientVersion: version } as never, baseUrl: null, apiKey: null });
  it('requires the audited native CLI for nonempty extension settings', () => {
    expect(() => codex('0.162.0')).toThrow(/0\.162\.1.*observed 0\.162\.0.*cdx update/);
    expect(() => claude('2.1.295')).toThrow(/2\.1\.296.*observed 2\.1\.295.*clx update/);
    expect(() => codex(null)).toThrow(/observed unreported/);
    expect(() => claude(null)).toThrow(/observed unreported/);
    expect(codex('codex-cli 0.162.1').content).toContain('service_tier = "priority"');
    expect(claude('2.1.296 (Claude Code)').partial.language).toBe('german');
    expect(() => codex('0.163.0')).not.toThrow();
    expect(() => claude('2.2.0')).not.toThrow();
  });
  it('includes profile-only extensions without gating structured-only or empty settings', () => {
    expect(() => codex('0.156.1', { profiles: [{ name: 'review', native_settings: { service_tier: 'priority' } }] })).toThrow(/0\.162\.1/);
    for (const settings of [{}, { native_settings: {} }, { profiles: [{ name: 'review', native_settings: {} }] }]) {
      expect(() => codex(null, settings)).not.toThrow();
      expect(() => claude(null, settings)).not.toThrow();
    }
  });
  it('keeps admin authoring and preview independent of installed clients', () => {
    const service = new ClientConfigService({} as never);
    const result = service.render({ profiles: [{ name: 'review', model: 'gpt-6.1-sol', native_settings: { service_tier: 'priority' } }] });
    expect(result.profiles).toMatchObject([{ name: 'review', content: expect.stringContaining('service_tier = "priority"') }]);
    expect(result.content).not.toContain('service_tier');
  });
});

describe('profile and native file scopes', () => {
  it('keeps inherited model and effort absent through repeated normalization', () => {
    const input = { profiles: [{ name: 'all-inherited', model: null, model_reasoning_effort: null }, { name: 'model-only', model: 'gpt-6.1-sol' }] };
    const first = normalizeSettings(input);
    expect(first.profiles[0]).toEqual({ name: 'all-inherited' });
    expect(first.profiles[1]).toEqual({ name: 'model-only', model: 'gpt-6.1-sol' });
    expect(normalizeSettings(first).profiles).toEqual(first.profiles);
  });
  it('rejects unusable names before accepting native profile extensions', () => {
    expect(() => normalizeSettings({ profiles: [{ name: '../escape', native_settings: { service_tier: 'priority' } }] })).toThrow(/file-safe name/);
  });
  it('directs enforced requirements to their actual native policy scope', () => {
    expect(() => normalizeCodexNativeSettings({ allowed_sandbox_modes: ['read-only'] })).toThrow(/admin-enforced requirements.toml/);
  });
});
