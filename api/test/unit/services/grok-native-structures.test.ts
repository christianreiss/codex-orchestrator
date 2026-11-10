import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { clientConfigDocuments } from '../../../src/db/schema.js';
import { ClientConfigService, renderTomlForHost } from '../../../src/services/client-config.js';
import { normalizeGrokNativeSettings, renderGrokNativeToml } from '../../../src/services/grok-native-settings.js';
import { createDbFake } from '../../helpers/db-fake.js';

const setup = {
  fields: [{ id: 'region', label: 'Region', type: 'select', required: false, options: [{ label: 'Europe', value: 'eu' }] }],
  variables: { 'url.with.dot': { from: 'region', map: { eu: 'https://example.invalid/mcp' } } },
};
const s3 = { bucket: 'test-only', endpoint: 'https://example.invalid', region: 'eu-test',
  read_write: { access_key_id: 'fixture-not-a-key', secret_access_key: 'fixture-not-a-secret' } };
const valid = {
  auth_provider: { 'custom.with.dots': { command: '/nonexistent-test-provider', args: [], cwd: '/tmp', token_ttl_secs: 60, timeout_secs: 600 } },
  model_providers: { 'vendor.with.dots': { api_backend: 'responses', base_url: 'https://example.invalid', api_base_url: 'https://example.invalid',
    env_key: ['TEST_KEY', 'OTHER_KEY'], api_key: 'test-only', auth_provider: 'custom.with.dots', auth: { command: '/nonexistent-test-provider' },
    extra_headers: { 'X.Team': 'kept' }, query_params: { 'api.version': 'v1' }, env_http_headers: { 'X.Key': 'TEST_KEY' },
    context_window: 0, context_windows: [100000, 200000], max_request_bytes: 1 } },
  marketplace: { sources: [{ name: 'Fixture', path: '/nonexistent-marketplace', git: 'https://example.invalid/source', branch: 'main' }] },
  model: { 'custom.with.dots': { context_window: 100000, context_windows: [100000, 200000],
    reasoning_efforts: ['low', { value: 'xhigh', id: 'deep', label: 'Deep', description: 'Fixture', default: true }] } },
  mcp_servers: { 'mcp.with.dots': { command: '/nonexistent-test-mcp', setup } },
  tools: { zdr_video_output_s3: { ...s3, expires_secs: 480, key_prefix: '', read_only: { access_key_id: '', secret_access_key: '' } } },
  worktree: { auto_gc: { enabled: false, dry_run: false, include_orphan_snapshots: false, include_rebuild: false,
    max_age_secs: 3600, min_interval_secs: 60, rebuild_min_interval_secs: 604800,
    max_age_by_kind: { session: 3600, ab: '7200', pool: '+7200', fork: 7776000, manual: 'NEVER', subagent: 'never' } } },
};
function inputAt(path: string[], value: unknown): Record<string, unknown> {
  return path.reduceRight<unknown>((child, key) => ({ [key]: child }), value) as Record<string, unknown>;
}

const invalid: Array<[string[], unknown, string?]> = [
  [['auth_provider', 'named'], {}, 'command'],
  [['auth_provider', 'named'], { command: '   ' }, 'command'],
  [['auth_provider', 'named'], { command: 5 }, 'command'],
  [['auth_provider', 'named'], { command: 'false', args: [1] }, 'args.0'],
  [['auth_provider', 'named'], { command: 'false', cwd: 1 }, 'cwd'],
  ...[-1, 0, 601, 1.5, '30'].map(value => [['auth_provider', 'named'], { command: 'false', timeout_secs: value }, 'timeout_secs'] as [string[], unknown, string]),
  ...[-1, 1.5, Number.MAX_SAFE_INTEGER + 1, '30'].map(value => [['auth_provider', 'named'], { command: 'false', token_ttl_secs: value }, 'token_ttl_secs'] as [string[], unknown, string]),
  [['auth_provider', 'named'], { command: 'false', typo: true }, 'typo'],
  [['model_providers', 'vendor'], { base_url: 5 }, 'base_url'],
  [['model_providers', 'vendor'], { env_key: [1] }, 'env_key.0'],
  [['model_providers', 'vendor'], { api_backend: 'unknown' }, 'api_backend'],
  [['model_providers', 'vendor'], { api_backend: ['messages'] }, 'api_backend'],
  [['model_providers', 'vendor'], { extra_headers: { 'X.Dot': 1 } }, 'extra_headers.X.Dot'],
  [['model_providers', 'vendor'], { query_params: [] }, 'query_params'],
  [['model_providers', 'vendor'], { env_http_headers: { test: true } }, 'env_http_headers.test'],
  [['model_providers', 'vendor'], { auth: { command: '' } }, 'auth.command'],
  [['model_providers', 'vendor'], { context_window: -1 }, 'context_window'],
  [['model_providers', 'vendor'], { context_windows: [0] }, 'context_windows.0'],
  [['model_providers', 'vendor'], { max_request_bytes: 0 }, 'max_request_bytes'],
  [['model_providers', 'vendor'], { typo: true }, 'typo'],
  [['marketplace', 'sources'], [{ path: '/tmp' }], '0.name'],
  [['marketplace', 'sources'], [{ name: 123, path: '/tmp' }], '0.name'],
  [['marketplace', 'sources'], [{ name: 'bad' }], '0'],
  [['marketplace', 'sources'], [{ name: 'bad', path: 1 }], '0.path'],
  [['marketplace', 'sources'], [{ name: 'bad', path: '/tmp', branch: false }], '0.branch'],
  [['marketplace', 'sources'], [{ name: 'bad', path: '/tmp', typo: true }], '0.typo'],
  [['model', 'custom', 'reasoning_efforts'], ['ultra'], '0'],
  [['model', 'custom', 'reasoning_efforts'], [' low '], '0'],
  [['model', 'custom', 'reasoning_efforts'], [{}], '0.value'],
  [['model', 'custom', 'reasoning_efforts'], [{ value: 'low', default: 'true' }], '0.default'],
  [['model', 'custom', 'reasoning_efforts'], [{ value: 'low', label: 3 }], '0.label'],
  [['model', 'custom', 'reasoning_efforts'], [{ value: 'low', typo: true }], '0.typo'],
  [['model', 'custom', 'context_windows'], [0]],
  [['model', 'custom', 'context_windows'], [-1]],
  [['model', 'custom', 'context_windows'], [1.5]],
  [['mcp_servers', 'named'], { command: 'false', setup: {} }, 'setup.fields'],
  [['mcp_servers', 'named'], { command: 'false', setup: { fields: 'bad' } }, 'setup.fields'],
  [['mcp_servers', 'named'], { command: 'false', setup: { ...setup, fields: [...setup.fields, ...setup.fields] } }, 'setup.fields'],
  [['mcp_servers', 'named'], { command: 'false', setup: { fields: [{ id: 'r', label: 'R', type: 'text' }] } }, 'setup.fields.0.type'],
  [['mcp_servers', 'named'], { command: 'false', setup: { fields: [{ id: 'r', label: 'R', type: 'select' }] } }, 'setup.fields.0.options'],
  [['mcp_servers', 'named'], { command: 'false', setup: { ...setup, variables: { x: { from: 'other', map: {} } } } }, 'setup.variables.x.from'],
  [['mcp_servers', 'named'], { command: 'false', setup: { ...setup, variables: { x: { from: 'region', map: { eu: 1 } } } } }, 'setup.variables.x.map.eu'],
  [['mcp_servers', 'named'], { command: 'false', setup: { ...setup, values: {} } }, 'setup.values'],
  [['mcp_servers', 'named'], { command: 'false', setup: { ...setup, typo: true } }, 'setup.typo'],
  [['tools', 'zdr_video_output_s3'], {}, 'bucket'],
  [['tools', 'zdr_video_output_s3'], { ...s3, bucket: 5 }, 'bucket'],
  [['tools', 'zdr_video_output_s3'], { ...s3, endpoint: ' ' }, 'endpoint'],
  [['tools', 'zdr_video_output_s3'], { ...s3, read_write: {} }, 'read_write.access_key_id'],
  [['tools', 'zdr_video_output_s3'], { ...s3, read_only: {} }, 'read_only.access_key_id'],
  [['tools', 'zdr_video_output_s3'], { ...s3, expires_secs: 479 }, 'expires_secs'],
  [['tools', 'zdr_video_output_s3'], { ...s3, typo: true }, 'typo'],
  [['worktree', 'auto_gc'], { enabled: 'bad' }, 'enabled'],
  [['worktree', 'auto_gc'], { max_age_secs: 3599 }, 'max_age_secs'],
  [['worktree', 'auto_gc'], { max_age_secs: 7776001 }, 'max_age_secs'],
  [['worktree', 'auto_gc'], { min_interval_secs: 59 }, 'min_interval_secs'],
  [['worktree', 'auto_gc'], { rebuild_min_interval_secs: 604801 }, 'rebuild_min_interval_secs'],
  [['worktree', 'auto_gc'], { max_age_by_kind: { typo: 'never' } }, 'max_age_by_kind.typo'],
  [['worktree', 'auto_gc'], { max_age_by_kind: { session: 'bad' } }, 'max_age_by_kind.session'],
  [['worktree', 'auto_gc'], { max_age_by_kind: { session: ' never ' } }, 'max_age_by_kind.session'],
  [['worktree', 'auto_gc'], { max_age_by_kind: { session: 1 } }, 'max_age_by_kind.session'],
  [['worktree', 'auto_gc'], { typo: true }, 'typo'],
];

describe('Grok fixed nested user structures', () => {
  it.each(invalid)('rejects invalid structure %# before render/store with its exact field and layer index', async (path, value, leaf) => {
    const native = inputAt(path, value), db = createDbFake(), configs = new ClientConfigService(db as never);
    const dotted = [...path, ...(leaf?.split('.') ?? [])].join('.');
    for (const layered of [false, true]) {
      const native_settings = layered ? { version_overrides: [{ minimum_version: '1.0.77', ...native }] } : native;
      const prefix = layered ? 'version_overrides.0.' : '';
      expect(() => configs.render({ native_settings }, 'grok')).toThrow(`native_settings.${prefix}${dotted}`);
      await expect(configs.store({ settings: { native_settings } }, null, 'grok')).rejects.toMatchObject({ status: 422 });
      expect(db.tables.get(clientConfigDocuments)).toBeUndefined();
    }
  });

  it('preserves every fixed shape, native empty values, aliases, mixed effort entries and dotted names', () => {
    expect(normalizeGrokNativeSettings(valid)).toEqual(valid);
    expect(normalizeGrokNativeSettings({})).toEqual({});
    expect(normalizeGrokNativeSettings({ model_providers: { inherited: {} } })).toEqual({ model_providers: { inherited: {} } });
    const { variables, ...rest } = setup;
    const aliased = { mcp_servers: { docs: { command: 'false', setup: { ...rest, values: variables } } } };
    expect(normalizeGrokNativeSettings(aliased)).toEqual(aliased);
    for (const effort of ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']) {
      const input = { model: { custom: { reasoning_efforts: [effort, { value: effort }, effort.toUpperCase(), { value: effort.toUpperCase() }] } } };
      expect(normalizeGrokNativeSettings(input)).toEqual(input);
    }
    for (const ttl of [0, 1, 60, Number.MAX_SAFE_INTEGER]) {
      const input = { auth_provider: { named: { command: 'false', token_ttl_secs: ttl } } };
      expect(normalizeGrokNativeSettings(input)).toEqual(input);
    }
    const kinds = { worktree: { auto_gc: { max_age_by_kind: { ' MANUAL ': 'NEVER', Subagent: 3600 } } } };
    expect(normalizeGrokNativeSettings(kinds)).toEqual(kinds);
  });

  it('keeps permitted conditional structures but preserves model/MCP scope rejection', () => {
    const { model: _model, mcp_servers: _mcp, ...conditional } = valid;
    const layered = { version_overrides: [{ maximum_version: '1.0.77', ...conditional }] };
    expect(normalizeGrokNativeSettings(layered)).toEqual(layered);
    for (const native of [{ model: valid.model }, { mcp_servers: valid.mcp_servers }]) {
      expect(() => normalizeGrokNativeSettings({ version_overrides: [native] })).toThrow('belong in the unconditional native settings');
    }
  });

  it('roundtrips add/edit/removal, retaining exact ownership and rejecting stale revisions', async () => {
    const db = createDbFake(), configs = new ClientConfigService(db as never);
    let revision: string | null = null;
    for (const native_settings of [valid, { ...valid, model: { 'custom.with.dots': { reasoning_efforts: ['high'], context_windows: [100000] } } }, {}]) {
      const saved = await configs.store({ settings: { native_settings }, expected_revision: revision }, null, 'grok');
      revision = saved.revision;
      db.tables.get(clientConfigDocuments)!.sort((a, b) => Number(b.id) - Number(a.id));
      const fetched = await configs.adminFetch('grok');
      expect(fetched.settings?.native_settings ?? {}).toEqual(native_settings);
      const rendered = renderTomlForHost({ engine: 'grok', settings: fetched.settings,
        host: { grokClientVersion: '1.0.77', grokWrapperVersion: '0.9.172' } as never, baseUrl: null, apiKey: null });
      expect(rendered.content).toBe(saved.content);
      if ('model' in native_settings) {
        expect(rendered.owned_paths).toContain('model.custom.with.dots.context_windows');
        expect(rendered.owned_paths).toContain('json:["model_providers","vendor.with.dots","extra_headers","X.Team"]');
        expect(rendered.owned_paths).toContain('mcp_servers.mcp.with.dots');
        expect(rendered.content).toContain('[mcp_servers."mcp.with.dots".setup]');
      } else expect(rendered.content).not.toContain('custom.with.dots');
      await expect(configs.store({ settings: { native_settings: {} }, expected_revision: null }, null, 'grok')).rejects.toMatchObject({ status: 409 });
    }
  });

  it('exposes invalid historical structures without rewriting the snapshot or dropping its siblings', async () => {
    const settings = { native_settings: { model_providers: { custom: { base_url: 5 } }, ui: { theme: 'kept' } } };
    const body = '# original snapshot\n', sha256 = createHash('sha256').update(body).digest('hex');
    const historical = { id: 1, engine: 'grok', body, sha256, settings };
    const db = createDbFake(new Map([[clientConfigDocuments, [historical]]]));
    const configs = new ClientConfigService(db as never), fetched = await configs.adminFetch('grok');
    expect(fetched).toMatchObject({ content: body, sha256, settings,
      validation_error: { param: 'settings.native_settings.model_providers.custom.base_url' } });
    await expect(configs.store({ settings: fetched.settings, expected_revision: fetched.revision }, null, 'grok')).rejects.toMatchObject({ status: 422 });
    expect(historical).toEqual({ id: 1, engine: 'grok', body, sha256, settings });
  });

  it.skipIf(!process.env.GROK_NATIVE_TEST_BIN)('loads the full configuration in native inspect without starting external consumers', () => {
    const home = mkdtempSync(join(tmpdir(), 'grok-fixed-structures-'));
    try {
      const nativeHome = join(home, '.grok'); mkdirSync(nativeHome);
      // Avoid intentionally warning-only combinations in the full roundtrip fixture.
      const probe = { ...valid, permission: { rules: [{ action: 'deny', tool: 'bash' }] },
        auth_provider: { named: { command: '/nonexistent-test-provider', timeout_secs: 30, token_ttl_secs: 300 } },
        model_providers: { vendor: { base_url: 'https://example.invalid', api_backend: 'responses', context_windows: [100000, 200000] } } };
      writeFileSync(join(nativeHome, 'config.toml'), renderGrokNativeToml(normalizeGrokNativeSettings(probe)!));
      const result = spawnSync(process.env.GROK_NATIVE_TEST_BIN!, ['inspect', '--json'], {
        cwd: home, env: { ...process.env, HOME: home, GROK_HOME: nativeHome, GROK_DISABLE_AUTOUPDATER: '1' }, encoding: 'utf8', timeout: 20000,
      });
      expect(result.error).toBeUndefined(); expect(result.status, result.stderr).toBe(0);
      const report = JSON.parse(result.stdout);
      expect(report.permissions).toMatchObject({ loaded: 1, skipped: [] });
      expect(result.stdout).not.toMatch(/failed to parse|expected a nonzero u64|invalid type/);
      expect(result.stderr).not.toMatch(/failed to parse|expected a nonzero u64|invalid type/);
      // JSON inspect omits model/provider warnings; the human report exposes
      // actual consumer skips. A negative control proves we inspect that path.
      const inspect = () => spawnSync(process.env.GROK_NATIVE_TEST_BIN!, ['inspect'], {
        cwd: home, env: { ...process.env, HOME: home, GROK_HOME: nativeHome, GROK_DISABLE_AUTOUPDATER: '1' }, encoding: 'utf8', timeout: 20000,
      });
      const accepted = inspect();
      expect(accepted.status, accepted.stderr).toBe(0);
      expect(accepted.stdout + accepted.stderr).not.toContain('Config Warnings');
      writeFileSync(join(nativeHome, 'config.toml'), renderGrokNativeToml({ model: { custom: { context_windows: [0], reasoning_efforts: [{ value: 'ultra' }] } } }));
      const rejected = inspect();
      expect(rejected.status, rejected.stderr).toBe(0);
      expect(rejected.stdout + rejected.stderr).toContain('Config Warnings');
      expect(rejected.stdout + rejected.stderr).toContain('context_windows');
      expect(rejected.stdout + rejected.stderr).toMatch(/reasoning_efforts|RawReasoningEffortOption/);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
});
