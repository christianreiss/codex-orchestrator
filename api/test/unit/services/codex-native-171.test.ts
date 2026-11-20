import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { ClientConfigService, renderTomlForHost } from '../../../src/services/client-config.js';
import { normalizeCodexNativeSettings } from '../../../src/services/codex-native-settings.js';
import { createDbFake } from '../../helpers/db-fake.js';

const flags170 = ['multi_environment_mcp'];
const flags171 = ['catalog_apps_instructions', 'file_backed_tool_audio', 'guardian_nested_approval_context',
  'mcp_shared_repl_cwd', 'per_environment_context', 'restored_history_prewarm', 'safe_image_decoder', 'utc_environment_date'];
const section = { min_total_section_tokens: 0, max_section_entry_tokens: 1, max_total_section_tokens: 2, nested_tool_names: ['shell'] };
const all170 = () => ({
  features: { multi_environment_mcp: true,
    guardianv2: { sync_elastic_sections: { 'section.with.dots': section } } },
  otel: { headers_helper: '/never-run/headers-helper', headers_helper_refresh_interval_ms: 60000 },
});
const all171 = () => ({
  features: { ...Object.fromEntries(flags171.map(key => [key, false])),
    guardianv2: { async_elastic_budgeting: true, async_elastic_sections: { 'async.with.dots': section } },
    multi_agent_v2: { interrupt_at_item_boundary: true },
    token_budget: { context_window_as_tool_output: true },
    rollout_budget: { limit_budget: 2.5, reminder_at_context_start: false, reminder_at_remaining_tokens: [1] },
    network_proxy: { transparent_tcp: true } },
  code_mode: { heartbeat_interval_s: 30 },
  responses: { process_mode: 'after_complete_response' },
  rollout_trace: { max_bytes: 1024, max_payload_bytes: 512 },
  tui: { status_line_provider: { server: 'status.with.dots', tool: 'line' },
    keymap: { composer: { undo: 'ctrl-z', redo: ['ctrl-y'] }, global: { choose_cloud_environment: [] }, pager: { mark_markdown: 'm' } } },
  marketplaces: { 'market.with.dots': { auto_update: true } },
  permissions: { audit: { network: { transparent_tcp: true } } },
});
const all = () => {
  const a = all170(), b = all171();
  return { ...a, ...b, features: { ...a.features, ...b.features, guardianv2: { ...a.features.guardianv2, ...b.features.guardianv2,
    sync_elastic_sections: a.features.guardianv2.sync_elastic_sections } } };
};
const render = (version: string | null, settings: unknown) => renderTomlForHost({ settings,
  host: { clientVersion: version } as never, baseUrl: null, apiKey: null });
const profileOf = (native: unknown) => ({ profiles: [{ name: 'audit', native_settings: native }] });

describe('Codex 0.170/0.171 native settings', () => {
  it('roundtrips, changes and removes root/profile fields with literal names', async () => {
    const service = new ClientConfigService(createDbFake() as never), native = all();
    const stored = await service.store({ settings: { native_settings: native, profiles: [{ name: 'audit', native_settings: native }] } });
    const fetched = await service.adminFetch();
    expect(fetched.settings?.native_settings).toEqual(native);
    expect(fetched.settings?.profiles[0]?.native_settings).toEqual(native);
    for (const content of [stored.content, service.render(fetched.settings).profiles![0]!.content]) {
      expect(content).toContain('[code_mode]');
      expect(content).toContain('heartbeat_interval_s = 30');
      expect(content).toContain('process_mode = "after_complete_response"');
      expect(content).toContain('[rollout_trace]');
      expect(content).toContain('limit_budget = 2.5');
      expect(content).toContain('headers_helper = "/never-run/headers-helper"');
      expect(content).toContain('headers_helper_refresh_interval_ms = 60000');
      expect(content).toContain('[tui.status_line_provider]');
      expect(content).toContain('server = "status.with.dots"');
      expect(content).toContain('[marketplaces."market.with.dots"]');
      expect(content).toContain('auto_update = true');
      expect(content).toContain('[features.guardianv2.sync_elastic_sections."section.with.dots"]');
      expect(content).toContain('[features.guardianv2.async_elastic_sections."async.with.dots"]');
      expect(content).toContain('nested_tool_names = ["shell"]');
      expect(content).toContain('[permissions.audit.network]');
      expect(content).toContain('transparent_tcp = true');
      expect(content).toContain('[features.network_proxy]');
      expect(content).toContain('mark_markdown = "m"');
    }
    const changed = await service.store({ settings: { native_settings: { code_mode: { heartbeat_interval_s: 0 } } }, expected_revision: stored.revision });
    expect(changed.content).toContain('heartbeat_interval_s = 0');
    const removed = await service.store({ settings: { native_settings: {}, profiles: [{ name: 'audit', native_settings: {} }] } });
    expect(removed.content).not.toMatch(/heartbeat_interval_s|rollout_trace|headers_helper|status_line_provider|auto_update|elastic_sections|limit_budget/);
    expect(render(null, {}).content).not.toMatch(/code_mode|headers_helper|multi_environment_mcp|rollout_trace/);
  });

  it('serialises the string form of tui.status_line_provider', () => {
    const content = render('0.171.0', { native_settings: { tui: { status_line_provider: 'default' } } }).content;
    expect(content).toContain('status_line_provider = "default"');
  });

  const added170 = [
    ...flags170.map(key => ({ features: { [key]: false } })),
    { otel: { headers_helper: 'helper' } }, { otel: { headers_helper_refresh_interval_ms: 1 } },
    { features: { guardianv2: { sync_elastic_sections: { s: section } } } },
  ];
  it.each(added170)('gates exact 0.170 root/profile additions: %j', native => {
    for (const settings of [{ native_settings: native }, profileOf(native)]) {
      expect(() => render('0.169.0', settings)).toThrow(/0\.170\.0/);
      expect(() => render(null, settings)).toThrow(/0\.170\.0.*unreported/);
      expect(() => render('0.170.0', settings)).not.toThrow();
      expect(() => render('0.171.0', settings)).not.toThrow();
    }
  });
  const added171 = [
    ...flags171.map(key => ({ features: { [key]: false } })),
    { code_mode: {} }, { code_mode: { heartbeat_interval_s: 1 } },
    { responses: { process_mode: 'streaming' } }, { responses: {} },
    { rollout_trace: {} }, { rollout_trace: { max_bytes: 1 } }, { rollout_trace: { max_payload_bytes: 1 } },
    { tui: { status_line_provider: 'default' } },
    { tui: { status_line_provider: { server: 's', tool: 't' } } },
    { marketplaces: { m: { auto_update: false } } },
    { tui: { keymap: { composer: { undo: [] } } } }, { tui: { keymap: { composer: { redo: [] } } } },
    { tui: { keymap: { global: { choose_cloud_environment: [] } } } },
    { tui: { keymap: { pager: { mark_markdown: [] } } } },
    { features: { guardianv2: { async_elastic_budgeting: false } } },
    { features: { guardianv2: { async_elastic_sections: {} } } },
    { features: { guardianv2: { async_elastic_sections: { s: section } } } },
    { features: { multi_agent_v2: { interrupt_at_item_boundary: false } } },
    { features: { token_budget: { context_window_as_tool_output: false } } },
    { features: { rollout_budget: { limit_budget: 1 } } },
    { features: { rollout_budget: { reminder_at_context_start: false } } },
    { features: { network_proxy: { transparent_tcp: false } } },
    { permissions: { audit: { network: { transparent_tcp: false } } } },
  ];
  it.each(added171)('gates exact 0.171 root/profile additions: %j', native => {
    for (const settings of [{ native_settings: native }, profileOf(native)]) {
      for (const version of ['0.169.0', '0.170.0']) expect(() => render(version, settings)).toThrow(/0\.171\.0/);
      expect(() => render(null, settings)).toThrow(/0\.171\.0.*unreported/);
      expect(() => render('0.171.0', settings)).not.toThrow();
    }
  });
  it('requires the higher floor when both generations are authored and gates structured profile features', () => {
    expect(() => render('0.170.0', { native_settings: all() })).toThrow(/0\.171\.0/);
    expect(() => render('0.171.0', { native_settings: all() })).not.toThrow();
    expect(() => render('0.170.0', { profiles: [{ name: 'audit', features: { safe_image_decoder: true } }] })).toThrow(/0\.171\.0/);
  });
  it('keeps opaque names and earlier floors untouched', () => {
    expect(() => render('0.162.1', { native_settings: { mcp_servers: { 'features.safe_image_decoder': { command: '/bin/false' },
      'otel.headers_helper': { command: '/bin/false' } }, model_providers: { 'code_mode.heartbeat_interval_s': { name: 'Audit' } },
      plugins: { 'auto_update': { enabled: true } } } })).not.toThrow();
    // 0.169-era authoring keeps its floor.
    expect(() => render('0.169.0', { native_settings: { tui: { collapse_turn_details: true }, features: { gateway_setup_wizard: false } } })).not.toThrow();
    expect(() => render('0.168.0', { native_settings: { tui: { collapse_turn_details: true } } })).toThrow(/0\.169\.0/);
  });

  it.each([
    { code_mode: { heartbeat_interval_s: -1 } }, { code_mode: { heartbeat_interval_s: 1.5 } }, { code_mode: { unknown: 1 } },
    { responses: { process_mode: 'unknown' } }, { responses: { unknown: 1 } },
    { rollout_trace: { max_bytes: -1 } }, { rollout_trace: { unknown: 1 } },
    { tui: { status_line_provider: 'custom' } }, { tui: { status_line_provider: { server: 's' } } },
    { tui: { status_line_provider: { server: 's', tool: 't', extra: 1 } } },
    { marketplaces: { m: { auto_update: 'yes' } } },
    { otel: { headers_helper_refresh_interval_ms: 0 } }, { otel: { headers_helper: 1 } },
    { features: { rollout_budget: { limit_budget: 0 } } }, { features: { rollout_budget: { limit_budget: 'many' } } },
    { features: { guardianv2: { async_elastic_sections: { s: { nested_tool_names: [1] } } } } },
    { features: { guardianv2: { async_elastic_sections: { s: { max_section_entry_tokens: 1 } } } } },
    { tui: { keymap: { composer: { undo: 'not a key !' } } } },
    { features: { safe_image_decoder: 'yes' } },
  ])('rejects invalid new types/ranges/required fields: %j', native => {
    expect(() => normalizeCodexNativeSettings(native)).toThrow();
  });
});

describe('Codex 0.171 rollout_budget semantics', () => {
  const budget = (fields: Record<string, unknown>) => ({ features: { rollout_budget: fields } });
  it('accepts limit_budget alone and still accepts limit_tokens alone', () => {
    expect(() => normalizeCodexNativeSettings(budget({ enabled: true, limit_budget: 100.5, reminder_at_remaining_tokens: [10] }))).not.toThrow();
    expect(() => normalizeCodexNativeSettings(budget({ enabled: true, limit_tokens: 100, reminder_at_remaining_tokens: [10] }))).not.toThrow();
    expect(() => normalizeCodexNativeSettings(budget({ limit_budget: 100 }))).not.toThrow();
  });
  it.each([true, false, undefined])('rejects limit_tokens together with limit_budget (enabled=%s)', enabled => {
    expect(() => normalizeCodexNativeSettings(budget({ ...(enabled === undefined ? {} : { enabled }), limit_tokens: 100, limit_budget: 100,
      reminder_at_remaining_tokens: [10] }))).toThrow(/limit_tokens and limit_budget cannot both be set/);
  });
  it('requires an allowance and reminder thresholds when enabled', () => {
    expect(() => normalizeCodexNativeSettings(budget({ enabled: true, reminder_at_remaining_tokens: [10] })))
      .toThrow(/rollout_budget\.limit_tokens or limit_budget is required/);
    expect(() => normalizeCodexNativeSettings(budget({ enabled: true, limit_budget: 100 })))
      .toThrow(/rollout_budget\.reminder_at_remaining_tokens is required/);
    expect(() => normalizeCodexNativeSettings(budget({ enabled: true, limit_tokens: 100 })))
      .toThrow(/rollout_budget\.reminder_at_remaining_tokens is required/);
  });
  it('rejects conflicting allowances across structured and native layers once merged', () => {
    const service = new ClientConfigService({} as never);
    const native_settings = { features: { rollout_budget: { limit_tokens: 1000, reminder_at_remaining_tokens: [100] } } };
    expect(() => service.render({ native_settings, features: { rollout_budget: { limit_budget: 5 } } })).toThrow(/cannot both be set/);
    expect(() => service.render({ native_settings: { features: { rollout_budget: { limit_budget: 5, reminder_at_remaining_tokens: [1] } } },
      features: { rollout_budget: { enabled: true } } })).not.toThrow();
  });
});

describe('Codex 0.171 actual parser', () => {
  // The native loader requires a default when [permissions] profiles exist.
  // Enabled elastic budgeting makes the native loader enforce closed section keys and a
  // cross-section token sum that the schema does not express; the probe keeps it off, like 0.169.
  const parserNative = () => {
    const native = all();
    native.features.guardianv2.async_elastic_budgeting = false;
    return { ...native, default_permissions: 'audit' };
  };
  it.skipIf(!process.env.CODEX_NATIVE_TEST_BIN)('loads rendered root/profile without auth or running helpers', () => {
    const home = mkdtempSync(join(tmpdir(), 'codex-171-parser-'));
    const env = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: join(home, 'home'), CODEX_HOME: home };
    mkdirSync(env.HOME);
    try {
      const result = new ClientConfigService({} as never).render({ native_settings: parserNative(), profiles: [{ name: 'audit', native_settings: parserNative() }] });
      for (const content of [result.content, result.profiles![0]!.content]) {
        writeFileSync(join(home, 'config.toml'), content);
        const probe = spawnSync(process.env.CODEX_NATIVE_TEST_BIN!, ['features', 'list'], { env, encoding: 'utf8', timeout: 15000 });
        expect(probe.error).toBeUndefined();
        expect(probe.status, probe.stderr).toBe(0);
        expect(probe.stderr).not.toMatch(/failed to load|Error loading/);
        for (const key of [...flags170, ...flags171]) expect(probe.stdout).toMatch(new RegExp(`^${key}\\s.*(true|false)\\s*$`, 'm'));
      }
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
});
