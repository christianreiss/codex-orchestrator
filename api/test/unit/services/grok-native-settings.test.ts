import { describe, expect, it } from 'vitest';
import { ClientConfigService, normalizeGrokSettings, renderGrokSettings, renderTomlForHost } from '../../../src/services/client-config.js';
import { normalizeGrokNativeSettings, renderGrokNativeToml } from '../../../src/services/grok-native-settings.js';
import { presetLevels } from '../../../src/services/agent-security-levels.js';
import { createDbFake } from '../../helpers/db-fake.js';

const native = {
  models: { default: 'grok-4.5', default_reasoning_effort: 'low', max_retries: 7 },
  model: { 'grok-4.5': { context_window: 500000, temperature: 0.4, extra_headers: { 'X.Team': 'infra' } } },
  features: { lsp_tools: true, web_fetch: false },
  tools: { respect_gitignore: true },
  toolset: { bash: { timeout_secs: 30 }, web_fetch: { allowed_domains: ['docs.x.ai'] } },
  session: { auto_compact_threshold_percent: 75, load_envrc: false },
  subagents: { enabled: true, max_concurrent: 3, models: { reviewer: 'grok-4.7' } },
  goal: { enabled: false },
  memory_v2: { enabled: false, rollout: 'off' },
  skills: { paths: ['/srv/skills'] },
  plugins: { disabled: ['unused'] },
  ui: {
    permission_mode: 'ask', timestamps: 'minimal', theme: 'grokday',
    status_line: { type: 'builtin', items: ['cwd', 'model'], padding: 2 },
    notifications: { hooks: [{ command: 'notify', events: ['turn_complete'], only_unfocused: true, timeout_secs: 5 }] },
  },
  hooks: { Stop: [{ hooks: [{ type: 'command', command: 'check-result', timeout: 120 }] }] },
  mcp_servers: { 'docs.with.dot': { url: 'https://example.invalid/mcp', bearer_token_file: '~/token', tool_timeouts: { search: 45 } } },
};

describe('Grok native settings', () => {
  it('keeps native configuration through save, read, normalization and host rendering', async () => {
    const configs = new ClientConfigService(createDbFake() as never);
    const saved = await configs.store({ settings: { native_settings: native } }, null, 'grok');
    const fetched = await configs.adminFetch('grok');
    expect(saved.settings.native_settings).toEqual(native);
    expect(fetched.settings?.native_settings).toEqual(native);
    expect(normalizeGrokSettings(saved.settings)).toEqual(saved.settings);
    expect(saved.settings).toMatchObject({ model: 'grok-4.5', reasoning_effort: 'low', context_window: 500000, permissionMode: 'ask' });
    const rendered = renderTomlForHost({ engine: 'grok', settings: fetched.settings, host: null, baseUrl: null, apiKey: null });
    expect(rendered.content).toBe(saved.content);
    expect(rendered.content).toContain('[toolset.bash]\ntimeout_secs = 30');
    expect(rendered.content).toContain('bearer_token_file = "~/token"');
    expect(rendered.content).toContain('Stop = [{ hooks = [{ type = "command", command = "check-result", timeout = 120 }] }]');
    expect(rendered.content).toContain('[ui.status_line]');
    expect(rendered.content).toContain('[ui.notifications]');
    expect(rendered.owned_paths).toContain('json:["model","grok-4.5","extra_headers","X.Team"]');
    expect(rendered.owned_paths).toContain('mcp_servers.docs.with.dot');
    expect(rendered.owned_paths).toContain('model.grok-4.5.context_window');
    expect(rendered.content).not.toContain('[security]');
    expect(rendered.content).not.toContain('model_reasoning_effort');
  });

  it('structured controls win while unrelated native model fields survive', () => {
    const normalized = normalizeGrokSettings({ native_settings: native, model: 'grok-4.7', reasoning_effort: 'xhigh', context_window: 256000 });
    const content = renderGrokSettings(normalized);
    expect(content).toContain('default = "grok-4.7"');
    expect(content).toContain('default_reasoning_effort = "xhigh"');
    expect(content).toContain('[model."grok-4.7"]\ncontext_window = 256000');
    expect(content).toContain('[model."grok-4.5"]\ncontext_window = 500000\ntemperature = 0.4');
    expect(content).toContain('max_retries = 7');
  });

  it('does not persist a second MCP copy that would hide JSON edits or resurrect deletions', () => {
    const saved = normalizeGrokSettings({ native_settings: native });
    expect(saved.mcp_servers).toEqual([]);
    const edited = normalizeGrokSettings({ ...saved, native_settings: { ...native, mcp_servers: { 'docs.with.dot': { command: 'new-stdio' } } } });
    expect(renderGrokSettings(edited)).toContain('command = "new-stdio"');
    expect(renderGrokSettings(edited)).not.toContain('bearer_token_file');
    const removed = normalizeGrokSettings({ ...saved, native_settings: { ...native, mcp_servers: {} } });
    expect(renderGrokSettings(removed)).not.toContain('docs.with.dot');
    const permissionEdit = normalizeGrokSettings({ ...saved, native_settings: { ...native, ui: { permission_mode: 'default' } } });
    expect(permissionEdit.permissionMode).toBe('default');
  });

  it('empty native tables never claim a whole user table', () => {
    const rendered = renderTomlForHost({ engine: 'grok', settings: { native_settings: { ui: {}, tools: {} } }, host: null, baseUrl: null, apiKey: null });
    expect(rendered.owned_paths).not.toContain('ui');
    expect(rendered.owned_paths).not.toContain('tools');
  });

  it('applies host controls and managed MCP after native settings', () => {
    const rendered = renderTomlForHost({
      engine: 'grok', settings: { native_settings: { ...native, mcp_servers: { cgx: { command: 'untrusted-replacement' } } } },
      host: { grokModelOverride: 'grok-4.7', grokReasoningEffortOverride: 'xhigh', grokWrapperVersion: '0.9.66', grokClientVersion: '1.0.50', secure: 1 } as never,
      baseUrl: 'https://fleet.invalid', apiKey: 'fixture-key', securityLevels: presetLevels('standard'),
    });
    expect(rendered.content).toContain('default = "grok-4.7"');
    expect(rendered.content).toContain('default_reasoning_effort = "xhigh"');
    expect(rendered.content).toContain('permission_mode = "auto"');
    expect(rendered.content).toContain('url = "https://fleet.invalid/mcp"');
    expect(rendered.content).not.toContain('untrusted-replacement');
  });

  it('uses native defaults for a host without overrides', () => {
    const rendered = renderTomlForHost({ engine: 'grok', settings: { native_settings: native }, host: { grokWrapperVersion: '0.9.66', grokClientVersion: '1.0.50' } as never, baseUrl: null, apiKey: null });
    expect(rendered.settings).toMatchObject({ model: 'grok-4.5', reasoning_effort: 'low', context_window: 500000 });
  });

  it('gates ambiguous ownership until the wrapper supports exact path segments', () => {
    const opts = { engine: 'grok' as const, settings: { native_settings: native }, host: { grokWrapperVersion: '0.9.65', grokClientVersion: '1.0.50' } as never, baseUrl: null, apiKey: null };
    expect(() => renderTomlForHost(opts)).toThrow('cxx 0.9.66');
    expect(() => renderTomlForHost({ ...opts, settings: { native_settings: { ui: { theme: 'grokday' } } } })).not.toThrow();
  });

  it.each([
    [{ unknown: true }, 'unknown Grok setting'],
    [{ ui: { unknown: true } }, 'unknown Grok setting'],
    [{ features: { lsp_tools: 'yes' } }, 'expected boolean'],
    [{ ui: { permission_mode: 'bypassPermissions' } }, 'expected =default'],
    [{ ui: { show_timestamps: true } }, 'deprecated; use ui.timestamps'],
    [{ ui: { approval_mode: 'auto' } }, 'deprecated; use ui.permission_mode'],
    [{ model: { 'grok-4.7': { reasoning_effort: 'high' } } }, 'deprecated; use reasoning_efforts'],
    [{ model: { 'grok-4.7': { supports_reasoning_effort: true } } }, 'deprecated; use reasoning_efforts'],
    [{ ui: { scroll_speed: 101 } }, 'expected 1–100'],
    [{ session: { load_envrc: null } }, 'null is not supported'],
    [{ cli: { auto_update: true } }, 'fleet version policy'],
    [{ cli: { use_leader: false } }, 'private leader'],
    [{ auth: { auth_provider_command: 'other' } }, 'managed subscription runtime'],
    [{ endpoints: { models_list_url: 'https://other.invalid' } }, 'managed subscription runtime'],
    [{ compat: { claude: { mcps: true } } }, 'cross-engine MCP imports'],
    [{ mcp_servers: { broken: { url: 'https://x.invalid', command: 'mixed' } } }, 'exactly one'],
    [{ mcp_servers: { broken: { url: 'https://x.invalid', tool_timeout_sec: -1 } } }, 'nonnegative integer'],
    [{ hooks: { Stop: [{ hooks: [{ type: 'http' }] }] } }, 'HTTP hooks require url'],
    [{ version_overrides: [{ minimum_version: '1.0.50', ui: { show_timestamps: true } }] }, 'deprecated'],
    [{ version_overrides: [{ models: { default: 'grok-4.7' } }] }, 'fleet model and posture controls'],
  ])('rejects invalid/deprecated/inert input %#', (value, error) => {
    expect(() => normalizeGrokNativeSettings(value)).toThrow(error);
  });

  it('preserves opt-in HTTP hooks and version-scoped native features', () => {
    const value = { hooks: { Stop: [{ hooks: [{ type: 'http', url: 'https://hook.invalid', timeout: 10 }] }] }, version_overrides: [{ minimum_version: '1.0.50', ui: { timestamps: 'minimal' } }] };
    expect(normalizeGrokNativeSettings(value)).toEqual(value);
  });

  it('rejects pollution and control keys throughout nested dictionaries', () => {
    for (const key of ['__proto__', 'constructor', 'prototype', '\f']) {
      const value = JSON.parse(JSON.stringify({ models: { extra_headers: { [key]: 'value' } } }));
      expect(() => normalizeGrokNativeSettings(value)).toThrow('invalid key');
    }
    expect(Object.prototype).not.toHaveProperty('polluted');
  });

  it('escapes TOML controls without confusing literal backslashes', () => {
    const content = renderGrokNativeToml({ ui: { theme: 'quoted"\\form\f\0\n\t\b\r' } });
    expect(content).toBe('[ui]\ntheme = "quoted\\"\\\\form\\u000c\\u0000\\u000a\\u0009\\u0008\\u000d"\n');
  });

  it.each([
    { models: { default: 'missing-model' } },
    { models: { default: 'grok-4.5', default_reasoning_effort: 'xhigh' } },
    { model: { 'grok-4.7': { context_window: 123 } } },
  ])('rejects native model controls that would otherwise silently fall back %#', native_settings => {
    expect(() => normalizeGrokSettings({ native_settings })).toThrow('unsupported');
  });
});
