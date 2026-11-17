import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { ClientConfigService, renderTomlForHost } from '../../../src/services/client-config.js';
import { normalizeSettings } from '../../../src/services/config-normalizer.js';
import { normalizeCodexNativeSettings, normalizeStoredCodexNativeSettings } from '../../../src/services/codex-native-settings.js';
import { createDbFake } from '../../helpers/db-fake.js';

const flags168 = ['agent_message_board_mcp', 'async_compaction_root_only', 'cli_resume_account_check',
  'command_sessions_world_state', 'guardian_denial_reconsideration', 'guardian_include_additional_context',
  'hosted_search_policy', 'image_generation_animation', 'tui_workspace'];
const flags169 = ['daybreak_program_propagation', 'gateway_setup_wizard', 'incremental_tools_legacy',
  'incremental_tools_legacy_gcp', 'mcp_lazy_stdio_startup'];
const pane168 = ['change_host', 'equalize_pane_widths', 'focus_main_composer', 'focus_pane_left',
  'focus_pane_right', 'focus_sidebar_content', 'hide_pane', 'maximize_pane_width', 'minimize_pane_width',
  'move_divider_left', 'move_divider_right', 'resize_panes', 'toggle_pane_zoom'];
const pane169 = ['close_sidebar_tab', 'focus_sidebar_tabs', 'sidebar_down', 'sidebar_up'];
const oauth = { authorization_url: 'https://idp.example.test/auth', token_url: 'https://idp.example.test/token', client_id: 'audit' };
const all = () => ({
  features: { ...Object.fromEntries([...flags168, ...flags169].map(key => [key, false])),
    guardianv2: { sync_elastic_budgeting: false, sync_elastic_sections: {
      'section.with.dots': { min_total_section_tokens: 0, max_section_entry_tokens: 1, max_total_section_tokens: 2 } } } },
  tui: { sidebar_width_percent: 42, collapse_turn_details: false, notification_method: 'osc777',
    keymap: { global: Object.fromEntries([...pane168, ...pane169].map(key => [key, []])) } },
  tools: { client_search_provider: 'standalone' },
  model_providers: {
    'custom.with.dots': { name: 'Audit', base_url: 'https://gateway.example.test/v1', gateway_oauth: { ...oauth, device_authorization_url: 'https://idp.example.test/device' } },
    exporter: { name: 'Audit', base_url: 'https://gateway.example.test/v1', gateway_oauth: { credential_export: { command: '/never-run/credential-export', args: ['--audit'], timeout_ms: 1 } } },
    'amazon-bedrock': { aws: { credential_export: { command: '/never-run/aws-export', args: [] } } },
  },
});
const render = (version: string | null, settings: unknown) => renderTomlForHost({ settings,
  host: { clientVersion: version } as never, baseUrl: null, apiKey: null });

describe('Codex 0.168/0.169 native settings', () => {
  it('roundtrips, changes and removes root/profile fields with literal names', async () => {
    const service = new ClientConfigService(createDbFake() as never), native = all();
    const stored = await service.store({ settings: { native_settings: native, profiles: [{ name: 'audit', native_settings: native }] } });
    const fetched = await service.adminFetch();
    expect(fetched.settings?.native_settings).toEqual(native);
    expect(fetched.settings?.profiles[0]?.native_settings).toEqual(native);
    for (const content of [stored.content, service.render(fetched.settings).profiles![0]!.content]) {
      expect(content).toContain('collapse_turn_details = false');
      expect(content).toContain('sidebar_width_percent = 42');
      expect(content).toContain('timeout_ms = 1');
      expect(content).toContain('[model_providers."custom.with.dots".gateway_oauth]');
      expect(content).toContain('[features.guardianv2.sync_elastic_sections."section.with.dots"]');
    }
    const changed = await service.store({ settings: { native_settings: { tui: { collapse_turn_details: true } } }, expected_revision: stored.revision });
    expect(changed.content).toContain('collapse_turn_details = true');
    const removed = await service.store({ settings: { native_settings: {}, profiles: [{ name: 'audit', native_settings: {} }] } });
    expect(removed.content).not.toMatch(/collapse_turn_details|credential_export|sidebar_width_percent/);
    expect(render(null, {}).content).not.toMatch(/collapse_turn_details|sync_elastic|gateway_setup_wizard/);
  });
  const added168 = [
    ...flags168.map(key => ({ features: { [key]: false } })),
    ...pane168.map(key => ({ tui: { keymap: { global: { [key]: [] } } } })),
    { tui: { sidebar_width_percent: 1 } }, { tui: { notification_method: 'osc777' } },
    { tools: { client_search_provider: 'search_mcp' } },
    { features: { guardianv2: { sync_elastic_budgeting: false } } },
    { features: { guardianv2: { sync_elastic_sections: {} } } },
  ];
  it.each(added168)('gates exact 0.168 root/profile additions: %j', native => {
    for (const settings of [{ native_settings: native }, { profiles: [{ name: 'audit', native_settings: native }] }]) {
      expect(() => render('0.167.2', settings)).toThrow(/0\.168\.0/);
      expect(() => render(null, settings)).toThrow(/0\.168\.0.*unreported/);
      expect(() => render('0.168.0', settings)).not.toThrow();
    }
  });
  const added169 = [
    ...flags169.map(key => ({ features: { [key]: false } })),
    ...pane169.map(key => ({ tui: { keymap: { global: { [key]: [] } } } })),
    { tui: { collapse_turn_details: false } },
    { model_providers: { custom: { base_url: 'https://gateway.example.test/v1', gateway_oauth: { ...oauth, device_authorization_url: 'https://idp.example.test/device' } } } },
    { model_providers: { custom: { base_url: 'https://gateway.example.test/v1', gateway_oauth: { credential_export: { command: '/never-run' } } } } },
  ];
  it.each(added169)('gates exact 0.169 additions including nonmonotonic legacy flags: %j', native => {
    for (const settings of [{ native_settings: native }, { profiles: [{ name: 'audit', native_settings: native }] }]) {
      for (const version of ['0.167.1', '0.167.2', '0.168.0']) expect(() => render(version, settings)).toThrow(/0\.169\.0/);
      expect(() => render('0.169.0', settings)).not.toThrow();
    }
  });
  it('gates structured features but leaves existing AWS export, BEL and opaque names on earlier floors', () => {
    expect(() => render('0.167.2', { features: { tui_workspace: false } })).toThrow(/0\.168\.0/);
    expect(() => render('0.168.0', { profiles: [{ name: 'audit', features: { incremental_tools_legacy: false } }] })).toThrow(/0\.169\.0/);
    expect(() => render('0.162.1', { native_settings: { tui: { notification_method: 'bel' },
      model_providers: { 'collapse_turn_details.device_authorization_url': { name: 'Audit' },
        'amazon-bedrock': { aws: { credential_export: { command: '/never-run' } } } },
      mcp_servers: { 'tui.collapse_turn_details': { command: '/bin/false' } } } })).not.toThrow();
  });
  it.each([
    { tui: { sidebar_width_percent: 0 } }, { tui: { sidebar_width_percent: 100 } },
    { tui: { collapse_turn_details: 'false' } }, { tools: { client_search_provider: 'unknown' } },
    { features: { guardianv2: { sync_elastic_sections: { section: { max_section_entry_tokens: 1 } } } } },
    ...[{}, { command: 'x', args: [1] }, { command: 'x', timeout_ms: 0 }, { command: 'x', timeout_ms: 1.5 }, { command: 'x', extra: true }]
      .map(credential_export => ({ model_providers: { custom: { gateway_oauth: { credential_export } } } })),
  ])('rejects invalid new types/ranges/required fields: %j', native => {
    expect(() => normalizeCodexNativeSettings(native)).toThrow();
  });
  it('explains host selection scope and preserves malformed historical input for validation', () => {
    expect(() => normalizeCodexNativeSettings({ tui: { default_hosts: {} } })).toThrow(/host-local.*native host/);
    expect(normalizeStoredCodexNativeSettings(undefined)).toBeUndefined();
    expect(() => normalizeStoredCodexNativeSettings('invalid')).toThrow();
    expect(() => normalizeStoredCodexNativeSettings({ features: 'invalid' })).toThrow();
    expect(() => normalizeStoredCodexNativeSettings({ auto_review: 'invalid' })).toThrow();
  });
});

describe('Codex 0.169 retired controls', () => {
  it('preserves legacy opt-outs, structured precedence, explicit successor values and separate profiles', () => {
    const native = { features: { multi_agent: false }, agents: { max_concurrent_threads_per_session: 2 } };
    expect(normalizeStoredCodexNativeSettings(native)).toEqual({ features: {}, agents: { enabled: false, max_concurrent_threads_per_session: 2 } });
    expect(normalizeStoredCodexNativeSettings(native, { multi_agent: true })).toEqual({ features: {}, agents: { max_concurrent_threads_per_session: 2 } });
    expect(normalizeStoredCodexNativeSettings({ features: { multi_agent: false }, agents: { enabled: true } })).toEqual({ features: {}, agents: { enabled: true } });
    expect(normalizeStoredCodexNativeSettings({ features: { multi_agent: true }, agents: { enabled: false } })).toEqual({ features: {}, agents: { enabled: false } });
    const settings = normalizeSettings({ features: { multi_agent: false }, profiles: [
      { name: 'off', native_settings: native }, { name: 'on', features: { multi_agent: true }, native_settings: native },
    ] });
    expect(settings.native_settings).toEqual({ agents: { enabled: false } });
    expect(normalizeSettings({ features: { multi_agent: false }, native_settings: null }).native_settings).toEqual({ agents: { enabled: false } });
    expect(settings.profiles[0]!.native_settings).toEqual({ features: {}, agents: { enabled: false, max_concurrent_threads_per_session: 2 } });
    expect(settings.profiles[1]!.native_settings).toEqual({ features: {}, agents: { max_concurrent_threads_per_session: 2 } });
  });

  it.each(['multi_agent', 'plugin_discovery_prefetch'])('rejects new %s in every scope and heals exact stored paths', async key => {
    const service = new ClientConfigService(createDbFake() as never);
    for (const settings of [{ features: { [key]: false } }, { native_settings: { features: { [key]: false } } },
      { profiles: [{ name: 'audit', features: { [key]: true } }] }, { profiles: [{ name: 'audit', native_settings: { features: { [key]: true } } }] }]) {
      await expect(service.store({ settings })).rejects.toThrow(/removed or deprecated/);
    }
    const normalized = normalizeSettings({ features: { [key]: true, hooks: false }, native_settings: {
      features: { [key]: false, hooks: false }, mcp_servers: { [`features.${key}`]: { command: '/bin/false' } } } });
    expect(normalized.features).toEqual({ hooks: false });
    expect(normalized.native_settings).toEqual({ features: { hooks: false }, mcp_servers: { [`features.${key}`]: { command: '/bin/false' } } });
    expect(normalized.features).not.toHaveProperty('multi_agent_v2');
  });
  it.each(['experimental_policy_template', 'extra_policy'])('rejects removed auto_review.%s and heals siblings', async key => {
    const native = { auto_review: { [key]: 'old', timeout_ms: 1 }, features: { hooks: false } };
    expect(() => normalizeCodexNativeSettings(native)).toThrow(/removed in Codex 0\.169\.0/);
    expect(normalizeStoredCodexNativeSettings(native)).toEqual({ auto_review: { timeout_ms: 1 }, features: { hooks: false } });
    const service = new ClientConfigService(createDbFake() as never);
    await expect(service.store({ settings: { profiles: [{ name: 'audit', native_settings: native }] } })).rejects.toThrow(/profiles\[0\].*removed/);
  });
});

describe('Codex 0.169 actual parser', () => {
  it.skipIf(!process.env.CODEX_NATIVE_TEST_BIN)('loads rendered root/profile without auth or executing credential exports', () => {
    const home = mkdtempSync(join(tmpdir(), 'codex-169-parser-'));
    const env = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: join(home, 'home'), CODEX_HOME: home };
    mkdirSync(env.HOME);
    try {
      const result = new ClientConfigService({} as never).render({ native_settings: all(), profiles: [{ name: 'audit', native_settings: all() }] });
      for (const content of [result.content, result.profiles![0]!.content]) {
        writeFileSync(join(home, 'config.toml'), content);
        const probe = spawnSync(process.env.CODEX_NATIVE_TEST_BIN!, ['features', 'list'], { env, encoding: 'utf8', timeout: 15000 });
        expect(probe.error).toBeUndefined();
        expect(probe.status, probe.stderr).toBe(0);
        expect(probe.stderr).not.toMatch(/failed to load|Error loading/);
        for (const key of [...flags168, ...flags169]) expect(probe.stdout).toMatch(new RegExp(`^${key}\\s.*false\\s*$`, 'm'));
      }
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
});
