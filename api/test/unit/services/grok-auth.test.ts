import { describe, expect, it } from 'vitest';
import { GROK_AUTH_SCOPE, GROK_OIDC_ISSUER, grokProjectionMetadata, normalizeGrokAuth, projectGrokAuth, selectGrokCredential } from '../../../src/services/grok-auth.js';
import { ClientConfigService, renderTomlForHost } from '../../../src/services/client-config.js';
import { modelDefaultsCatalog } from '../../../src/services/model-defaults.js';
import { presetLevels } from '../../../src/services/agent-security-levels.js';
import type { Database } from '../../../src/db/client.js';
import { createCanonicalAuthStoreService } from '../../../src/services/canonical-auth-store.js';
import { createRunnerValidationService } from '../../../src/services/runner-validation.js';
import { createDbFake } from '../../helpers/db-fake.js';
import { testKeyring } from '../../helpers/test-keyring.js';
import type { RunnerClient } from '../../../src/services/runner-client.js';

const native = () => ({
  [GROK_AUTH_SCOPE]: { auth_mode: 'oidc', key: 'fixture-access-token-123456789012345', refresh_token: 'fixture-refresh-token', create_time: '2026-10-01T00:00:00Z', expires_at: '2026-10-02T00:00:00Z', user_id: 'fixture-user', email: 'fixture@example.test', extra: { retained: true } },
  'https://other.example::another': { auth_mode: 'oidc', key: 'other-access', refresh_token: 'other-refresh', custom: 7 },
});

describe('Grok canonical and runtime contracts', () => {
  it('projects verification-cache results even when an internal caller supplied the canonical refresh credential', async () => {
    const db = createDbFake() as unknown as Database;
    const keyring = testKeyring();
    const runner = { isConfigured: () => true } as RunnerClient;
    const store = createCanonicalAuthStoreService({ db, keyring, runner, runnerValidation: createRunnerValidationService({ db, keyring }) }, 1);
    const input = { engine: 'grok' as const, accountId: 1, hostId: null, row: { id: 1, accountId: 1, verificationState: 'verified', verificationCheckedAt: new Date().toISOString(), verificationReason: null }, auth: normalizeGrokAuth(native(), true), digest: 'a'.repeat(64), lastRefresh: '2026-10-01T00:00:00Z', ttlSeconds: 900 };
    for (const result of [store.servedVerificationSnapshot(input), await store.ensureServedVerification(input)]) {
      expect(result.state).toBe('verified');
      expect(JSON.stringify(result.auth)).not.toContain('refresh_token');
      expect(selectGrokCredential(result.auth, true)?.native.auth_mode).toBe('external');
    }
  });
  it('wraps a native scope map and preserves unknown canonical fields', () => {
    const canonical = normalizeGrokAuth(native(), true);
    expect(canonical.grok_auth).toEqual(native());
    expect(canonical.grok_scope).toBe(GROK_AUTH_SCOPE);
    expect(canonical.last_refresh).toBe('2026-10-01T00:00:00Z');
    expect(selectGrokCredential(canonical)?.refresh).toBe('fixture-refresh-token');
  });
  it('removes every refresh credential and unselected bearer from runtime output without mutating canonical', () => {
    const canonical = normalizeGrokAuth(native(), true);
    const projection = projectGrokAuth(canonical);
    const map = projection.grok_auth as Record<string, Record<string, unknown>>;
    expect(map[GROK_AUTH_SCOPE]).toMatchObject({ auth_mode: 'external', oidc_issuer: GROK_OIDC_ISSUER, extra: { retained: true } });
    expect(JSON.stringify(projection)).not.toContain('refresh_token');
    expect(JSON.stringify(projection)).not.toContain('other-access');
    expect(selectGrokCredential(canonical)?.refresh).toBe('fixture-refresh-token');
    expect(grokProjectionMetadata(projection)).toMatchObject({ access_token_digest: expect.stringMatching(/^[a-f0-9]{64}$/), expires_at: '2026-10-02T00:00:00Z' });
    expect(() => normalizeGrokAuth(projection, true)).toThrow('modern xAI OAuth');
  });
  it.each(['web_login', 'grok', 'api_key', 'external'])('rejects %s canonical modes', mode => {
    const map = native(); map[GROK_AUTH_SCOPE].auth_mode = mode;
    expect(() => normalizeGrokAuth(map, true)).toThrow('modern xAI OAuth');
  });
  it('requires the explicit modern OAuth expiry and refresh token for canonical enrollment', () => {
    const map = native() as Record<string, Record<string, unknown>>;
    delete map[GROK_AUTH_SCOPE]!.expires_at;
    expect(selectGrokCredential(map)).toBeNull();
    const missing = native() as Record<string, Record<string, unknown>>;
    delete missing[GROK_AUTH_SCOPE]!.refresh_token;
    expect(() => normalizeGrokAuth(missing, true)).toThrow('missing its refresh token');
  });
  it('renders native model and HTTP MCP headers without Codex-specific keys', () => {
    const service = new ClientConfigService({} as Database);
    const rendered = service.render({ model: 'grok-4.5', reasoning_effort: 'medium', approval_policy: 'never', sandbox_mode: 'danger-full-access', mcp_servers: [{ name: 'cgx', url: 'https://fleet.example/mcp', http_headers: { 'X-Engine': 'grok' } }] }, 'grok');
    expect(rendered.content).toContain('[models]\ndefault = "grok-4.5"\ndefault_reasoning_effort = "medium"');
    expect(rendered.content).toContain('[mcp_servers.cgx]');
    expect(rendered.content).toContain('headers = ');
    expect(rendered.content).not.toMatch(/http_headers|approval_policy|sandbox_mode|\[profiles/);
    const host = renderTomlForHost({ settings: { model: 'grok-4.6' }, host: null, baseUrl: 'https://fleet.example', apiKey: 'fixture-host-key', engine: 'grok' });
    expect(host.content).toContain('[mcp_servers.cgx]');
    expect(host.content).toContain('X-Engine = "grok"');
    expect(host.content).not.toMatch(/skills\.config|trusted|guardian/);
    expect(host.content).toContain('[model."grok-4.6"]\ncontext_window = 256000');
    expect(host.owned_paths).toEqual(['models.default', 'models.default_reasoning_effort', 'model.grok-4.6.context_window', 'mcp_servers.cgx']);
    const renamed = renderTomlForHost({ settings: { mcp_servers: [{ name: 'custom.server', command: 'tool-server' }] }, host: null, baseUrl: null, apiKey: null, engine: 'grok' });
    expect(renamed.owned_paths).toContain('mcp_servers.custom.server');
  });
  it('projects the posture into the native permission mode the fleet then owns', () => {
    const render = (preset: string) => renderTomlForHost({ settings: {}, host: null, baseUrl: null, apiKey: null, engine: 'grok', securityLevels: presetLevels(preset) });
    const standard = render('standard');
    expect(standard.content).toContain('[ui]\npermission_mode = "auto"\n');
    expect(standard.owned_paths).toContain('ui.permission_mode');
    expect(standard.content).not.toMatch(/approval_policy|sandbox_mode|permissionMode/);
    // Without a resolved posture the operator template stays untouched and unowned.
    const untouched = renderTomlForHost({ settings: {}, host: null, baseUrl: null, apiKey: null, engine: 'grok' });
    expect(untouched.content).not.toContain('[ui]');
    expect(untouched.owned_paths).not.toContain('ui.permission_mode');
    // An operator template may set a valid native mode; Claude spellings are dropped.
    const authored = renderTomlForHost({ settings: { ui: { permission_mode: 'always-approve' } }, host: null, baseUrl: null, apiKey: null, engine: 'grok' });
    expect(authored.content).toContain('permission_mode = "always-approve"');
    const claudeSpelling = renderTomlForHost({ settings: { permission_mode: 'bypassPermissions' }, host: null, baseUrl: null, apiKey: null, engine: 'grok' });
    expect(claudeSpelling.content).not.toContain('permission_mode');
  });
  it('applies the selected context window to the effective host model', () => {
    const rendered = renderTomlForHost({
      settings: { model: 'grok-4.7', context_window: 500_000 },
      host: { grokModelOverride: 'grok-4.7-build-fast' } as never,
      engine: 'grok', baseUrl: null, apiKey: null,
    });
    expect(rendered.content).toContain('[model."grok-4.7-build-fast"]\ncontext_window = 500000');
    expect(rendered.content).not.toContain('[model."grok-4.7"]');
    expect(rendered.owned_paths).toContain('model.grok-4.7-build-fast.context_window');
  });
  it('uses only subscription catalog efforts and context windows', () => {
    expect(modelDefaultsCatalog('grok')).toEqual([
      { model: 'grok-4.7', persistent_efforts: ['low', 'medium', 'high', 'xhigh'], default_effort: 'high' },
      { model: 'grok-4.7-build-fast', persistent_efforts: ['low', 'medium', 'high', 'xhigh'], default_effort: 'high' },
      { model: 'grok-4.6', persistent_efforts: ['low', 'medium', 'high', 'xhigh'], default_effort: 'high' },
      { model: 'grok-4.5', persistent_efforts: ['low', 'medium', 'high'], default_effort: 'high' },
    ].map(entry => ({ ...entry, context_windows: [256_000, 500_000], default_context_window: 256_000 })));
  });
});
