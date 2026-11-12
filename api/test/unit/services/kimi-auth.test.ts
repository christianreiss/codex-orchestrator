import { describe, expect, it } from 'vitest';
import {
  normalizeKimiAuth,
  projectKimiAuth,
  selectKimiCredential,
  kimiDeviceHeaders,
  kimiProjectionMetadata,
} from '../../../src/services/kimi-auth.js';
import { inspectCredential } from '../../../src/services/auth-generation.js';
import { ClientConfigService } from '../../../src/services/client-config.js';
import { modelDefaultsCatalog } from '../../../src/services/model-defaults.js';
import { buildSeedAuthScript } from '../../../src/services/install-token.js';
import { coerceKimiVersionToMinimum, isSupportedKimiVersion } from '../../../src/services/client-versions.js';
import { resolveRequestEngine } from '../../../src/util/engine-resolution.js';
import type { Database } from '../../../src/db/client.js';

const auth = () => ({
  kimi_code: {
    access_token: 'fixture-access-token',
    refresh_token: 'fixture-secret-refresh',
    expires_at: Math.floor(Date.now() / 1000) + 900,
    expires_in: 900,
    scope: 'kimi-code',
    token_type: 'Bearer',
  },
  device_id: '90de1de4-1b37-4a4c-aac2-597d6404285a',
  oauth_host: 'https://auth.kimi.com',
  base_url: 'https://api.kimi.com/coding/v1',
  last_refresh: new Date().toISOString(),
});
describe('Kimi canonical and runtime contracts', () => {
  it('keeps the refresh credential only in canonical storage and pins runtime expiry to zero', () => {
    const canonical = normalizeKimiAuth(auth(), true);
    const projection = projectKimiAuth(canonical);
    expect(projection.kimi_code).toEqual({
      access_token: 'fixture-access-token',
      refresh_token: '',
      expires_at: 0,
      expires_in: 0,
      scope: 'kimi-code',
      token_type: 'Bearer',
    });
    expect(JSON.stringify(projection)).not.toContain('fixture-secret-refresh');
    expect(projection.device_id).toBe(canonical.device_id);
    expect(selectKimiCredential(canonical)?.refresh).toBe('fixture-secret-refresh');
    expect(selectKimiCredential(projection, true)?.access).toBe('fixture-access-token');
    expect(() => normalizeKimiAuth(projection, true)).toThrow();
    expect(inspectCredential(canonical, 'kimi')?.kind).toBe('kimi_oauth');
    expect(kimiProjectionMetadata(canonical)).toMatchObject({
      access_token_digest: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
  });
  it('requires device identity and a refresh token for enrollment and restricts provider origins', () => {
    expect(() => normalizeKimiAuth({ ...auth(), device_id: '' }, true)).toThrow();
    expect(() =>
      normalizeKimiAuth({ ...auth(), kimi_code: { ...auth().kimi_code, refresh_token: '' } }, true),
    ).toThrow();
    expect(() => normalizeKimiAuth({ ...auth(), oauth_host: 'http://127.0.0.1' }, true)).toThrow();
    expect(kimiDeviceHeaders(auth().device_id)).toMatchObject({
      'X-Msh-Platform': 'kimi_code_cli',
      'X-Msh-Device-Id': auth().device_id,
    });
  });
  it('renders native Kimi TOML with owned paths and no Codex settings', () => {
    const rendered = new ClientConfigService({} as Database).render(
      { model: 'k3.1-pro', reasoning_effort: 'max', native_settings: { workspace: { require_trust: true } } },
      'kimi',
    );
    expect(rendered.content).toContain('default_model = "kimi-code/k3.1-pro"');
    expect(rendered.content).toContain('[providers."managed:kimi-code"]');
    expect(rendered.content).toContain('max_context_size = 1048576');
    expect(rendered.content).toContain('telemetry = false');
    expect(rendered.content).not.toMatch(/sandbox_mode|approval_policy|mcp_servers/);
    expect(rendered.owned_paths).toContain('default_model');
    expect(modelDefaultsCatalog('kimi').map((m) => m.model)).toHaveLength(6);
  });
  it('respects each model context ceiling and persists supported window selections', () => {
    const service = new ClientConfigService({} as Database);
    const selected = service.render({ model: 'k3.1-pro', context_window: 262144 }, 'kimi');
    expect(selected.settings.context_window).toBe(262144);
    expect(selected.content).toMatch(/\[models\."kimi-code\/k3\.1-pro"\][\s\S]*?max_context_size = 262144/);
    expect(() => service.render({ model: 'kimi-for-coding', context_window: 1048576 }, 'kimi')).toThrow(
      /context/,
    );
  });
  it('seeds a separate native home, uploads device identity and always erases that login', () => {
    const script = buildSeedAuthScript({
      baseUrl: 'https://fleet.example',
      token: 'seed-fixture',
      engine: 'kimi',
    });
    expect(script).toContain('KIMI_CODE_HOME=private');
    expect(script).toContain("[binary, 'login']");
    expect(script).toContain("'/credentials/kimi-code.json'");
    expect(script).toContain("'device_id': device_id");
    expect(script).toContain('shutil.rmtree(private)');
    expect(script).not.toContain('--device-auth');
  });
  it('enforces the native floor and resolves ckx user agents', () => {
    expect(coerceKimiVersionToMinimum('2.4.0')).toBe('2.5.3');
    expect(isSupportedKimiVersion('2.5.3')).toBe(true);
    expect(isSupportedKimiVersion('2.5.3-beta.1')).toBe(false);
    expect(
      resolveRequestEngine(
        { headers: { 'user-agent': 'ckx/0.9.80' }, query: {} } as never,
        {},
        { legacyUserAgentInference: true },
      ),
    ).toBe('kimi');
  });
});
