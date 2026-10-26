import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { ClientConfigService, renderTomlForHost } from '../../../src/services/client-config.js';
import { normalizeCodexNativeSettings } from '../../../src/services/codex-native-settings.js';
import { validateCodexMitmSettings } from '../../../src/services/codex-native-mitm.js';
import { createDbFake } from '../../helpers/db-fake.js';
import { clientConfigDocuments } from '../../../src/db/schema.js';

const base = () => ({ version: 2, hooks: { 'hook.with.dot': { host: 'Example.test:443', schemes: ['hTTps'], ports: [443],
  methods: ['get', 'X-extension'], path_prefixes: ['/', 'pattern:/repos/{a,b}/[a-z]/**', 'literal:pattern:['],
  query: { tenant: ['literal:pattern:[', 'pattern:{a,b}*', ''] }, headers: { 'X.Tenant': ['pattern:*'], 'X-Empty': [] }, action: ['secret.action'] } },
  actions: { 'secret.action': { strip_request_headers: ['X-Example'], inject_request_headers: [{ name: 'Authorization', secret_env_var: 'MITM_TEST_SECRET', placeholder: 'placeholder', prefix: 'Bearer ' }] } } });
type Mitm = ReturnType<typeof base>;
const raw = (mitm: unknown) => ({ default_permissions: 'p', permissions: { p: { network: { mitm } } } });
const changed = (change: (value: Mitm) => void) => { const value = base(); change(value); return value; };
const cases: Array<[string, (value: Mitm) => void]> = [
  ['schemes', v => { v.hooks['hook.with.dot'].schemes = ['ftp']; }],
  ['zero port', v => { v.hooks['hook.with.dot'].ports = [0]; }],
  ['empty methods', v => { v.hooks['hook.with.dot'].methods = []; }],
  ['empty method', v => { v.hooks['hook.with.dot'].methods = ['  ']; }],
  ['empty paths', v => { v.hooks['hook.with.dot'].path_prefixes = []; }],
  ['empty path', v => { v.hooks['hook.with.dot'].path_prefixes = ['literal:']; }],
  ['empty pattern', v => { v.hooks['hook.with.dot'].path_prefixes = ['pattern:']; }],
  ['unclosed class', v => { v.hooks['hook.with.dot'].path_prefixes = ['pattern:/[']; }],
  ['reversed range', v => { v.hooks['hook.with.dot'].path_prefixes = ['pattern:/[z-a]']; }],
  ['unclosed alternate', v => { v.hooks['hook.with.dot'].path_prefixes = ['pattern:/{a,b']; }],
  ['unopened alternate', v => { v.hooks['hook.with.dot'].path_prefixes = ['pattern:/a}']; }],
  ['dangling escape', v => { v.hooks['hook.with.dot'].path_prefixes = ['pattern:/a\\']; }],
  ['reserved body', v => { Object.assign(v.hooks['hook.with.dot'], { body: {} }); }],
  ['empty normalized host', v => { v.hooks['hook.with.dot'].host = '.:443'; }],
  ['wildcard host', v => { v.hooks['hook.with.dot'].host = '*.example.test'; }],
  ['empty query name', v => { v.hooks['hook.with.dot'].query = { '': ['x'] } as never; }],
  ['empty query values', v => { v.hooks['hook.with.dot'].query.tenant = []; }],
  ['bad query matcher', v => { v.hooks['hook.with.dot'].query.tenant = ['pattern:[']; }],
  ['bad header name', v => { v.hooks['hook.with.dot'].headers = { 'bad header': ['x'] } as never; }],
  ['bad header matcher', v => { v.hooks['hook.with.dot'].headers['X.Tenant'] = ['pattern:{']; }],
  ['bad strip name', v => { v.actions['secret.action'].strip_request_headers = ['bad header']; }],
  ['User-Agent secret', v => { v.actions['secret.action'].inject_request_headers[0]!.name = 'User-Agent'; }],
  ['missing header name', v => { delete (v.actions['secret.action'].inject_request_headers[0] as Record<string, unknown>).name; }],
  ['empty placeholder', v => { v.actions['secret.action'].inject_request_headers[0]!.placeholder = ''; }],
  ['forbidden placeholder', v => { v.actions['secret.action'].inject_request_headers[0]!.name = 'Connection'; }],
  ['control placeholder', v => { v.actions['secret.action'].inject_request_headers[0]!.placeholder = 'never-echo\r\n'; }],
  ['missing source', v => { delete (v.actions['secret.action'].inject_request_headers[0] as Record<string, unknown>).secret_env_var; }],
  ['two sources', v => { Object.assign(v.actions['secret.action'].inject_request_headers[0]!, { secret_file: '/not-read' }); }],
  ['empty env', v => { v.actions['secret.action'].inject_request_headers[0]!.secret_env_var = ' '; }],
  ['relative file', v => { const h = v.actions['secret.action'].inject_request_headers[0]! as Record<string, unknown>; delete h.secret_env_var; h.secret_file = 'relative-file'; }],
];

describe('Codex native MITM semantics', () => {
  it.each(cases)('rejects native-invalid %s during preview, store and profile authoring', async (_name, mutate) => {
    const value = changed(mutate), service = new ClientConfigService(createDbFake() as never);
    expect(() => normalizeCodexNativeSettings(raw(value))).toThrow();
    expect(() => service.render({ profiles: [{ name: 'profile', native_settings: raw(value) }] })).toThrow();
    await expect(service.store({ settings: { native_settings: raw(value) } })).rejects.toMatchObject({ status: 422 });
  });
  it.each(cases)('independent helper rejects %s without values in errors', (_name, mutate) => {
    expect(() => validateCodexMitmSettings(changed(mutate), 'native_settings.permissions.p.network.mitm')).toThrow();
    try { validateCodexMitmSettings(changed(mutate), 'native_settings.permissions.p.network.mitm'); }
    catch (error) { expect(String(error)).not.toContain('never-echo'); }
  });
  it('roundtrips valid literals, glob syntax, extension methods, opaque names and withdrawal', async () => {
    const db = createDbFake(), service = new ClientConfigService(db as never), native = raw(base());
    const stored = await service.store({ settings: { native_settings: native, profiles: [{ name: 'profile', native_settings: native }] } });
    expect((await service.adminFetch()).settings?.native_settings).toEqual(native);
    expect(stored.content).toContain('"hook.with.dot"');
    expect(renderTomlForHost({ settings: stored.settings, host: { clientVersion: '0.164.0' } as never, baseUrl: null, apiKey: null }).content).toContain('X-extension');
    const edited = await service.store({ settings: { native_settings: raw(changed(v => { v.hooks['hook.with.dot'].methods = ['PATCH']; })) }, expected_revision: stored.revision });
    db.tables.get(clientConfigDocuments)!.sort((a, b) => Number(b.id) - Number(a.id));
    await expect(service.store({ settings: stored.settings, expected_revision: stored.revision })).rejects.toMatchObject({ status: 409 });
    const removed = await service.store({ settings: { native_settings: {} }, expected_revision: edited.revision });
    expect(removed.content).not.toContain('mitm');
  });
  it('rejects config-expressible injected prefix controls before runtime secret resolution', () => {
    expect(() => validateCodexMitmSettings(changed(v => { v.actions['secret.action'].inject_request_headers[0]!.prefix = 'Bearer\r\n'; }), 'mitm')).toThrow('valid HTTP header value');
  });
  it('retains unused declarations until a hook actually selects their headers', () => {
    const value = base();
    Object.assign(value.actions, { unused: { inject_request_headers: [{ name: 'User-Agent' }] } });
    expect(() => validateCodexMitmSettings(value, 'mitm')).not.toThrow();
    value.hooks['hook.with.dot'].action.push('unused');
    expect(() => validateCodexMitmSettings(value, 'mitm')).toThrow('User-Agent');
  });
  it('retains valid native edge cases instead of JavaScript glob/header restrictions', () => {
    for (const path of ['pattern:/[]a]', 'pattern:/[!a]', 'pattern:/{a,{b,c}}', 'pattern:/a\\*', 'literal:pattern:[]', '/literal[']) {
      expect(() => validateCodexMitmSettings(changed(v => { v.hooks['hook.with.dot'].path_prefixes = [path]; }), 'mitm')).not.toThrow();
    }
    expect(() => validateCodexMitmSettings(changed(v => { v.actions['secret.action'].inject_request_headers[0]!.placeholder = '🐈\t'; }), 'mitm')).not.toThrow();
    expect(() => validateCodexMitmSettings(changed(v => {
      const h = v.actions['secret.action'].inject_request_headers[0]! as Record<string, unknown>; delete h.secret_env_var; h.secret_file = '/not-read/native-secret';
    }), 'mitm')).not.toThrow();
  });
  it.skipIf(!process.env.CODEX_NATIVE_TEST_BIN)('matches actual native 0.164 static validation without resolving secrets', () => {
    const home = mkdtempSync(join(tmpdir(), 'codex-mitm-'));
    const inline = (value: unknown): string => typeof value !== 'object' || value === null ? JSON.stringify(value)
      : Array.isArray(value) ? `[${value.map(inline).join(',')}]` : `{${Object.entries(value).map(([key, item]) => `${JSON.stringify(key)}=${inline(item)}`).join(',')}}`;
    try {
      writeFileSync(join(home, 'config.toml'), '');
      const unusedAction = base();
      Object.assign(unusedAction.actions, { unused: { inject_request_headers: [{ name: 'User-Agent' }] } });
      const validEdges = ['pattern:/[]a]', 'pattern:/[!a]', 'pattern:/{a,{b,c}}', 'pattern:/a\\*', 'literal:pattern:[]', '/literal['].map(path => [path, changed(v => { v.hooks['hook.with.dot'].path_prefixes = [path]; }), true]);
      for (const [name, value, valid] of [['valid', base(), true], ['unused action', unusedAction, true], ['UTF-8 placeholder', changed(v => { v.actions['secret.action'].inject_request_headers[0]!.placeholder = '🐈\t'; }), true], ['unread absolute secret file', changed(v => { const h = v.actions['secret.action'].inject_request_headers[0]! as Record<string, unknown>; delete h.secret_env_var; h.secret_file = '/not-read/native-secret'; }), true], ...validEdges, ...cases.map(([name, mutate]) => [name, changed(mutate), false])] as Array<[string, Mitm, boolean]>) {
        const probe = spawnSync(process.env.CODEX_NATIVE_TEST_BIN!, ['-c', 'default_permissions="p"', '-c', `permissions=${inline({ p: { network: { mitm: value } } })}`, 'features', 'list'], { env: { ...process.env, CODEX_HOME: home }, encoding: 'utf8', timeout: 15000 });
        expect(probe.error, name).toBeUndefined();
        expect(probe.status === 0, `${name}: ${probe.stderr}`).toBe(valid);
      }
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
});
