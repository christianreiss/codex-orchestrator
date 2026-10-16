import { describe, expect, it } from 'vitest';
import { ClientConfigService, normalizeGrokSettings, renderGrokSettings, renderTomlForHost } from '../../../src/services/client-config.js';
import { normalizeGrokNativeSettings, renderGrokNativeToml } from '../../../src/services/grok-native-settings.js';
import { presetLevels } from '../../../src/services/agent-security-levels.js';
import { createDbFake } from '../../helpers/db-fake.js';
import { clientConfigDocuments } from '../../../src/db/schema.js';
import { ModelDefaultsService } from '../../../src/services/model-defaults.js';

const native = {
  models: { max_retries: 7 },
  model: { 'grok-4.5': { context_window: 500000, temperature: 0.4, extra_headers: { 'X.Team': 'infra' } } },
  features: { lsp_tools: true, web_fetch: false },
  tools: { respect_gitignore: true },
  toolset: { bash: { timeout_secs: 30 }, web_fetch: { allowed_domains: ['docs.x.ai'] } },
  session: { auto_compact_threshold_percent: 75, load_envrc: false },
  subagents: { enabled: true, max_concurrent: 3, models: { reviewer: 'grok-4.7' } },
  goal: { enabled: false },
  memory: { enabled: false },
  memory_v2: { enabled: false, batch_dream_enabled: false },
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
    const saved = await configs.store({ settings: { model: 'grok-4.5', reasoning_effort: 'low', native_settings: native } }, null, 'grok');
    const fetched = await configs.adminFetch('grok');
    expect(saved.settings.native_settings).toEqual(native);
    expect(fetched.settings?.native_settings).toEqual(native);
    expect(normalizeGrokSettings(saved.settings)).toEqual(saved.settings);
    expect(saved.settings).toMatchObject({ model: 'grok-4.5', reasoning_effort: 'low' });
    expect(saved.settings).not.toHaveProperty('context_window');
    expect(saved.settings).not.toHaveProperty('permissionMode');
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
    expect(permissionEdit).not.toHaveProperty('permissionMode');
    expect(renderGrokSettings(permissionEdit)).toContain('permission_mode = "default"');
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
    const rendered = renderTomlForHost({ engine: 'grok', settings: { model: 'grok-4.5', reasoning_effort: 'low', native_settings: native }, host: { grokWrapperVersion: '0.9.66', grokClientVersion: '1.0.50' } as never, baseUrl: null, apiKey: null });
    expect(rendered.settings).toMatchObject({ model: 'grok-4.5', reasoning_effort: 'low' });
    expect(rendered.settings).not.toHaveProperty('context_window');
    expect(rendered.content).toContain('context_window = 500000');
  });

  it('gates ambiguous ownership until the wrapper supports exact path segments', () => {
    const opts = { engine: 'grok' as const, settings: { native_settings: native }, host: { grokWrapperVersion: '0.9.65', grokClientVersion: '1.0.50' } as never, baseUrl: null, apiKey: null };
    expect(() => renderTomlForHost(opts)).toThrow('cxx 0.9.66');
    expect(() => renderTomlForHost({ ...opts, settings: { native_settings: { ui: { theme: 'grokday' } } } })).not.toThrow();
  });

  it.each([
    [{ memory: { embedding: { dimensions: 128 } } }, 'native_settings.memory.embedding: removed'],
    [{ memory: { initial_injection: {} } }, 'native_settings.memory.initial_injection: removed'],
    [{ memory_v2: { rollout: 'off' } }, 'native_settings.memory_v2.rollout: removed'],
    [{ version_overrides: [{ minimum_version: '1.0.50', memory_v2: { capture_enabled: false } }] }, 'removed'],
    [{ shell_environment_policy: { inherit: 'audit' } }, 'native_settings.shell_environment_policy.inherit: expected =core'],
    [{ ui: { status_line: { type: 'builtin', items: [] } } }, 'builtin status lines require at least one item'],
    [{ ui: { status_line: { type: 'builtin', items: ['unknown'] } } }, 'native_settings.ui.status_line.items.0: expected cwd'],
    [{ ui: { status_line: { type: 'builtin', refresh_interval: 5 } } }, 'only command status lines'],
    [{ ui: { status_line: { command: 'audit' } } }, 'native_settings.ui.status_line.type: required'],
    [{ ui: { status_line: { type: 'command' } } }, 'native_settings.ui.status_line.command: command status lines require'],
    [{ model: { 'custom.with.dots': { notice: {} } } }, 'native_settings.model.custom.with.dots.notice.text: notice requires text'],
    [{ model: { custom: { notice: { text: 'hello', extra: true } } } }, 'unknown Grok setting'],
    [{ model: { custom: { notice: { text: 'hello', severity: 'bad' } } } }, 'expected =info'],
    [{ model: { custom: { 6: { api_key: 'invalid' } } } }, 'unknown Grok setting'],
    [{ features: { tool_search: true } }, 'unknown Grok setting'],
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
    [{ version_overrides: [{ models: { default: 'grok-4.7' } }] }, 'use settings.model'],
  ])('rejects invalid/deprecated/inert input %#', (value, error) => {
    expect(() => normalizeGrokNativeSettings(value)).toThrow(error);
  });

  it.each(['core', 'all', 'none'])('accepts native shell inheritance %s', inherit => {
    const input = { shell_environment_policy: { inherit }, memory: { enabled: false }, workflows: { enabled: false }, model: { 'custom.with.dots': { notice: { text: '', severity: 'info', label: 'custom' } } } };
    expect(normalizeGrokNativeSettings(input)).toEqual(input);
    expect(renderGrokNativeToml(input)).toContain('[model."custom.with.dots".notice]');
  });

  it.each(['builtin', 'disabled', 'off', 'none', 'hidden'])('accepts native status line type %s', type => {
    expect(normalizeGrokNativeSettings({ ui: { status_line: { type } } })).toEqual({ ui: { status_line: { type } } });
  });

  it('preserves opt-in HTTP hooks and version-scoped native features', () => {
    const value = { hooks: { Stop: [{ hooks: [{ type: 'http', url: 'https://hook.invalid', timeout: 10 }] }] }, version_overrides: [{ minimum_version: '1.0.50', ui: { timestamps: 'minimal' } }] };
    expect(normalizeGrokNativeSettings(value)).toEqual(value);
  });

  it.each([
    ['memory', 'embedding'], ['memory', 'initial_injection'], ['memory', 'search'], ['memory', 'session'], ['memory', 'watcher'],
    ['memory_v2', 'automatic_dream_enabled'], ['memory_v2', 'capture_enabled'], ['memory_v2', 'capture_status_enabled'],
    ['memory_v2', 'file_writes_enabled'], ['memory_v2', 'manual_dream_enabled'], ['memory_v2', 'rollout'],
  ])('rejects removed %s.%s before storing any row', async (root, key) => {
    const db = createDbFake();
    const configs = new ClientConfigService(db as never);
    const settings = { native_settings: { [root]: { [key]: false } } };
    await expect(configs.store({ settings }, null, 'grok')).rejects.toThrow(`native_settings.${root}.${key}: removed`);
    expect(db.tables.get(clientConfigDocuments)).toBeUndefined();
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
    [{ models: { default: 'grok-4.5' } }, 'settings.model'],
    [{ models: { default_reasoning_effort: 'low' } }, 'settings.reasoning_effort'],
  ])('reserves model controls before normalization, rendering or storage %#', async (native_settings, control) => {
    const db = createDbFake();
    const configs = new ClientConfigService(db as never);
    const settings = { native_settings };
    expect(() => normalizeGrokSettings(settings)).toThrow(`use ${control}`);
    expect(() => configs.render(settings, 'grok')).toThrow(`use ${control}`);
    await expect(configs.store({ settings }, null, 'grok')).rejects.toThrow(`use ${control}`);
    expect(db.tables.get(clientConfigDocuments)).toBeUndefined();
  });

  it.each(['grok-4.7', 'grok-4.5'])('rejects invalid windows for the selected or another model: %s', model => {
    expect(() => normalizeGrokSettings({ native_settings: { model: { [model]: { context_window: 123 } } } })).toThrow('unsupported');
  });

  it.each([
    { field: 'memory switch', first: { memory: { enabled: false } }, next: { memory: { enabled: true } }, initialText: 'enabled = false', editedText: 'enabled = true', absentText: '[memory]' },
    { field: 'workflows switch', first: { workflows: { enabled: false } }, next: { workflows: { enabled: true } }, initialText: 'enabled = false', editedText: 'enabled = true', absentText: '[workflows]' },
    { field: 'selected model context', first: { model: { 'grok-4.7': { context_window: 500000 } } }, next: { model: { 'grok-4.7': { context_window: 256000 } } }, initialText: 'context_window = 500000', editedText: 'context_window = 256000', absentText: 'context_window = 500000' },
    { field: 'other model context', first: { model: { 'grok-4.5': { context_window: 500000 } } }, next: { model: { 'grok-4.5': { context_window: 256000 } } }, initialText: '[model."grok-4.5"]\ncontext_window = 500000', editedText: '[model."grok-4.5"]\ncontext_window = 256000', absentText: '[model."grok-4.5"]' },
    { field: 'permission mode', first: { ui: { permission_mode: 'ask' } }, next: { ui: { permission_mode: 'default' } }, initialText: 'permission_mode = "ask"', editedText: 'permission_mode = "default"', absentText: 'permission_mode' },
    { field: 'MCP transport', first: { mcp_servers: { docs: { url: 'https://old.invalid' } } }, next: { mcp_servers: { docs: { command: 'new-stdio' } } }, initialText: 'url = "https://old.invalid"', editedText: 'command = "new-stdio"', absentText: '[mcp_servers.docs]' },
  ])('preserves add/edit/delete after store and adminFetch: $field', async ({ first, next, initialText, editedText, absentText }) => {
    const db = createDbFake();
    const configs = new ClientConfigService(db as never);
    const saveAndFetch = async (settings: unknown) => {
      const saved = await configs.store({ settings }, null, 'grok');
      // The generic fake does not implement ORDER BY; mirror the real newest-first read.
      db.tables.get(clientConfigDocuments)!.sort((a, b) => Number(b.id) - Number(a.id));
      const fetched = await configs.adminFetch('grok');
      expect(fetched.settings).toEqual(saved.settings);
      expect(normalizeGrokSettings(fetched.settings)).toEqual(saved.settings);
      expect(fetched.settings).not.toHaveProperty('context_window');
      expect(fetched.settings).not.toHaveProperty('permissionMode');
      expect(fetched.settings?.mcp_servers).toEqual([]);
      const rendered = renderTomlForHost({ engine: 'grok', settings: fetched.settings, host: null, baseUrl: null, apiKey: null });
      expect(rendered.content).toBe(saved.content);
      return { settings: fetched.settings!, content: rendered.content };
    };
    const empty = await saveAndFetch({});
    const added = await saveAndFetch({ ...empty.settings, native_settings: first });
    expect(added.content).toContain(initialText);
    const edited = await saveAndFetch({ ...added.settings, native_settings: next });
    expect(edited.content).toContain(editedText);
    expect(edited.content).not.toContain(initialText);
    const removed = await saveAndFetch({ ...edited.settings, native_settings: {} });
    expect(removed.content).not.toContain(absentText);
    expect(removed.content).toContain('[model."grok-4.7"]\ncontext_window = 256000');
  });

  it('reports the effective native context without persisting it and honors explicit canonical overrides', async () => {
    const db = createDbFake();
    const configs = new ClientConfigService(db as never);
    const native_settings = { model: { 'grok-4.7': { context_window: 500000, temperature: 0.4 } }, ui: { permission_mode: 'ask' } };
    const saved = await configs.store({ settings: { native_settings } }, null, 'grok');
    const defaults = new ModelDefaultsService(db as never);
    expect(await defaults.get('grok')).toMatchObject({ context_window: 500000 });
    expect((await configs.adminFetch('grok')).settings).not.toHaveProperty('context_window');
    const override = configs.render({ ...saved.settings, context_window: 256000, permission_mode: 'auto' }, 'grok');
    expect(override.content).toContain('context_window = 256000');
    expect(override.content).toContain('permission_mode = "auto"');
    expect(override.content).toContain('temperature = 0.4');
    expect(override.settings).toMatchObject({ context_window: 256000, permissionMode: 'auto', native_settings });
    expect(configs.render(override.settings, 'grok').content).toBe(override.content);
  });
});
