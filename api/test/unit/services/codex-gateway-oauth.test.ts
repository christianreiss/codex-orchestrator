import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { normalizeCodexNativeSettings } from '../../../src/services/codex-native-settings.js';
import { ClientConfigService } from '../../../src/services/client-config.js';
import { createDbFake } from '../../helpers/db-fake.js';
import { clientConfigDocuments } from '../../../src/db/schema.js';

const oauth = { authorization_url: 'https://idp.example.test/auth', token_url: 'https://idp.example.test/token', client_id: 'audit' };
const provider = (extra: Record<string, unknown> = {}) => ({ name: 'Audit', base_url: 'https://gateway.example.test/v1', gateway_oauth: oauth, ...extra });
const secondary = { kind: 'header', name: 'X-Gateway-Auth', scheme: 'Bearer' };
const exportSource = { credential_export: { command: '/never-run/credential-export' } };
const cases: [string, Record<string, unknown>, RegExp][] = [
  ['missing endpoint', provider({ base_url: undefined }), /requires base_url/],
  ...['http://gateway.example.test', 'https://user:pass@gateway.example.test', 'https://gateway.example.test/#', 'not a URL'].map(url => ['bad endpoint', provider({ base_url: url }), /base_url/] as [string, Record<string, unknown>, RegExp]),
  ['bad authorization endpoint', provider({ gateway_oauth: { ...oauth, authorization_url: 'http://idp.example.test/auth' } }), /authorization_url/],
  ['bad token endpoint', provider({ gateway_oauth: { ...oauth, token_url: 'https://user:pass@idp.example.test/token' } }), /token_url/],
  ['bad device endpoint', provider({ gateway_oauth: { ...oauth, device_authorization_url: 'https://idp.example.test/device#secret' } }), /device_authorization_url/],
  ['empty client ID', provider({ gateway_oauth: { ...oauth, client_id: '  ' } }), /client_id/],
  ['zero redirect port', provider({ gateway_oauth: { ...oauth, redirect_port: 0 } }), /redirect_port/],
  ...['env_key', 'experimental_bearer_token'].map(key => ['primary auth conflict', provider({ [key]: 'AUDIT_ONLY' }), /Authorization/] as [string, Record<string, unknown>, RegExp]),
  ['ChatGPT auth conflict', provider({ requires_openai_auth: true }), /Authorization/],
  ['command auth conflict', provider({ auth: { command: '/never-run/provider-auth' } }), /Authorization/],
  ['Google primary auth conflict', provider({ name: 'Google Cloud Vertex AI' }), /Google Cloud/],
  ['named AWS conflict', provider({ name: 'Amazon Bedrock' }), /AWS/],
  ...['http_headers', 'env_http_headers'].map(key => ['duplicate primary header', provider({ [key]: { aUtHoRiZaTiOn: 'AUDIT_ONLY' } }), /duplicate.*header/i] as [string, Record<string, unknown>, RegExp]),
  ['duplicate custom header', provider({ gateway_oauth: { ...oauth, delivery: secondary }, env_http_headers: { 'x-gateway-auth': 'AUDIT_ONLY' } }), /duplicate.*header/i],
  ['duplicate cookie', provider({ gateway_oauth: { ...oauth, delivery: { kind: 'cookie', name: 'gateway' } }, http_headers: { COOKIE: 'AUDIT_ONLY' } }), /duplicate.*header/i],
  ...['Host', 'Proxy-Authorization', 'ChatGPT-Account-ID', 'X-Codex-Test', 'X-OpenAI-Test', 'Sec-WebSocket-Test', 'bad header'].map(name => ['reserved/invalid header', provider({ gateway_oauth: { ...oauth, delivery: { ...secondary, name } } }), /delivery/] as [string, Record<string, unknown>, RegExp]),
  ['invalid scheme', provider({ gateway_oauth: { ...oauth, delivery: { ...secondary, scheme: 'Bearer token' } } }), /delivery/],
  ['non-Bearer Authorization', provider({ gateway_oauth: { ...oauth, delivery: { kind: 'header', name: 'Authorization', scheme: 'Basic' } } }), /delivery/],
  ['bad cookie token', provider({ gateway_oauth: { ...oauth, delivery: { kind: 'cookie', name: 'bad=name' } } }), /delivery/],
  ['catalog host mismatch', provider({ model_catalog_url: 'https://other.example.test/models' }), /same scheme, host, and port/],
  ['catalog port mismatch', provider({ model_catalog_url: 'https://gateway.example.test:444/models' }), /same scheme, host, and port/],
  ['export catalog mismatch with secondary delivery', provider({ gateway_oauth: { ...exportSource, delivery: secondary }, model_catalog_url: 'https://other.example.test/models' }), /same scheme, host, and port/],
  ['empty exporter', provider({ gateway_oauth: { credential_export: { command: '  ' } } }), /command/],
  ['relative exporter path', provider({ gateway_oauth: { credential_export: { command: './exporter' } } }), /command/],
];
const valid = [
  provider(), provider({ base_url: 'http://localhost:8765/v1' }), provider({ base_url: 'http://127.2.3.4/v1' }), provider({ base_url: 'http://[::1]:8765/v1' }),
  provider({ base_url: 'https://:@gateway.example.test' }),
  provider({ model_catalog_url: 'https://gateway.example.test:443/models' }),
  provider({ gateway_oauth: { ...oauth, delivery: secondary }, requires_openai_auth: true, model_catalog_url: 'https://other.example.test/models' }),
  provider({ gateway_oauth: { ...oauth, delivery: { kind: 'cookie', name: 'gateway_session' } }, env_key: 'AUDIT_ONLY' }),
  provider({ gateway_oauth: exportSource }),
  provider({ gateway_oauth: { ...exportSource, delivery: secondary }, auth: { command: '/never-run/provider-auth' } }),
  provider({ gateway_oauth: { credential_export: { command: 'credential-export' } } }),
];
const document = (value: Record<string, unknown>) => ({ model_providers: { 'custom.with.dots': Object.fromEntries(Object.entries(value).filter(([, value]) => value !== undefined)) } });

describe('Codex gateway OAuth native semantics', () => {
  it.each(cases)('rejects %s at authoring', (_label, value, error) => {
    expect(() => normalizeCodexNativeSettings(document(value))).toThrow(error);
  });
  it.each(valid)('preserves valid gateway settings and opaque commands', value => {
    expect(normalizeCodexNativeSettings(document(value))).toEqual(document(value));
  });
  it('enforces root/profile store boundaries with literal provider names, then removal', async () => {
    const service = new ClientConfigService(createDbFake() as never);
    for (const settings of [{ native_settings: document(cases[0]![1]) }, { profiles: [{ name: 'audit', native_settings: document(cases[0]![1]) }] },
      { native_settings: document(valid[0]!), profiles: [{ name: 'audit', native_settings: document(cases[0]![1]) }] }]) {
      await expect(service.store({ settings })).rejects.toThrow(/custom\.with\.dots.*base_url/);
    }
    const accepted = await service.store({ settings: { native_settings: document(valid[0]!), profiles: [{ name: 'audit', native_settings: document(valid[5]!) }] } });
    expect(accepted.content).toContain('[model_providers."custom.with.dots".gateway_oauth]');
    const removed = await service.store({ settings: { native_settings: {}, profiles: [] }, expected_revision: accepted.revision });
    expect(removed.content).not.toContain('gateway_oauth');
  });
  it('keeps invalid historical JSON editable with a sanitized field error, preserving its body', async () => {
    const db = createDbFake(), service = new ClientConfigService(db as never);
    const stored = await service.store({ settings: { native_settings: document(valid[0]!) } });
    const row = db.tables.get(clientConfigDocuments)!.at(-1)!;
    const authored = { native_settings: document(provider({ base_url: 'http://user:PRIVATE_SENTINEL@gateway.example.test' })) };
    row.settings = authored;
    const fetched = await service.adminFetch();
    expect(fetched.settings).toEqual(authored);
    expect(fetched.content).toBe(stored.content);
    expect(fetched.revision).toBe(stored.revision);
    expect(fetched.validation_error?.message).toContain('base_url');
    expect(fetched.validation_error?.message).not.toContain('PRIVATE_SENTINEL');
    expect(row.settings).toEqual(authored);
  });
});

// The config-loading oracle never performs login or inference. Raw TOML bypasses
// the central validator for negatives, keeping the native parser independent.
function toml(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(toml).join(', ')}]`;
  if (value && typeof value === 'object') return `{ ${Object.entries(value).filter(([, item]) => item !== undefined).map(([key, item]) => `${JSON.stringify(key)} = ${toml(item)}`).join(', ')} }`;
  return JSON.stringify(value);
}
describe.skipIf(!process.env.CODEX_NATIVE_TEST_BIN)('Codex 0.169 actual gateway config loader', () => {
  it('agrees with rejection/acceptance controls without executing helper commands', () => {
    const home = mkdtempSync(join(tmpdir(), 'codex-gateway-oracle-'));
    const marker = join(home, 'helper-ran'), helper = join(home, 'credential-export');
    writeFileSync(helper, `#!/bin/sh\nprintf invoked > '${marker}'\nexit 1\n`, { mode: 0o700 });
    try {
      for (const [expected, value] of [...cases.map(([, value]) => [false, value] as const), ...valid.map(value => [true, value] as const), [true, provider({ gateway_oauth: { credential_export: { command: helper } } })] as const]) {
        writeFileSync(join(home, 'config.toml'), `[model_providers]\n"custom.with.dots" = ${toml(value)}\n`);
        const probe = spawnSync(process.env.CODEX_NATIVE_TEST_BIN!, ['features', 'list'], {
          env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: home, CODEX_HOME: home }, encoding: 'utf8', timeout: 15000,
        });
        expect(probe.error).toBeUndefined();
        expect(probe.status, probe.stderr).toBe(expected ? 0 : 1);
        if (!expected) expect(probe.stderr).toContain('failed to load bootstrap configuration');
        expect(existsSync(marker)).toBe(false);
        expect(existsSync(join(home, 'auth.json'))).toBe(false);
      }
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
});
