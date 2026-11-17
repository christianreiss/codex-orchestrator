import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ClientConfigService, renderTomlForHost } from '../../../src/services/client-config.js';
import { grokNativeOwnedPaths, normalizeGrokNativeSettings, renderGrokNativeToml } from '../../../src/services/grok-native-settings.js';
import { assertNativeConfigSupport } from '../../../src/services/native-config-support.js';
import { clientConfigDocuments } from '../../../src/db/schema.js';
import { createDbFake } from '../../helpers/db-fake.js';

const features = { ask_local_reads: false, auto_review_protected_paths: false, fail_silent_opens: false,
  history_tree: false, inline_code_copy: false, inline_turn_status: false, leader_read_close: false,
  link_url_hiding: false, load_rows_from_parent: false, model_list_refresh: false, overdue_reattach: false,
  paged_full_load: false, pending_steer: false, resume_refusals: false };
const additions = {
  env: { AUDIT_LITERAL: '$NOT_EXPANDED', 'audit.with.dot': 'literal' }, features,
  model: { 'custom.with.dot': { prompt_harness: 'latest', supports_tool_schema_const: false,
    supports_tool_schema_root_union: false, supports_tool_schema_untyped_union: false } },
  mcp_servers: { 'docs.with.dot': { url: 'https://example.invalid/mcp', headers_helper: '/nonexistent-header-helper' } },
  telemetry: { otel_shutdown_timeout: 1250 },
  ui: { copy_inline_code_backticks: false, debug_panels: ['tps', 'fps', 'scroll'], inline_turn_status: false,
    link_urls: 'show', timestamp_format: '24h', turn_token_count: false },
};
const at = (path: string[], value: unknown): Record<string, unknown> => path.reduceRight<unknown>((child, key) => ({ [key]: child }), value) as Record<string, unknown>;
const check = (version: string | null, native_settings: unknown) => assertNativeConfigSupport({ native_settings }, { grokClientVersion: version } as never, 'grok');

describe('Grok 1.0.88 user defaults', () => {
  it('roundtrips preview/store/read/edit/removal with exact ownership and stale-revision protection', async () => {
    const db = createDbFake(), configs = new ClientConfigService(db as never);
    let revision: string | null = null;
    for (const native_settings of [additions, { ...additions, env: { AUDIT_LITERAL: 'changed' }, ui: { ...additions.ui, debug_panels: [], timestamp_format: '12h' } }, {}]) {
      const preview = configs.render({ native_settings }, 'grok');
      const saved = await configs.store({ settings: { native_settings }, expected_revision: revision }, null, 'grok');
      const previous = revision; revision = saved.revision;
      db.tables.get(clientConfigDocuments)!.sort((a, b) => Number(b.id) - Number(a.id));
      const fetched = await configs.adminFetch('grok');
      expect(fetched.settings?.native_settings ?? {}).toEqual(native_settings);
      const rendered = renderTomlForHost({ engine: 'grok', settings: fetched.settings,
        host: { grokClientVersion: '1.0.88', grokWrapperVersion: '0.9.181' } as never, baseUrl: null, apiKey: null });
      expect(rendered.content).toBe(saved.content); expect(preview.content).toBe(saved.content);
      if ('env' in native_settings) {
        expect(rendered.content).toContain('[env]');
        expect(rendered.owned_paths).toEqual(expect.arrayContaining(['env.AUDIT_LITERAL', 'model.custom.with.dot.supports_tool_schema_const', 'mcp_servers.docs.with.dot']));
        await expect(configs.store({ settings: { native_settings: {} }, expected_revision: previous }, null, 'grok')).rejects.toMatchObject({ status: 409 });
      } else {
        expect(rendered.content).not.toContain('timestamp_format'); expect(rendered.owned_paths).not.toContain('env.AUDIT_LITERAL');
      }
    }
  });
  it('keeps omitted defaults absent, variable expansion off and dotted keys literal', () => {
    expect(normalizeGrokNativeSettings({})).toEqual({}); expect(normalizeGrokNativeSettings(additions)).toEqual(additions);
    expect(renderGrokNativeToml(additions)).toContain('AUDIT_LITERAL = "$NOT_EXPANDED"');
    expect(grokNativeOwnedPaths(additions)).toContain('json:["env","audit.with.dot"]');
  });
  it.each([
    [at(['env', 'AUDIT'], 3), 'env.AUDIT: expected string'],
    [at(['features', 'pending_steer'], 'true'), 'pending_steer: expected boolean'],
    [at(['ui', 'debug_panels'], ['unknown']), 'debug_panels.0: expected tps, fps or scroll'],
    [at(['ui', 'debug_panels'], [3]), 'debug_panels: expected string[]'],
    [at(['ui', 'timestamp_format'], 'iso'), 'timestamp_format: expected =12h or =24h'],
    [at(['ui', 'link_urls'], 'hide'), 'link_urls: expected =auto or =show'],
    [at(['telemetry', 'otel_shutdown_timeout'], -1), 'otel_shutdown_timeout: expected 0'],
    [at(['model', 'custom.dot', 'supports_tool_schema_const'], 'false'), 'supports_tool_schema_const: expected boolean'],
    [{ mcp_servers: { docs: { url: 'https://example.invalid', headers_helper: [] } } }, 'headers_helper: expected string'],
    [{ mcp_servers: { docs: { command: 'false', headers_helper: 'false' } } }, 'stdio does not consume headers_helper'],
    [{ mcp_servers: { docs: { url: 'https://example.invalid', headersHelper: 'false' } } }, 'use headers_helper'],
  ])('rejects incorrect types/enums and ineffective spellings before storage %#', async (native_settings, error) => {
    expect(() => normalizeGrokNativeSettings(native_settings)).toThrow(error);
    const db = createDbFake(), configs = new ClientConfigService(db as never);
    await expect(configs.store({ settings: { native_settings } }, null, 'grok')).rejects.toMatchObject({ status: 422 });
    expect(db.tables.get(clientConfigDocuments)).toBeUndefined();
  });
  it.each(['shared_daemon', 'cloud_agents', 'cursor_relay_login', 'sign_in_chooser', 'unified_session_import', 'unify_ask', 'idle_root_unload', 'proc_protection'])('explains unintegrated lifecycle for %s in root and conditional layers', feature => {
    for (const value of [false, true]) for (const conditional of [false, true]) {
      const input = { features: { [feature]: value } };
      expect(() => normalizeGrokNativeSettings(conditional ? { version_overrides: [input] } : input)).toThrow(`native_settings.features.${feature}`);
    }
  });
  it('explains native-only artifact selection and per-machine state', () => {
    expect(() => normalizeGrokNativeSettings({ cli: { artifact_base: 'https://example.invalid' } })).toThrow('managed_config.toml/requirements.toml only');
    expect(() => normalizeGrokNativeSettings({ hints: { api_key_models_note_seen: false } })).toThrow('native per-machine');
  });
});
describe('Grok 1.0.88 conservative capability floor', () => {
  const candidates = [{ env: {} }, ...Object.entries(features).map(([key, value]) => at(['features', key], value)),
    ...Object.entries(additions.ui).map(([key, value]) => at(['ui', key], value)), { ui: { debug_panels: [] } },
    ...Object.entries(additions.model['custom.with.dot']).map(([key, value]) => at(['model', 'custom.with.dot', key], value)),
    { mcp_servers: additions.mcp_servers }, { telemetry: additions.telemetry }];
  it.each(candidates)('requires 1.0.88 for authored values including false and empty values %#', native => {
    expect(() => check('1.0.87', native)).toThrow('CLI 1.0.88 or newer');
    expect(() => check(null, native)).toThrow('observed unreported');
    expect(() => check('grok 1.0.88 (2fe3608f7398)', native)).not.toThrow();
  });
  it('does not gate dotted map names and skips inactive conditional layers', () => {
    expect(() => check('1.0.50', { model: { 'ui.timestamp_format': { description: 'features.pending_steer' } }, mcp_servers: { 'env.example': { command: 'false' } } })).not.toThrow();
    expect(() => check('1.0.77', { version_overrides: [{ minimum_version: '1.0.88', ui: { timestamp_format: '24h' } }] })).not.toThrow();
    expect(() => check('1.0.87', { version_overrides: [{ maximum_version: '1.0.87', ui: { timestamp_format: '24h' } }] })).toThrow('CLI 1.0.88');
    expect(() => check('1.0.88', { version_overrides: [{ maximum_version: '1.0.87', ui: { timestamp_format: '24h' } }] })).not.toThrow();
  });
});
it.skipIf(!process.env.GROK_NATIVE_TEST_BIN)('native inspect accepts new fields without running configured helpers and detects unknown-key control', () => {
  const home = mkdtempSync(join(tmpdir(), 'grok-188-'));
  try {
    const nativeHome = join(home, '.grok'); mkdirSync(nativeHome); const marker = join(home, 'helper-executed');
    const fixture = { ...additions, mcp_servers: { docs: { url: 'https://example.invalid/mcp', headers_helper: `touch ${marker}` } } };
    const inspect = () => spawnSync(process.env.GROK_NATIVE_TEST_BIN!, ['inspect'], {
      cwd: home, env: { PATH: process.env.PATH, HOME: home, GROK_HOME: nativeHome, GROK_DISABLE_AUTOUPDATER: '1', TERM: 'dumb' }, encoding: 'utf8', timeout: 20000,
    });
    writeFileSync(join(nativeHome, 'config.toml'), renderGrokNativeToml(normalizeGrokNativeSettings(fixture)!));
    const accepted = inspect(); expect(accepted.error).toBeUndefined(); expect(accepted.status, accepted.stderr).toBe(0);
    expect(accepted.stdout + accepted.stderr).not.toContain('Config Warnings'); expect(existsSync(marker)).toBe(false);
    writeFileSync(join(nativeHome, 'config.toml'), '[ui]\nnot_a_native_option = true\n');
    const unknown = inspect(); expect(unknown.status, unknown.stderr).toBe(0); expect(unknown.stdout + unknown.stderr).toContain('unrecognized config key');
  } finally { rmSync(home, { recursive: true, force: true }); }
});
