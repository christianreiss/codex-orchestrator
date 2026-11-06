import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { ClientConfigService, renderTomlForHost } from '../../../src/services/client-config.js';
import { normalizeSettings } from '../../../src/services/config-normalizer.js';
import { CODEX_RETIRED_FEATURE_KEYS, normalizeCodexNativeSettings, normalizeStoredCodexNativeSettings } from '../../../src/services/codex-native-settings.js';
import { createDbFake } from '../../helpers/db-fake.js';
import { clientConfigDocuments } from '../../../src/db/schema.js';

const flags = ['apps_early_resource_discovery', 'code_mode_host_output_truncation', 'gcp_setup_wizard',
  'incremental_exec_tools', 'interrupt_on_cancel', 'suppress_model_change_announcements', 'tui_extensions_statusline'];
const oauth = (extra: Record<string, unknown> = {}) => ({ authorization_url: 'https://idp.example.test/authorize',
  client_id: 'audit-client', token_url: 'https://idp.example.test/token', ...extra });
const gateway = (extra: Record<string, unknown> = {}) => ({ name: 'Audit gateway', base_url: 'https://gateway.example.test/v1', ...extra });
const all = () => ({ features: Object.fromEntries(flags.map(key => [key, false])), otel: { log_sse_deltas: false },
  model_providers: { 'audit-gateway': gateway({ gateway_oauth: oauth({ credentials_store: 'file' }), capabilities: { cyber_access_programs: true } }) },
  plugins: { 'example.plugin': { apps: { 'connector.audit': { enabled: false } } } } });
const render = (version: string | null, settings: unknown) => renderTomlForHost({ settings,
  host: { clientVersion: version } as never, baseUrl: null, apiKey: null });

describe('Codex 0.167 native configuration', () => {
  it('vendors the exact official versioned schema', () => {
    expect(createHash('sha256').update(readFileSync(new URL('../../../src/services/codex-config-schema.json', import.meta.url))).digest('hex'))
      .toBe('66ed795352d32f2464778acd2e332b7fafe644246d540cdceec4663c56cfbc16');
  });

  it('keeps the retired feature list unchanged (0.167 removes no feature keys)', () => {
    for (const key of flags) expect(CODEX_RETIRED_FEATURE_KEYS).not.toContain(key);
    expect(() => normalizeCodexNativeSettings({ features: { js_repl: false } })).toThrow(/removed or deprecated/);
  });

  it('roundtrips every new field at root and profile, edits and withdraws without changing defaults', async () => {
    const service = new ClientConfigService(createDbFake() as never), native = all();
    const input = { native_settings: native, profiles: [{ name: 'new', native_settings: native }] };
    const first = await service.store({ settings: input });
    const fetched = await service.adminFetch();
    expect(fetched.settings?.native_settings).toEqual(native);
    expect(fetched.settings?.profiles[0]?.native_settings).toEqual(native);
    for (const content of [first.content, service.render(fetched.settings).profiles![0]!.content]) {
      for (const key of flags) expect(content).toContain(`${key} = false`);
      expect(content).toContain('log_sse_deltas = false');
      expect(content).toContain('credentials_store = "file"');
      expect(content).toContain('cyber_access_programs = true');
      expect(content).toContain('[plugins."example.plugin".apps."connector.audit"]');
    }
    const edited = await service.store({ settings: { native_settings: { otel: { log_sse_deltas: true } } }, expected_revision: first.revision });
    expect(edited.content).toContain('log_sse_deltas = true');
    const removed = service.render({ native_settings: {}, profiles: [{ name: 'new', native_settings: {} }] });
    expect(removed.content).not.toMatch(/log_sse_deltas|credentials_store|cyber_access_programs|tui_extensions_statusline|connector\.audit/);
    expect(render(null, {}).content).not.toMatch(/gcp_setup_wizard|log_sse_deltas/);
  });

  const additions = [
    ...flags.map(key => ({ features: { [key]: false } })),
    { otel: { log_sse_deltas: false } },
    { model_providers: { 'audit-gateway': gateway({ gateway_oauth: oauth({ credentials_store: 'keyring' }) }) } },
    { model_providers: { 'audit-gateway': gateway({ gateway_oauth: oauth({ credentials_store: 'file' }) }) } },
    { model_providers: { 'audit-gateway': gateway({ capabilities: { cyber_access_programs: false } }) } },
    { plugins: { 'plugin.with.dots': { apps: {} } } },
    { plugins: { 'example.plugin': { apps: { connector: { enabled: true } } } } },
  ];
  it.each(additions)('gates exact root/profile additions, including false and empty maps: %j', value => {
    for (const settings of [{ native_settings: value }, { profiles: [{ name: 'new', native_settings: value }] }]) {
      expect(() => render('0.166.0', settings)).toThrow(/0\.167\.0.*observed 0\.166\.0.*cdx update/);
      expect(() => render('0.166.9', settings)).toThrow(/0\.167\.0/);
      expect(() => render(null, settings)).toThrow(/0\.167\.0.*unreported/);
      expect(() => render('0.167.0', settings)).not.toThrow();
    }
  });

  it('gates structured feature scopes and leaves opaque names and established fields alone', () => {
    expect(() => render('0.166.0', { features: { interrupt_on_cancel: false } })).toThrow(/0\.167\.0/);
    expect(() => render('0.166.0', { profiles: [{ name: 'new', features: { gcp_setup_wizard: false } }] })).toThrow(/0\.167\.0/);
    expect(() => render('0.162.1', { native_settings: {
      model_providers: { 'log_sse_deltas.credentials_store': { name: 'custom', base_url: 'https://custom.example.test/v1' } },
      plugins: { 'apps.cyber_access_programs': { enabled: false } },
      mcp_servers: { 'otel.log_sse_deltas': { command: '/bin/false' } } } })).not.toThrow();
    // Established 0.165+ provider capabilities and gateway OAuth keep their floor.
    expect(() => render('0.166.0', { native_settings: { model_providers: { 'audit-gateway': gateway({
      gateway_oauth: oauth(), capabilities: { external_web_access: false } }) } } })).not.toThrow();
  });

  it.each([
    ['openai', { capabilities: { cyber_access_programs: true } }],
    ['openai', { model_catalog_url: 'https://chatgpt.com/models', gateway_oauth: oauth({ credentials_store: 'file' }) }],
    ['gcp', { capabilities: { cyber_access_programs: true } }],
    ['gcp', { gateway_oauth: oauth({ credentials_store: 'file' }) }],
    ['amazon-bedrock', { capabilities: { cyber_access_programs: false } }],
    ['amazon-bedrock-runtime', { gateway_oauth: oauth({ credentials_store: 'keyring' }) }],
  ])('still rejects 0.167 provider fields on built-in %s', (id, provider) => {
    expect(() => normalizeCodexNativeSettings({ model_providers: { [id]: provider } })).toThrow(new RegExp(`model_providers\\.${id}`));
  });

  it('rejects invalid gateway credential stores and app settings by schema', () => {
    expect(() => normalizeCodexNativeSettings({ model_providers: { g: gateway({ gateway_oauth: oauth({ credentials_store: 'auto' }) }) } })).toThrow(/credentials_store/);
    expect(() => normalizeCodexNativeSettings({ model_providers: { g: gateway({ capabilities: { cyber_access_programs: 'yes' } }) } })).toThrow(/cyber_access_programs/);
    expect(() => normalizeCodexNativeSettings({ otel: { log_sse_deltas: 'false' } })).toThrow(/log_sse_deltas/);
    expect(() => normalizeCodexNativeSettings({ plugins: { p: { apps: { c: { unknown_field: true } } } } })).toThrow(/unknown_field/);
  });
});

describe('Codex CLI auth credential store ownership', () => {
  it.each(['keyring', 'auto', 'ephemeral'])('rejects wrapper-owned cli_auth_credentials_store = %s at root and profile authoring', async mode => {
    expect(() => normalizeCodexNativeSettings({ cli_auth_credentials_store: mode })).toThrow(/cli_auth_credentials_store is owned by the fleet wrapper.*auth\.json/);
    const service = new ClientConfigService(createDbFake() as never);
    await expect(service.store({ settings: { native_settings: { cli_auth_credentials_store: mode } } }))
      .rejects.toMatchObject({ status: 422 });
    await expect(service.store({ settings: { profiles: [{ name: 'p', native_settings: { cli_auth_credentials_store: mode } }] } }))
      .rejects.toThrow(/profiles\[0\].*cli_auth_credentials_store/);
  });

  it('accepts the native file default and leaves MCP and gateway OAuth stores user-selectable', async () => {
    const native = { cli_auth_credentials_store: 'file', mcp_oauth_credentials_store: 'keyring',
      model_providers: { g: gateway({ gateway_oauth: oauth({ credentials_store: 'keyring' }) }) } };
    const service = new ClientConfigService(createDbFake() as never);
    const stored = await service.store({ settings: { native_settings: native, profiles: [{ name: 'p', native_settings: native }] } });
    expect(stored.content).toContain('cli_auth_credentials_store = "file"');
    expect(stored.content).toContain('mcp_oauth_credentials_store = "keyring"');
  });

  it('heals stored non-file values instead of breaking reads, keeping siblings', () => {
    const healed = normalizeStoredCodexNativeSettings({ cli_auth_credentials_store: 'keyring', mcp_oauth_credentials_store: 'file' });
    expect(healed).toEqual({ mcp_oauth_credentials_store: 'file' });
    const settings = normalizeSettings({ native_settings: { cli_auth_credentials_store: 'auto' },
      profiles: [{ name: 'p', native_settings: { cli_auth_credentials_store: 'ephemeral', otel: { log_sse_deltas: true } } }] });
    expect(settings.native_settings).toEqual({});
    expect(settings.profiles[0]?.native_settings).toEqual({ otel: { log_sse_deltas: true } });
    expect(normalizeStoredCodexNativeSettings({ cli_auth_credentials_store: 'file' })).toEqual({ cli_auth_credentials_store: 'file' });
  });

  it('keeps a previously saved keyring document readable by the admin and host render paths', async () => {
    const native = { cli_auth_credentials_store: 'keyring', mcp_oauth_credentials_store: 'file' };
    const settings = { native_settings: native, profiles: [{ name: 'p', native_settings: native }] };
    const row = { id: 1, engine: 'codex', settings, body: '# historical body', sha256: createHash('sha256').update('# historical body').digest('hex'),
      createdAt: '2026-11-01T00:00:00Z', updatedAt: '2026-11-01T00:00:00Z' };
    const db = createDbFake(new Map([[clientConfigDocuments, [row]]]));
    const configs = new ClientConfigService(db as never);
    const fetched = await configs.adminFetch();
    expect(fetched.validation_error).toBeUndefined();
    expect(db.tables.get(clientConfigDocuments)).toEqual([row]);
    for (const scope of [fetched.settings!, fetched.settings!.profiles[0]!]) {
      expect(scope.native_settings).toEqual({ mcp_oauth_credentials_store: 'file' });
    }
    const rendered = configs.render(fetched.settings);
    const host = render('0.162.1', settings);
    for (const content of [rendered.content, rendered.profiles![0]!.content, host.content, host.profiles![0]!.content]) {
      expect(content).not.toContain('cli_auth_credentials_store');
      expect(content).toContain('mcp_oauth_credentials_store = "file"');
    }
    const saved = await configs.store({ settings: fetched.settings, expected_revision: fetched.revision });
    expect(saved.change).toBe('updated');
  });
});

describe('Codex 0.167 native parser probe', () => {
  it.skipIf(!process.env.CODEX_NATIVE_TEST_BIN)('parses representative rendered root and profile through native 0.167 without reading auth', () => {
    const home = mkdtempSync(join(tmpdir(), 'codex-167-parser-'));
    const env = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: join(home, 'home'), CODEX_HOME: home };
    mkdirSync(env.HOME);
    try {
      const native = { ...all(), cli_auth_credentials_store: 'file' };
      const result = new ClientConfigService({} as never).render({ native_settings: native, profiles: [{ name: 'new', native_settings: native }] });
      for (const content of [result.content, result.profiles![0]!.content]) {
        writeFileSync(join(home, 'config.toml'), content);
        const probe = spawnSync(process.env.CODEX_NATIVE_TEST_BIN!, ['features', 'list'], { env, encoding: 'utf8', timeout: 15000 });
        expect(probe.error).toBeUndefined();
        expect(probe.status, probe.stderr).toBe(0);
        expect(probe.stderr).not.toMatch(/failed to load|Error loading/);
        for (const key of flags) expect(probe.stdout).toMatch(new RegExp(`^${key}\\s.*false\\s*$`, 'm'));
      }
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
});
