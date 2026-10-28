import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { normalizeCodexNativeSettings, validateCodexFeatureDocument } from '../../../src/services/codex-native-settings.js';
import { ClientConfigService, renderTomlForHost } from '../../../src/services/client-config.js';
import { clientConfigDocuments } from '../../../src/db/schema.js';
import { createDbFake } from '../../helpers/db-fake.js';

const native165 = {
  features: { guardianv3: { enabled: false }, guardian_recorded_items: false,
    prediction_preserve_parent_tools: true, tui_multi_backend: false },
  auto_review: { timeout_ms: 0 },
  model_providers: {
    gcp: { base_url: 'https://vertex.example.test/v1', http_headers: { 'X-Example': 'header' } },
    'amazon-bedrock': { base_url: 'https://bedrock.example.test', aws: { profile: 'example', region: 'us-east-1' } },
    'ollama-chat': { name: 'Legacy id', base_url: 'http://localhost:11434/v1' },
  },
};
const render = (version: string | null, settings: unknown) => renderTomlForHost({ settings,
  host: { clientVersion: version } as never, baseUrl: null, apiKey: null });

describe('Codex 0.165 native configuration', () => {
  it('keeps root/profile settings through preview/store/fetch/edit/removal', async () => {
    const db = createDbFake();
    const service = new ClientConfigService(db as never);
    const input = { native_settings: native165, profiles: [{ name: 'review', native_settings: native165 }] };
    const preview = service.render(input);
    const first = await service.store({ settings: input });
    expect(first.content).toBe(preview.content);
    const fetched = await service.adminFetch();
    expect(fetched.settings?.native_settings).toEqual(native165);
    expect(fetched.settings?.profiles[0]?.native_settings).toEqual(native165);
    for (const body of [fetched.content, service.render(fetched.settings).profiles![0]!.content]) {
      expect(body).toContain('[features.guardianv3]');
      expect(body).toContain('timeout_ms = 0');
      expect(body).toContain('[model_providers.gcp]');
      expect(body).toContain('[model_providers.amazon-bedrock.aws]');
    }
    const edited = structuredClone(fetched.settings!);
    edited.native_settings = { features: { guardianv3: true } };
    edited.profiles[0]!.native_settings = {};
    const changed = await service.store({ settings: edited, expected_revision: fetched.revision });
    expect(changed.content).toContain('guardianv3 = true');
    expect(changed.content).not.toMatch(/timeout_ms|model_providers|tui_multi_backend/);
  });

  const fields = [
    ...['guardian_recorded_items', 'prediction_preserve_parent_tools', 'tui_multi_backend', 'guardianv3']
      .map(key => ({ features: { [key]: false } })),
    { features: { guardianv3: { enabled: false } } },
    { features: { guardianv3: {} } },
    { auto_review: { timeout_ms: 0 } },
    { model_provider: 'gcp' },
  ];
  it.each(fields)('requires 0.165 for new fields including empty/false/0: %j', value => {
    for (const input of [{ native_settings: value }, { profiles: [{ name: 'new', native_settings: value }] }]) {
      expect(() => render('0.164.0', input)).toThrow(/0\.165\.0.*observed 0\.164\.0.*cdx update/);
      expect(() => render(null, input)).toThrow(/0\.165\.0.*unreported/);
      expect(() => render('0.165.0', input)).not.toThrow();
    }
  });
  it('gates structured features and the structured gcp provider selection', () => {
    expect(() => render('0.164.0', { features: { tui_multi_backend: false } })).toThrow(/0\.165\.0/);
    expect(() => render('0.164.0', { model_provider: 'gcp' })).toThrow(/0\.165\.0/);
    expect(() => render('0.164.0', { profiles: [{ name: 'vertex', model_provider: 'gcp' }] })).toThrow(/0\.165\.0/);
    expect(() => render('0.165.0', { model_provider: 'gcp' })).not.toThrow();
    expect(() => validateCodexFeatureDocument({ guardianv3: { enabled: true }, tui_multi_backend: null }, 'settings')).not.toThrow();
    expect(() => validateCodexFeatureDocument({ guardianv3: { enabled: true, extra: 1 } }, 'settings')).toThrow(/guardianv3/);
  });
  it('treats provider map names as opaque version paths', () => {
    expect(() => render('0.164.0', { native_settings: { model_providers: { gcp: { base_url: 'https://e.test' } } } })).not.toThrow();
    expect(() => render('0.162.1', { native_settings: { model_provider: 'gcp-custom',
      model_providers: { 'gcp-custom': { name: 'Custom', base_url: 'https://e.test' }, 'features.tui_multi_backend': { name: 'x' } } } })).not.toThrow();
    expect(render(null, {}).content).not.toMatch(/guardianv3|timeout_ms|prediction_preserve_parent_tools/);
  });

  // Each row mirrors a native 0.165.0 config-load result in a disposable CODEX_HOME.
  const rejected: Array<[Record<string, unknown>, RegExp]> = [
    [{ openai: { name: 'x', base_url: 'https://e.test/v1' } }, /model_providers\.openai: built-in provider openai cannot be overridden/],
    [{ openai: { base_url: 'https://e.test/v1' } }, /model_providers\.openai: built-in/],
    [{ openai: {} }, /model_providers\.openai: built-in/],
    [{ ollama: { name: 'x' } }, /model_providers\.ollama: built-in/],
    [{ lmstudio: { base_url: 'http://localhost:1234/v1' } }, /model_providers\.lmstudio: built-in/],
    [{ 'amazon-bedrock': { name: 'x' } }, /model_providers\.amazon-bedrock\.name: the built-in amazon-bedrock provider only supports changing base_url, auth, http_headers, aws\.profile/],
    [{ 'amazon-bedrock-runtime': { name: 'x' } }, /model_providers\.amazon-bedrock-runtime\.name: /],
    [{ 'amazon-bedrock': { env_key: 'X' } }, /amazon-bedrock\.env_key/],
    [{ gcp: { name: 'x', base_url: 'https://e.test', env_key: 'X' } }, /model_providers\.gcp\.name: the built-in gcp provider only supports changing base_url, auth and http_headers/],
    [{ gcp: { wire_api: 'responses', requires_openai_auth: true } }, /model_providers\.gcp\.requires_openai_auth/],
    [{ gcp: { aws: { profile: 'p' } } }, /model_providers\.gcp\.aws: provider aws is only supported for amazon-bedrock/],
    [{ custom: { name: 'x', aws: { region: 'us-east-1' } } }, /model_providers\.custom\.aws: provider aws/],
  ];
  it.each(rejected)('rejects native load errors at root, in profiles and in the final document: %j', (providers, message) => {
    expect(() => normalizeCodexNativeSettings({ model_providers: providers })).toThrow(message);
    const service = new ClientConfigService({} as never);
    expect(() => service.render({ profiles: [{ name: 'p', native_settings: { model_providers: providers } }] })).toThrow(message);
    expect(() => render('0.165.0', { native_settings: { model_providers: providers } })).toThrow(message);
  });
  const accepted: Array<Record<string, unknown>> = [
    { 'ollama-chat': { name: 'x', base_url: 'http://localhost:11434/v1' } },
    { OpenAI: { name: 'x', base_url: 'https://e.test/v1' } },
    { 'openai-custom': { name: 'x', base_url: 'https://e.test/v1', env_key: 'EXAMPLE_KEY' } },
    { 'amazon-bedrock': { base_url: 'https://e.test', aws: { profile: 'p', region: 'us-east-1' } } },
    { 'amazon-bedrock-runtime': { base_url: 'https://e.test', http_headers: { 'X-A': 'b' } } },
    { gcp: { base_url: 'https://e.test' } },
    { gcp: { http_headers: { 'X-A': 'b' } } },
    { gcp: { auth: { command: '/bin/echo' } } },
    { gcp: {} },
    { gcp: { name: '', wire_api: 'responses', requires_openai_auth: false, supports_websockets: false, supports_standalone_web_search: false } },
  ];
  it.each(accepted)('accepts natively loadable provider entries: %j', providers => {
    expect(normalizeCodexNativeSettings({ model_providers: providers })?.model_providers).toEqual(providers);
  });
  it('never echoes provider values in errors', () => {
    try {
      normalizeCodexNativeSettings({ model_providers: { gcp: { experimental_bearer_token: 'never-echo-this-token' } } });
      expect.unreachable();
    } catch (error) {
      expect(String(error)).toMatch(/gcp\.experimental_bearer_token/);
      expect(String(error)).not.toContain('never-echo-this-token');
    }
  });

  it('keeps a stored reserved override readable and strict until corrected', async () => {
    const settings = { native_settings: { model_providers: { openai: { base_url: 'https://private.example.test/v1' } } } };
    const body = '# historical saved snapshot\n';
    const sha256 = createHash('sha256').update(body).digest('hex');
    const row = { id: 1, engine: 'codex', body, sha256, settings, createdAt: '2026-10-28T00:00:00Z', updatedAt: '2026-10-28T00:00:00Z' };
    const db = createDbFake(new Map([[clientConfigDocuments, [structuredClone(row)]]]));
    const service = new ClientConfigService(db as never);
    const fetched = await service.adminFetch('codex');
    expect(fetched).toMatchObject({ status: 'ok', revision: '1', settings,
      validation_error: { code: 'validation_failed', param: 'native_settings.model_providers.openai' } });
    expect(fetched.validation_error?.message).not.toContain('private.example.test');
    expect(() => render('0.165.0', fetched.settings)).toThrow(/model_providers\.openai/);
    expect(db.tables.get(clientConfigDocuments)).toEqual([row]);
    const corrected = { native_settings: { model_providers: { 'openai-custom': { name: 'Custom', base_url: 'https://private.example.test/v1' } } } };
    const saved = await service.store({ settings: corrected, expected_revision: '1', sha256 }, null, 'codex');
    expect(saved.change).toBe('updated');
    expect(saved.content).toContain('[model_providers.openai-custom]');
  });

  it.skipIf(!process.env.CODEX_NATIVE_TEST_BIN)('parses rendered root and profile with native 0.165 without a session', () => {
    const result = new ClientConfigService({} as never).render({ native_settings: { ...native165, model_provider: 'gcp' },
      profiles: [{ name: 'native', native_settings: native165 }] });
    const home = mkdtempSync(join(tmpdir(), 'codex-165-parser-'));
    const env = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: join(home, 'home'), CODEX_HOME: home };
    mkdirSync(env.HOME);
    try {
      writeFileSync(join(home, 'config.toml'), result.content);
      writeFileSync(join(home, 'native.config.toml'), result.profiles![0]!.content);
      for (const args of [['features', 'list'], ['--profile', 'native', 'mcp', 'list']]) {
        const probe = spawnSync(process.env.CODEX_NATIVE_TEST_BIN!, args, { env, encoding: 'utf8', timeout: 15000 });
        expect(probe.error).toBeUndefined();
        expect(probe.status, probe.stderr).toBe(0);
        expect(probe.stderr).not.toMatch(/Error loading configuration|failed to load/);
      }
      const features = spawnSync(process.env.CODEX_NATIVE_TEST_BIN!, ['features', 'list'], { env, encoding: 'utf8', timeout: 15000 }).stdout;
      expect(features).toMatch(/^prediction_preserve_parent_tools\s+stable\s+true$/m);
      expect(features).toMatch(/^guardianv3\s+under development\s+false$/m);
      // Contrast: the native loader refuses the shapes the validator rejects.
      writeFileSync(join(home, 'config.toml'), '[model_providers.openai]\nbase_url = "https://e.test/v1"\n');
      const refused = spawnSync(process.env.CODEX_NATIVE_TEST_BIN!, ['features', 'list'], { env, encoding: 'utf8', timeout: 15000 });
      expect(refused.status).not.toBe(0);
      expect(refused.stderr).toContain('reserved built-in provider IDs');
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
});
