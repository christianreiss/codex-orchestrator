import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { ClientConfigService, renderTomlForHost } from '../../../src/services/client-config.js';
import { normalizeCodexNativeSettings } from '../../../src/services/codex-native-settings.js';
import { createDbFake } from '../../helpers/db-fake.js';

const flags = ['critical_path_timing', 'guardian_native_multi_agent_history', 'mcp_connection_sharing',
  'omit_skill_descriptions', 'plugin_discovery_prefetch', 'simplified_selection_hints', 'skill_catalog_deltas', 'untrusted_as_tool_output'];
const signing = () => ({ placeholder_access_key_id: 'AUDIT_PLACEHOLDER', region: 'us-east-1', service: 's3',
  access_key_id: { env_var: 'AUDIT_PROXY_KEY' }, secret_access_key: { file: '/never-read/secret-key' } });
const body = () => ({ replacements: [{ placeholder: 'AUDIT_OPAQUE_PLACEHOLDER', secret: { env_var: 'AUDIT_PROXY_BODY' } }] });
const mitm = () => ({ version: 2, hooks: { 'exact.hook': { host: 'example.test', methods: ['POST'], path_prefixes: ['/'], action: ['sign', 'body'] } },
  actions: { sign: { aws_sigv4: signing() }, body: { body_secret_substitution: body() } } });
const permissions = (value: unknown) => ({ default_permissions: 'proxy', permissions: { proxy: { network: { mitm: value } } } });
const all = () => ({ features: { ...Object.fromEntries(flags.map(key => [key, false])), rollout_budget: { enforce_limit: false } },
  memories: { consolidation_service_tier: 'priority' }, tui: { keymap: { global: { select_transcript: 'ctrl-s' } } },
  model_providers: { gcp: { project_id: 'audit', location: 'us-central1', credential_file: '/never-read/adc.json' },
    openai: { model_catalog_url: 'https://chatgpt.com/backend-api/codex/models' } }, ...permissions(mitm()) });
const render = (version: string | null, settings: unknown) => renderTomlForHost({ settings,
  host: { clientVersion: version } as never, baseUrl: null, apiKey: null });

describe('Codex 0.166 native configuration', () => {
  it('roundtrips every new field at root and profile, edits and withdraws without changing defaults', async () => {
    const service = new ClientConfigService(createDbFake() as never), native = all();
    const input = { native_settings: native, profiles: [{ name: 'new', native_settings: native }] };
    const first = await service.store({ settings: input });
    const fetched = await service.adminFetch();
    expect(fetched.settings?.native_settings).toEqual(native);
    expect(fetched.settings?.profiles[0]?.native_settings).toEqual(native);
    for (const content of [first.content, service.render(fetched.settings).profiles![0]!.content]) {
      expect(content).toContain('plugin_discovery_prefetch = false');
      expect(content).toContain('enforce_limit = false');
      expect(content).toContain('select_transcript = "ctrl-s"');
      expect(content).toContain('[permissions.proxy.network.mitm.actions.sign.aws_sigv4]');
    }
    const edited = await service.store({ settings: { native_settings: { features: { plugin_discovery_prefetch: true } } }, expected_revision: first.revision });
    expect(edited.content).toContain('plugin_discovery_prefetch = true');
    const removed = service.render({ native_settings: {}, profiles: [{ name: 'new', native_settings: {} }] });
    expect(removed.content).not.toMatch(/plugin_discovery_prefetch|consolidation_service_tier|aws_sigv4|credential_file/);
    expect(render(null, {}).content).not.toMatch(/plugin_discovery_prefetch|enforce_limit/);
  });
  const additions = [
    ...flags.map(key => ({ features: { [key]: false } })),
    { features: { rollout_budget: { enforce_limit: false } } },
    { memories: { consolidation_service_tier: 'priority' } },
    { tui: { keymap: { global: { select_transcript: 'ctrl-s' } } } },
    { model_providers: { gcp: { project_id: '' } } },
    { model_providers: { gcp: { location: '' } } },
    { model_providers: { gcp: { credential_file: '/never-read' } } },
    { model_providers: { openai: { model_catalog_url: 'https://chatgpt.com/models' } } },
    permissions({ ...mitm(), actions: { sign: { aws_sigv4: signing() } }, hooks: { h: { host: 'example.test', methods: ['GET'], path_prefixes: ['/'], action: ['sign'] } } }),
    permissions({ ...mitm(), actions: { body: { body_secret_substitution: body() } }, hooks: { h: { host: 'example.test', methods: ['GET'], path_prefixes: ['/'], action: ['body'] } } }),
  ];
  it.each(additions)('gates exact root/profile additions, including false and empty strings: %j', value => {
    for (const settings of [{ native_settings: value }, { profiles: [{ name: 'new', native_settings: value }] }]) {
      expect(() => render('0.165.0', settings)).toThrow(/0\.166\.0.*observed 0\.165\.0.*cdx update/);
      expect(() => render(null, settings)).toThrow(/0\.166\.0.*unreported/);
      expect(() => render('0.166.0', settings)).not.toThrow();
    }
  });
  it('gates structured feature scopes and leaves opaque names and established fields alone', () => {
    expect(() => render('0.165.0', { features: { plugin_discovery_prefetch: false } })).toThrow(/0\.166\.0/);
    expect(() => render('0.165.0', { profiles: [{ name: 'new', features: { critical_path_timing: false } }] })).toThrow(/0\.166\.0/);
    expect(() => render('0.162.1', { native_settings: { model_providers: { 'project_id.critical_path_timing': { name: 'custom' } },
      mcp_servers: { 'aws_sigv4.select_transcript': { command: '/bin/false' } } } })).not.toThrow();
    expect(() => render('0.165.0', { native_settings: { model_provider: 'gcp' } })).not.toThrow();
  });
  it.each(['https://chatgpt.com/models', 'https://CHAT.OPENAI.COM/models', 'https://foo.chatgpt.com/models', 'https://foo.chatgpt-staging.com:8443/models'])('accepts native first-party catalog routing: %s', url => {
    expect(normalizeCodexNativeSettings({ model_providers: { openai: { model_catalog_url: url } } })).toBeDefined();
  });
  it.each(['http://chatgpt.com/models', 'https://chatgpt.com.evil.test/models', 'https://evilchatgpt.com/models',
    'https://api.openai.com/models', 'https://foo.chat.openai.com/models', 'https://user@chatgpt.com/models', 'https://@chatgpt.com/models', 'https://%63hatgpt.com/models', ' https://chatgpt.com/models', 'relative'])('rejects unsafe native catalog routing without echoing it: %s', url => {
    expect(() => normalizeCodexNativeSettings({ model_providers: { openai: { model_catalog_url: url } } })).toThrow(/model_catalog_url/);
  });
  it('rejects inert OpenAI overrides, preserves custom provider catalogs and validates GCP ADC paths', () => {
    expect(() => normalizeCodexNativeSettings({ model_providers: { openai: { model_catalog_url: 'https://chatgpt.com/models', name: '' } } })).toThrow(/only consumes model_catalog_url/);
    expect(() => normalizeCodexNativeSettings({ model_providers: { gcp: { credential_file: 'relative.json' } } })).toThrow(/credential_file.*absolute/);
    expect(() => normalizeCodexNativeSettings({ model_providers: { custom: { name: 'Google Cloud Vertex AI', credential_file: 'relative.json' } } })).toThrow(/credential_file.*absolute/);
    expect(() => normalizeCodexNativeSettings({ model_providers: { custom: { name: 'Custom', model_catalog_url: 'https://custom.example.test/models' } } })).not.toThrow();
  });
  const invalid: Array<[string, (v: ReturnType<typeof mitm>) => void]> = [
    ['version', v => { delete (v as Partial<typeof v>).version; }],
    ['AWS placeholder', v => { v.actions.sign.aws_sigv4.placeholder_access_key_id = 'bad/value'; }],
    ['region', v => { v.actions.sign.aws_sigv4.region = 'us east'; }],
    ['service', v => { v.actions.sign.aws_sigv4.service = ''; }],
    ['sign port', v => { Object.assign(v.actions.sign.aws_sigv4, { port: 0 }); }],
    ['sign body cap', v => { Object.assign(v.actions.sign.aws_sigv4, { max_body_bytes: 16777217 }); }],
    ['invalid env', v => { v.actions.sign.aws_sigv4.access_key_id.env_var = 'BAD=NAME'; }],
    ['relative secret file', v => { v.actions.sign.aws_sigv4.secret_access_key.file = 'relative'; }],
    ['missing source', v => { Object.assign(v.actions.sign.aws_sigv4, { access_key_id: {} }); }],
    ['two sources', v => { Object.assign(v.actions.sign.aws_sigv4.access_key_id, { file: '/never-read' }); }],
    ['body port', v => { Object.assign(v.actions.body.body_secret_substitution, { port: 0 }); }],
    ['body cap', v => { Object.assign(v.actions.body.body_secret_substitution, { max_body_bytes: 16777217 }); }],
    ['empty body bindings', v => { v.actions.body.body_secret_substitution.replacements = []; }],
    ['too many bindings', v => { v.actions.body.body_secret_substitution.replacements = Array.from({ length: 33 }, (_, i) => ({ placeholder: `OPAQUE_PLACEHOLDER_${i}`, secret: { env_var: 'AUDIT' } })); }],
    ['short marker', v => { v.actions.body.body_secret_substitution.replacements[0]!.placeholder = 'short'; }],
    ['non-ASCII marker', v => { v.actions.body.body_secret_substitution.replacements[0]!.placeholder = 'OPAQUE_PLACEHOLDER_🐈'; }],
    ['overlapping markers', v => { const value = v.actions.body.body_secret_substitution.replacements[0]!; v.actions.body.body_secret_substitution.replacements.push({ placeholder: value.placeholder + '_suffix', secret: { env_var: 'AUDIT' } }); }],
    ['two selected signing operations', v => { v.hooks['exact.hook'].action.push('sign'); }],
    ['two selected body operations', v => { v.hooks['exact.hook'].action.push('body'); }],
  ];
  it.each(invalid)('rejects config-expressible MITM %s at all authoring boundaries', async (_name, mutate) => {
    const value = mitm(); mutate(value);
    const service = new ClientConfigService(createDbFake() as never);
    expect(() => normalizeCodexNativeSettings(permissions(value))).toThrow();
    expect(() => service.render({ profiles: [{ name: 'new', native_settings: permissions(value) }] })).toThrow();
    await expect(service.store({ settings: { native_settings: permissions(value) } })).rejects.toMatchObject({ status: 422 });
  });
  it('retains native zero body budget and unused operation declarations without resolving sources', () => {
    const value = mitm();
    Object.assign(value.actions.sign.aws_sigv4, { max_body_bytes: 0 });
    Object.assign(value.actions.body.body_secret_substitution, { max_body_bytes: 0 });
    expect(() => normalizeCodexNativeSettings(permissions(value))).not.toThrow();
    value.hooks['exact.hook'].action = ['body'];
    value.actions.sign.aws_sigv4.region = '!not-used';
    expect(() => normalizeCodexNativeSettings(permissions(value))).not.toThrow();
  });
  it.skipIf(!process.env.CODEX_NATIVE_TEST_BIN)('parses representative rendered root and profile through native 0.166 without reading auth or proxy secrets', () => {
    const home = mkdtempSync(join(tmpdir(), 'codex-166-parser-'));
    const env = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: join(home, 'home'), CODEX_HOME: home };
    mkdirSync(env.HOME);
    try {
      const result = new ClientConfigService({} as never).render({ native_settings: all(), profiles: [{ name: 'new', native_settings: all() }] });
      for (const content of [result.content, result.profiles![0]!.content]) {
        writeFileSync(join(home, 'config.toml'), content);
        const probe = spawnSync(process.env.CODEX_NATIVE_TEST_BIN!, ['features', 'list'], { env, encoding: 'utf8', timeout: 15000 });
        expect(probe.error).toBeUndefined();
        expect(probe.status, probe.stderr).toBe(0);
        expect(probe.stderr).not.toMatch(/failed to load|Error loading/);
      }
      const inline = (value: unknown): string => typeof value !== 'object' || value === null ? JSON.stringify(value)
        : Array.isArray(value) ? `[${value.map(inline).join(',')}]` : `{${Object.entries(value).map(([key, item]) => `${JSON.stringify(key)}=${inline(item)}`).join(',')}}`;
      for (const [name, mutate] of invalid) {
        const value = mitm(); mutate(value);
        writeFileSync(join(home, 'config.toml'), Object.entries(permissions(value)).map(([key, item]) => `${key}=${inline(item)}`).join('\n'));
        const probe = spawnSync(process.env.CODEX_NATIVE_TEST_BIN!, ['features', 'list'], { env, encoding: 'utf8', timeout: 15000 });
        expect(probe.error).toBeUndefined();
        expect(probe.status, `${name}: ${probe.stderr}`).not.toBe(0);
        expect(probe.stderr).toMatch(/failed to load|Error loading/);
      }
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
});
