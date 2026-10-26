import { describe, expect, it } from 'vitest';
import { ClientConfigService } from '../../../src/services/client-config.js';
import { normalizeCodexNativeSettings } from '../../../src/services/codex-native-settings.js';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createDbFake } from '../../helpers/db-fake.js';

const oauth = { client_id: 'fixture-client', client_secret: 'never-echo-this-secret', authorization_server_issuer: 'https://issuer.invalid' };
const ema = { url: 'https://mcp.invalid', auth: 'ema_auth', oauth };
const invalid = [
  { url: ema.url, oauth: { client_secret: oauth.client_secret } },
  { url: ema.url, oauth: { client_secret: oauth.client_secret, client_id: ' ' } },
  { url: ema.url, oauth: { client_secret: ' ', client_id: 'client' } },
  { url: ema.url, oauth: { client_id: 'client', authorization_server_issuer: 'https://issuer.invalid' } },
  { ...ema, oauth: { client_id: 'client', client_secret: oauth.client_secret } },
  { ...ema, oauth: { ...oauth, authorization_server_issuer: ' ' } },
  { ...ema, environment_id: 'executor' },
  { command: '/bin/echo', auth: 'ema_auth', oauth },
  { command: '/bin/echo', oauth: { client_id: 'client', client_secret: oauth.client_secret } },
  { command: '/bin/echo', oauth: {} },
  { ...ema, bearer_token_env_var: 'TOKEN' },
  { ...ema, http_headers: { 'X-Custom': 'value' } },
  { ...ema, env_http_headers: { Authorization: 'TOKEN' } },
  { ...ema, http_headers_helper: '/bin/echo' },
];

describe('Codex OAuth parse and connection semantics', () => {
  it('rejects invalid native and structured MCP writes before changing the saved revision', async () => {
    const db = createDbFake(), service = new ClientConfigService(db as never);
    const saved = await service.store({ settings: { native_settings: { mcp_servers: { example: ema } } } });
    const before = structuredClone(await service.adminFetch());
    for (const settings of [
      { native_settings: { mcp_servers: { example: invalid[0] } } },
      { mcp_servers: [{ name: 'example', ...invalid[0] }] },
      { mcp_servers: [{ name: 'example', url: ema.url, oauth: 'not-an-object' }] },
      { mcp_servers: [{ name: 'example', url: ema.url, oauth: { client_id: 123 } }] },
    ]) {
      await expect(service.store({ settings, expected_revision: saved.revision })).rejects.toMatchObject({ status: 422 });
      expect(await service.adminFetch()).toEqual(before);
    }
  });

  it.each(invalid)('rejects invalid OAuth configuration without exposing secrets %#', server => {
    const native = { mcp_servers: { 'opaque.server.with.dots': server } };
    expect(() => normalizeCodexNativeSettings(native)).toThrow(/mcp_servers\.opaque.server.with.dots/);
    const service = new ClientConfigService({} as never);
    for (const input of [{ native_settings: native }, { profiles: [{ name: 'oauth', native_settings: native }] }]) {
      try {
        service.render(input);
        expect.fail('invalid OAuth configuration accepted');
      } catch (error) {
        expect(String(error)).not.toContain(oauth.client_secret);
        expect(String(error)).not.toContain('invalid OAuth configuration accepted');
      }
    }
  });

  it('preserves ordinary confidential OAuth without requiring EMA and permits valid local EMA', () => {
    for (const server of [
      { url: ema.url, oauth: { client_id: oauth.client_id, client_secret: oauth.client_secret } },
      ema,
      { ...ema, environment_id: 'local', http_headers: {}, env_http_headers: {} },
      { ...ema, oauth: { ...oauth, token_endpoint_auth_method: 'client_secret_post' } },
      { url: ema.url, auth: 'ema_auth' },
    ]) {
      const native = { mcp_servers: { 'opaque.server.with.dots': server } };
      expect(normalizeCodexNativeSettings(native)).toEqual(native);
      expect(new ClientConfigService({} as never).render({ native_settings: native }).content).toContain('[mcp_servers."opaque.server.with.dots"]');
    }
  });

  it.skipIf(!process.env.CODEX_NATIVE_TEST_BIN)('matches native confidential-client parsing without connecting or authenticating', () => {
    const home = mkdtempSync(join(tmpdir(), 'codex-oauth-'));
    try {
      for (const [config, expected] of [
        ['url="https://mcp.invalid"\n[ mcp_servers.example.oauth ]\nclient_secret="fixture-secret"', 1],
        ['url="https://mcp.invalid"\n[ mcp_servers.example.oauth ]\nclient_id="client"\nclient_secret="fixture-secret"', 0],
        ['url="https://mcp.invalid"\nauth="ema_auth"\n[ mcp_servers.example.oauth ]\nclient_id="client"\nclient_secret="fixture-secret"\nauthorization_server_issuer="https://issuer.invalid"', 0],
      ] as const) {
        writeFileSync(join(home, 'config.toml'), `[mcp_servers.example]\n${config}\n`);
        const result = spawnSync(process.env.CODEX_NATIVE_TEST_BIN!, ['features', 'list'], {
          env: { ...process.env, CODEX_HOME: home }, encoding: 'utf8', timeout: 15000,
        });
        expect(result.error).toBeUndefined();
        expect(result.status, result.stderr).toBe(expected);
      }
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
});
