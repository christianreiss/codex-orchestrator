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

const tools = ['any', 'bash', 'edit', 'read', 'grep', 'mcp', 'webfetch', 'websearch', 'agent_message', 'agentmessage'];
const valid = [
  { action: 'deny' },
  ...tools.map(tool => ({ action: 'ask', tool })),
  { action: 'allow', tool: 'bash', pattern: 'git *', pattern_mode: 'glob' },
  { action: 'deny', tool: 'webfetch', pattern: '*.example.test', pattern_mode: 'domain' },
  { action: 'deny', tool: 'bash', pattern: '' },
  // Native accepts unmatched glob brackets; do not impose a different matcher.
  { action: 'deny', tool: 'bash', pattern: '[' },
];

describe('Grok permission rule validation', () => {
  it.each([
    [{}, 'action'], [{ tool: 'bash' }, 'action'],
    [{ action: 'oops' }, 'action'], [{ action: 'Deny' }, 'action'], [{ action: ' deny ' }, 'action'],
    [{ action: ['deny'] }, 'action'], [{ action: false }, 'action'],
    [{ action: 'deny', tool: 'no-such-tool' }, 'tool'], [{ action: 'deny', tool: 'Bash' }, 'tool'],
    [{ action: 'deny', tool: ['bash'] }, 'tool'],
    [{ action: 'deny', pattern: 1 }, 'pattern'],
    [{ action: 'deny', pattern_mode: 'regex' }, 'pattern_mode'],
    [{ action: 'deny', pattern_mode: ['glob'] }, 'pattern_mode'],
    [{ action: 'deny', unexpected: true }, 'unexpected'],
  ])('rejects rule %# before preview or storage, including conditional layers', async (rule, field) => {
    const db = createDbFake(), configs = new ClientConfigService(db as never);
    for (const layered of [false, true]) {
      const native_settings = layered
        ? { version_overrides: [{ minimum_version: '1.0.77', permission: { rules: [rule] } }] }
        : { permission: { rules: [{ action: 'allow', tool: 'read' }, rule] } };
      const path = layered ? `version_overrides.0.permission.rules.0.${field}` : `permission.rules.1.${field}`;
      const error = { status: 422, param: `settings.native_settings.${path}` };
      expect(() => configs.render({ native_settings }, 'grok')).toThrow(`native_settings.${path}:`);
      await expect(configs.store({ settings: { native_settings } }, null, 'grok')).rejects.toMatchObject(error);
      expect(db.tables.get(clientConfigDocuments)).toBeUndefined();
    }
  });

  it('retains optional fields, aliases, order and dotted patterns without adding native defaults', () => {
    const native = { permission: { rules: valid, deny: ['Bash(git push *)'] },
      version_overrides: [{ minimum_version: '1.0.77', permission: { rules: [{ action: 'deny' }] } }] };
    expect(normalizeGrokNativeSettings(native)).toEqual(native);
    expect(normalizeGrokNativeSettings({})).toEqual({});
    expect(normalizeGrokNativeSettings({ permission: { rules: [] } })).toEqual({ permission: { rules: [] } });
  });

  it('roundtrips add, edit and withdrawal with exact rule-array ownership and revision guards', async () => {
    const db = createDbFake(), configs = new ClientConfigService(db as never);
    let revision: string | null = null;
    for (const rules of [valid, [{ action: 'deny', tool: 'bash', pattern: 'git push *' }], []]) {
      const native_settings = { permission: { rules }, ui: { theme: 'kept' } };
      const saved = await configs.store({ settings: { native_settings }, expected_revision: revision }, null, 'grok');
      revision = saved.revision;
      db.tables.get(clientConfigDocuments)!.sort((a, b) => Number(b.id) - Number(a.id));
      const fetched = await configs.adminFetch('grok');
      expect(fetched.settings?.native_settings).toEqual(native_settings);
      const rendered = renderTomlForHost({ engine: 'grok', settings: fetched.settings,
        host: { grokClientVersion: '1.0.77', grokWrapperVersion: '0.9.172' } as never, baseUrl: null, apiKey: null });
      expect(rendered.content).toBe(saved.content);
      expect(rendered.owned_paths).toContain('permission.rules');
      expect(rendered.content).toContain('theme = "kept"');
      await expect(configs.store({ settings: { native_settings: {} }, expected_revision: null }, null, 'grok')).rejects.toMatchObject({ status: 409, code: 'config_revision_conflict' });
    }
    const removed = await configs.store({ settings: { native_settings: { ui: { theme: 'kept' } } }, expected_revision: revision }, null, 'grok');
    const rendered = renderTomlForHost({ engine: 'grok', settings: removed.settings, host: null, baseUrl: null, apiKey: null });
    expect(rendered.owned_paths).not.toContain('permission.rules');
    expect(rendered.content).not.toContain('[permission]');
    expect(rendered.content).toContain('theme = "kept"');
  });

  it('keeps invalid historical rules visible with their original snapshot for explicit correction', async () => {
    const settings = { native_settings: { permission: { rules: [{ action: 'deny', tool: 'typo' }] }, ui: { theme: 'kept' } } };
    const body = '# original invalid permission snapshot\n', sha256 = createHash('sha256').update(body).digest('hex');
    const historical = { id: 1, engine: 'grok', body, sha256, settings };
    const db = createDbFake(new Map([[clientConfigDocuments, [historical]]]));
    const configs = new ClientConfigService(db as never), fetched = await configs.adminFetch('grok');
    expect(fetched).toMatchObject({ content: body, sha256, settings,
      validation_error: { code: 'validation_failed', param: 'settings.native_settings.permission.rules.0.tool' } });
    await expect(configs.store({ settings: fetched.settings, expected_revision: fetched.revision }, null, 'grok')).rejects.toMatchObject({ status: 422 });
    const corrected = await configs.store({ settings: { native_settings: { permission: { rules: [{ action: 'deny' }] }, ui: { theme: 'kept' } } }, expected_revision: fetched.revision }, null, 'grok');
    expect(corrected.settings.native_settings).toMatchObject({ permission: { rules: [{ action: 'deny' }] }, ui: { theme: 'kept' } });
    expect(historical).toEqual({ id: 1, engine: 'grok', body, sha256, settings });
  });

  it.skipIf(!process.env.GROK_NATIVE_TEST_BIN)('loads every accepted rule through the real native permission consumer', () => {
    const home = mkdtempSync(join(tmpdir(), 'grok-permission-rules-'));
    try {
      const nativeHome = join(home, '.grok');
      mkdirSync(nativeHome);
      const settings = normalizeGrokNativeSettings({ permission: { rules: valid } })!;
      writeFileSync(join(nativeHome, 'config.toml'), renderGrokNativeToml(settings));
      const result = spawnSync(process.env.GROK_NATIVE_TEST_BIN!, ['inspect', '--json'], {
        cwd: home, env: { ...process.env, HOME: home, GROK_HOME: nativeHome, GROK_DISABLE_AUTOUPDATER: '1' }, encoding: 'utf8', timeout: 20000,
      });
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout).permissions).toMatchObject({ loaded: valid.length, skipped: [] });
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
});
