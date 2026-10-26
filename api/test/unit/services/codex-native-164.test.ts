import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { normalizeCodexNativeSettings } from '../../../src/services/codex-native-settings.js';
import { ClientConfigService, renderTomlForHost } from '../../../src/services/client-config.js';
import { clientConfigDocuments } from '../../../src/db/schema.js';
import { createDbFake } from '../../helpers/db-fake.js';

const native164 = {
  default_permissions: 'example.profile',
  tui: { presets: { '0': { input: '/review', label: 'Review' }, '9': { input: 'Check unicode: 🐈' } },
    keymap: { chat: { open_presets: ['ctrl-p'] } } },
  hooks: { PreModelRequest: [], PostModelRequest: [] },
  plugins: { 'example.plugin': { remote_plugin_id: 'remote-id', release_id: 'release-id', auto_provision: false } },
  features: { app_server_websocket_compression: false, executor_capability_discovery_v2: false,
    mcp_tool_list_changed: false, multi_env_copy_file: false, subagent_thread_environments: false,
    wake_on_agent_messages: false, runtime_agent_instances: { enabled: false, mode: 'assertion_only' } },
  permissions: { 'example.profile': { network: { mitm: { version: 2, hooks: { x: { host: 'example.test', schemes: ['https'], ports: [443], methods: ['GET'], path_prefixes: ['/'], action: ['strip'] } }, actions: { strip: { strip_request_headers: ['X-Example'], inject_request_headers: [{ name: 'Authorization', secret_env_var: 'TEST_TOKEN', placeholder: 'token-placeholder' }] } } } } } },
  mcp_servers: { 'example.mcp': { url: 'https://example.test/mcp', auth: 'ema_auth', oauth: {
    client_id: 'test-client', client_secret: 'test-secret', token_endpoint_auth_method: 'client_secret_post',
  } } },
  mcp_enterprise_managed_auth: { idp: { issuer: 'https://example.test', client_id: 'test-idp',
    client_secret: 'test-secret', token_endpoint_auth_method: 'client_secret_basic' } },
};
const render = (version: string | null, settings: unknown) => renderTomlForHost({ settings,
  host: { clientVersion: version } as never, baseUrl: null, apiKey: null });

describe('Codex 0.164 native configuration', () => {
  it('keeps root/profile settings through preview/store/fetch/edit/removal and revision conflicts', async () => {
    const db = createDbFake();
    const service = new ClientConfigService(db as never);
    const input = { native_settings: native164, profiles: [{ name: 'review', native_settings: native164 }] };
    const preview = service.render(input);
    const first = await service.store({ settings: input });
    expect(first.content).toBe(preview.content);
    const fetched = await service.adminFetch();
    expect(fetched.settings?.native_settings).toEqual(native164);
    expect(fetched.settings?.profiles[0]?.native_settings).toEqual(native164);
    for (const body of [fetched.content, service.render(fetched.settings).profiles![0]!.content]) {
      expect(body).toContain('[tui.presets.0]');
      expect(body).toContain('[plugins."example.plugin"]');
      expect(body).toContain('[mcp_servers."example.mcp".oauth]');
      expect(body).toContain('auto_provision = false');
      expect(body).toContain('mode = "assertion_only"');
    }
    const edited = structuredClone(fetched.settings!);
    edited.native_settings = { tui: { presets: { '1': { input: 'New' } } } };
    edited.profiles[0]!.native_settings = { hooks: { PreModelRequest: [] } };
    const changed = await service.store({ settings: edited, expected_revision: fetched.revision });
    expect(changed.content).toContain('input = "New"');
    expect(changed.content).not.toMatch(/example.plugin|test-secret|runtime_agent_instances/);
    // This minimal fake does not implement ORDER BY; expose the latest row as MySQL does.
    db.tables.get(clientConfigDocuments)!.sort((a, b) => Number(b.id) - Number(a.id));
    await expect(service.store({ settings: fetched.settings, expected_revision: fetched.revision })).rejects.toThrow(/changed since/);
    const cleared = await service.store({ settings: { native_settings: {}, profiles: [] }, expected_revision: changed.revision });
    expect(cleared.content).not.toMatch(/presets|PreModelRequest|PostModelRequest|auto_provision|runtime_agent_instances/);
  });

  const fields = [
    { tui: { presets: {} } }, { tui: { keymap: { chat: { open_presets: [] } } } },
    { hooks: { PreModelRequest: [] } }, { hooks: { PostModelRequest: [] } },
    { hooks: { state: { 'example.plugin': { trusted_content_hash: '' } } } },
    ...['app_server_websocket_compression', 'executor_capability_discovery_v2', 'mcp_tool_list_changed',
      'multi_env_copy_file', 'subagent_thread_environments', 'wake_on_agent_messages', 'runtime_agent_instances']
      .map(key => ({ features: { [key]: false } })),
    ...['remote_plugin_id', 'release_id', 'auto_provision'].map(key => ({ plugins: { 'plugin.with.dots': { [key]: key === 'auto_provision' ? false : '' } } })),
    { mcp_servers: native164.mcp_servers },
    { mcp_enterprise_managed_auth: native164.mcp_enterprise_managed_auth },
    { permissions: { 'profile.with.dots': { network: { mitm: { version: 2 } } } } },
    { permissions: { p: { network: { mitm: { hooks: { x: { host: 'example.test', action: ['strip'], methods: [], path_prefixes: [], ports: [] } } } } } } },
    { permissions: { p: { network: { mitm: { hooks: { x: { host: 'example.test', action: ['strip'], methods: [], path_prefixes: [], schemes: [] } } } } } } },
    { permissions: { p: { network: { mitm: { version: 2, actions: { x: { inject_request_headers: [{ name: 'Authorization', placeholder: '' }] } } } } } } },
  ];
  it.each(fields)('requires 0.164 for new fields including empty/false: %j', value => {
    for (const input of [{ native_settings: value }, { profiles: [{ name: 'new', native_settings: value }] }]) {
      expect(() => render('0.163.0', input)).toThrow(/0\.164\.0.*cdx update/);
      expect(() => render(null, input)).toThrow(/0\.164\.0.*unreported/);
      expect(() => render('0.164.0', input)).not.toThrow();
    }
  });
  it('gates structured new features and MCP options as well', () => {
    expect(() => render('0.163.0', { features: { wake_on_agent_messages: false } })).toThrow(/0\.164\.0/);
    expect(() => render('0.163.0', { mcp_servers: [{ name: 'custom', ...native164.mcp_servers['example.mcp'] }] })).toThrow(/0\.164\.0/);
  });
  it('does not interpret opaque map keys as capability paths or activate new defaults', () => {
    expect(() => render('0.162.1', { native_settings: {
      plugins: { 'tui.presets': { enabled: false }, auto_provision: { enabled: false } },
      mcp_servers: { 'features.runtime_agent_instances': { command: '/bin/echo' } },
    } })).not.toThrow();
    expect(render(null, {}).content).not.toMatch(/presets|wake_on_agent_messages|app_server_websocket_compression/);
  });
  it.each(['realtime_conversation', 'stable_environment_tools', 'worktrees'])('rejects removed %s on every authoring surface', key => {
    const service = new ClientConfigService({} as never);
    for (const input of [{ features: { [key]: false } }, { native_settings: { features: { [key]: false } } },
      { profiles: [{ name: 'old', features: { [key]: true } }] },
      { profiles: [{ name: 'old', native_settings: { features: { [key]: true } } }] }]) {
      expect(() => service.render(input)).toThrow(new RegExp(`${key}.*removed`));
    }
  });
  it.each([
    { tui: { presets: { '10': { input: 'bad slot' } } } },
    { tui: { presets: { a: { input: 'bad slot' } } } },
    { tui: { presets: { '0': { input: 'x'.repeat(8001) } } } },
    { tui: { presets: { '0': { input: '🐈'.repeat(2001) } } } },
    { tui: { presets: { '0': { label: 'missing input' } } } },
    { features: { runtime_agent_instances: { mode: 'unknown' } } },
    { permissions: { p: { network: { mitm: { version: 1 } } } } },
    { permissions: { p: { network: { mitm: { version: 2, hooks: { x: { host: 'example.test', action: ['strip'], methods: [], path_prefixes: [], ports: [65536] } } } } } } },
    { permissions: { p: { network: { mitm: { version: 2, actions: { x: { unexpected: true } } } } } } },
    { permissions: { p: { network: { mitm: { actions: { x: {} } } } } } },
    { permissions: { p: { network: { mitm: { hooks: { x: { host: 'example.test', action: ['strip'], methods: [], path_prefixes: [], ports: [443] } } } } } } },
    { permissions: { p: { network: { mitm: { hooks: { x: { host: 'example.test', action: [], methods: [], path_prefixes: [] } } } } } } },
    { permissions: { p: { network: { mitm: { actions: { x: { inject_request_headers: [{ name: 'Authorization', placeholder: 'x' }] } } } } } } },
    { mcp_servers: { x: { url: 'https://example.test', oauth: { token_endpoint_auth_method: 'client_secret_basic' } } } },
    { mcp_servers: { x: { url: 'https://example.test', auth: 'ema_auth', oauth: { token_endpoint_auth_method: 'client_secret_basic', client_secret: '' } } } },
    { mcp_servers: { x: { url: 'https://example.test', auth: 'ema_auth', oauth: { token_endpoint_auth_method: 'client_secret_basic', client_secret: 'test-secret' } } } },
    { mcp_enterprise_managed_auth: { idp: { issuer: 'https://example.test', client_id: 'id', token_endpoint_auth_method: 'client_secret_basic' } } },
    { mcp_enterprise_managed_auth: { idp: { issuer: 'https://example.test', client_id: 'id', client_secret: '' } } },
  ])('rejects native-invalid types and semantic constraints', input => {
    expect(() => normalizeCodexNativeSettings(input)).toThrow();
  });
  it('counts UTF-8 bytes and never exposes a secret in semantic errors', () => {
    expect(() => normalizeCodexNativeSettings({ tui: { presets: { '0': { input: '🐈'.repeat(2000) } } } })).not.toThrow();
    expect(() => normalizeCodexNativeSettings({ mcp_servers: { x: { url: 'https://example.test', oauth: {
      token_endpoint_auth_method: 'client_secret_basic', client_secret: 'never-echo-this-secret',
    } } } })).toThrow(/requires auth=ema_auth/);
    try { normalizeCodexNativeSettings({ mcp_servers: { x: { url: 'https://example.test', oauth: {
      token_endpoint_auth_method: 'client_secret_basic', client_secret: 'never-echo-this-secret',
    } } } }); } catch (error) { expect(String(error)).not.toContain('never-echo-this-secret'); }
  });
  it.skipIf(!process.env.CODEX_NATIVE_TEST_BIN)('parses rendered root and profile with native 0.164 without a session', () => {
    const result = new ClientConfigService({} as never).render({ native_settings: native164,
      profiles: [{ name: 'native', native_settings: native164 }] });
    const home = mkdtempSync(join(tmpdir(), 'codex-164-parser-'));
    try {
      for (const body of [result.content, result.profiles![0]!.content]) {
        writeFileSync(join(home, 'config.toml'), body);
        const probe = spawnSync(process.env.CODEX_NATIVE_TEST_BIN!, ['features', 'list'], {
          env: { ...process.env, CODEX_HOME: home }, encoding: 'utf8', timeout: 15000,
        });
        expect(probe.error).toBeUndefined();
        expect(probe.status, probe.stderr).toBe(0);
        expect(probe.stderr).not.toContain('Error loading configuration');
      }
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
});
