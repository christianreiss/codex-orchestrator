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


describe('Codex 0.163 conditional capability floor', () => {
  const render = (version: string | null, settings: unknown) => renderTomlForHost({ settings,
    host: { clientVersion: version } as never, baseUrl: null, apiKey: null });
  const fields = [
    { include_environment_context_time: false },
    ...['async_compaction', 'code_mode_host_grpc', 'code_mode_tool_description_first', 'credential_masking',
      'guardian_trust_orchestrator_connectors', 'output_token_replay', 'retain_client_tool_outputs',
      'subagent_default_context_limits'].map(key => ({ features: { [key]: false } })),
    { features: { multi_agent_v2: { disable_native_tools: false } } },
    { features: { multi_agent_v2: { preserve_fork_prefix: false } } },
    { plugins: { _default: { enabled: false } } },
    { tui: { copy_on_select_clear_selection: false } },
    { tui: { keymap: { global: { leader: [] } } } },
    { windows: { allow_mxc: false } }, { notice: { hide_gov_cloud_guidance: false } },
    ...['aube', 'bubbie', 'haetsal', 'hanul', 'himari', 'leher', 'miko', 'neer', 'porto', 'rindo', 'rio',
      'rivage', 'selva', 'sonna', 'tinta', 'viola'].map(voice => ({ realtime: { voice } })),
  ];
  it.each(fields)('gates new fields, even false/empty values, in root and profile extensions: %j', input => {
    for (const settings of [{ native_settings: input }, { profiles: [{ name: 'modern', native_settings: input }] }]) {
      expect(() => render('0.162.1', settings)).toThrow(/0\.163\.0.*cdx update/);
      expect(() => render(null, settings)).toThrow(/0\.163\.0.*unreported/);
      expect(() => render('0.163.0', settings)).not.toThrow();
      expect(() => render('0.164.0', settings)).not.toThrow();
    }
  });
  it('gates structured new feature and notice fields too', () => {
    for (const settings of [{ features: { credential_masking: false } },
      { profiles: [{ name: 'modern', features: { async_compaction: false } }] },
      { notice: { hide_gov_cloud_guidance: false } }]) {
      expect(() => render('0.162.1', settings)).toThrow(/0\.163\.0/);
      expect(() => render('0.163.0', settings)).not.toThrow();
    }
  });
  it('retains old supported settings and opaque map keys at the old floor', () => {
    expect(() => render('0.162.1', { native_settings: { realtime: { voice: 'alloy' },
      mcp_servers: { 'tui.keymap.global.leader': { command: '/bin/echo' } },
      plugins: { 'include_environment_context_time': { enabled: true } },
    } })).not.toThrow();
  });
});


describe('Claude nested user namespaces conditional capability floor', () => {
  const render = (version: string | null, settings: unknown) => renderClaudeSettingsPartialForHost({
    settings, host: { claudeClientVersion: version, claudeWrapperVersion: '0.9.66' } as never, baseUrl: null, apiKey: null,
  });
  it.each([false, true])('requires 2.1.305 even when the configured boolean is %s', allowNestedUserNamespaces => {
    const settings = { native_settings: { sandbox: { allowNestedUserNamespaces } } };
    for (const version of ['2.1.296', '2.1.304', null]) {
      expect(() => render(version, settings)).toThrow(/2\.1\.305.*observed.*clx update/);
    }
    expect(render('2.1.305 (Claude Code)', settings).partial.sandbox).toEqual({ allowNestedUserNamespaces });
    expect(() => render('2.1.310', settings)).not.toThrow();
    expect(JSON.parse(new ClientConfigService({} as never).render(settings, 'claude').content).sandbox)
      .toEqual({ allowNestedUserNamespaces });
  });
  it('keeps existing fields and opaque names at the old floor and withdraws the gate on removal', () => {
    expect(() => render('2.1.296', { native_settings: { sandbox: { enabled: true },
      env: { 'sandbox.allowNestedUserNamespaces': 'opaque' },
      modelSettings: { allowNestedUserNamespaces: { effortLevel: 'high' } },
    } })).not.toThrow();
    expect(() => render(null, { native_settings: {} })).not.toThrow();
    expect(() => render('2.1.296', { native_settings: { sandbox: {} } })).not.toThrow();
  });
});
