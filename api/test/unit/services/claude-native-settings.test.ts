import { describe, expect, it } from 'vitest';
import { normalizeSettings } from '../../../src/services/config-normalizer.js';
import {
  ClientConfigService,
  clampClaudePermissionModeForUser,
  renderClaudeSettingsPartial,
  renderClaudeSettingsPartialForHost,
} from '../../../src/services/client-config.js';
import { normalizeClaudeNativeSettings } from '../../../src/services/claude-native-settings.js';

const normalize = (native: Record<string, unknown>, structured: Record<string, unknown> = {}) =>
  normalizeSettings({ native_settings: native, ...structured }, { applyCodexDefaults: false, engine: 'claude' });

describe('Claude native user settings', () => {
  it('preserves opt-in features through normalization, stored settings and both renders', () => {
    const native = {
      modelSettings: { 'claude-opus-5-5': { effortLevel: 'high', maxEffortLevel: 'xhigh', autoCompactWindow: 300000 } },
      fallbackModel: ['sonnet', 'haiku'],
      ultracode: true,
      availableModels: ['opus', 'sonnet'],
      autoCompactWindow: 500000,
      voice: { enabled: true, mode: 'tap' },
      worktree: { bgIsolation: 'worktree', sparsePaths: ['api/'] },
      permissions: { additionalDirectories: ['/srv/project'], defaultMode: 'plan' },
      attribution: { commit: '', pr: '', sessionUrl: false },
      sandbox: { enabled: true, filesystem: { denyRead: ['/etc/private'] }, network: { allowedDomains: ['example.com'], tlsTerminate: { caCertPath: '/etc/cert.pem' } } },
      modelPicker: { options: [{ model: 'sonnet', label: 'Daily' }], replaceBuiltInOptions: false },
      pluginConfigs: { 'deployer@fleet.example': { options: { target: 'test', retries: 3 }, mcpServers: { deploy: { project: 'example' } } } },
      outputStyle: 'Concise',
    };
    const settings = normalize(native);
    expect(settings.native_settings).toEqual(native);
    expect(normalizeSettings(settings, { applyCodexDefaults: false, engine: 'claude' }).native_settings).toEqual(native);
    const rendered = new ClientConfigService({} as never).render({ native_settings: native }, 'claude');
    expect(JSON.parse(rendered.content)).toMatchObject(native);
    const { partial, owned_paths } = renderClaudeSettingsPartial(settings);
    expect(partial).toMatchObject(native);
    expect(owned_paths).toContain('modelSettings.claude-opus-5-5.effortLevel');
    expect(owned_paths).toContain('permissions.additionalDirectories');
    expect(owned_paths).not.toContain('modelSettings');
    expect(owned_paths).not.toContain('permissions');
  });

  it('validates other engines separately and leaves absent extensions unchanged', () => {
    const raw = { native_settings: { language: 'german' } };
    expect(() => normalizeSettings(raw)).toThrow('native_settings.language');
    expect(normalizeSettings(raw, { applyCodexDefaults: false, engine: 'grok' }).native_settings).toBeUndefined();
    expect(normalize({}).native_settings).toBeUndefined();
  });

  it('keeps native edits and removal authoritative across store/fetch cycles', async () => {
    let row: Record<string, unknown> | undefined;
    let id = 0;
    const query = {
      from: () => query,
      where: () => query,
      orderBy: () => query,
      limit: () => {
        const result = Promise.resolve(row ? [structuredClone(row)] : []);
        return Object.assign(result, { for: () => result });
      },
    };
    const db = {
      select: () => query,
      transaction: async <T>(write: (tx: unknown) => Promise<T>) => write(db),
      insert: () => ({ values: async (value: Record<string, unknown>) => {
        row = { ...structuredClone(value), id: ++id };
        return [{ insertId: id }];
      } }),
    };
    const service = new ClientConfigService(db as never);
    await service.store({ settings: { native_settings: { env: { CUSTOM: 'first' }, permissions: { defaultMode: 'plan' } } } }, null, 'claude');
    const first = await service.adminFetch('claude');
    expect(first.settings?.env).toBeUndefined();
    expect(first.settings?.permissionMode).toBeUndefined();
    const changed = await service.store({ settings: { ...first.settings, native_settings: { env: { CUSTOM: 'second' }, permissions: { defaultMode: 'manual' } } } }, null, 'claude');
    expect(JSON.parse(changed.content)).toMatchObject({ env: { CUSTOM: 'second' }, permissions: { defaultMode: 'manual' } });
    const second = await service.adminFetch('claude');
    await service.store({ settings: { ...second.settings, native_settings: {} } }, null, 'claude');
    const cleared = await service.adminFetch('claude');
    expect(cleared.settings?.native_settings).toBeUndefined();
    const rendered = JSON.parse(cleared.content!);
    expect(rendered.env).toBeUndefined();
    expect(rendered.permissions.defaultMode).not.toBe('manual');
  });

  it('gives explicit structured fields precedence without erasing native siblings', () => {
    const settings = normalize({
      permissions: { allow: ['Read'], additionalDirectories: ['/srv'], defaultMode: 'plan' },
      env: { CUSTOM_A: 'native', CUSTOM_B: 'preserved' },
      statusLine: { type: 'command', command: 'native', hideVimModeIndicator: true },
    }, {
      permissionMode: 'auto',
      env: { CUSTOM_A: 'structured' },
      statusLine: { type: 'command', command: 'structured' },
    });
    const { partial } = renderClaudeSettingsPartial(settings);
    expect(partial.permissions).toMatchObject({ defaultMode: 'auto', additionalDirectories: ['/srv'] });
    expect((partial.permissions as { allow: string[] }).allow).toContain('Read');
    expect(partial.env).toEqual({ CUSTOM_A: 'structured', CUSTOM_B: 'preserved' });
    expect(partial.statusLine).toEqual({ type: 'command', command: 'structured', hideVimModeIndicator: true });
  });

  it('preserves native hooks while adding the managed receiver hooks', () => {
    const nativeHooks = { Stop: [{ hooks: [{ type: 'command', command: 'printf test' }] }] };
    const { partial } = renderClaudeSettingsPartial(normalize({ hooks: nativeHooks }), { agentMessagingEnabled: true });
    expect((partial.hooks as typeof nativeHooks).Stop).toHaveLength(2);
    expect((partial.hooks as typeof nativeHooks).Stop[0]).toEqual(nativeHooks.Stop[0]);
  });

  it('clamps a native root bypass mode exactly like the structured mode', () => {
    const result = clampClaudePermissionModeForUser({ native_settings: { permissions: { defaultMode: 'bypassPermissions' } } }, 'root');
    expect(result.clamped).toMatchObject({ from: 'bypassPermissions', username: 'root' });
    expect(result.settings.permissionMode).not.toBe('bypassPermissions');
  });

  it('preserves the supported statusline boolean from the structured editor', () => {
    const normalized = normalize({}, { statusLine: { type: 'command', command: 'printf test', hideVimModeIndicator: true } });
    expect(normalized.statusLine?.hideVimModeIndicator).toBe(true);
  });

  it.each(['includeCoAuthoredBy', 'disableArtifact', 'voiceEnabled', 'keybindingFlavor', 'taskOutputMaxChars', 'ignorePatterns', 'permissionExplainerEnabled', 'teammateDefaultModel'])('rejects deprecated %s with a named diagnostic', key => {
    expect(() => normalize({ [key]: true })).toThrow(`native_settings.${key}`);
  });

  it.each([
    { imaginarySetting: true },
    { language: false },
    { availableModels: [2] },
    { maxEffortLevel: 'ultra' },
    { modelSettings: { 'claude-opus-5-5': { effortLevel: 'max' } } },
    { autoCompactWindow: 10 },
    { cleanupPeriodDays: 0 },
    { skillListingBudgetFraction: 0 },
    { permissions: { additionalDirectories: false } },
    { statusLine: { type: 'command', command: 'printf test', hideVimModeIndicator: 'true' } },
    { hooks: { Stop: [{ commands: ['false'] }] } },
    { hooks: { PostToolUse: [{ hooks: [{ type: 'mcp_tool', server: 'scan' }] }] } },
    { sandbox: { filesystem: { denyRead: false } } },
    { sandbox: { network: { tlsTerminate: { caCertPath: false } } } },
    { modelPicker: { options: [{ model: false }] } },
    { pluginConfigs: { 'plugin@local': { options: { broken: {} } } } },
    { worktree: { bgIsolation: 'shared' } },
    { voice: { mode: 'toggle' } },
  ])('rejects invalid values before they can poison native config: %j', native => {
    expect(() => normalizeClaudeNativeSettings(native)).toThrow(/native_settings/);
  });

  it('explains managed, global and fleet-owned scopes instead of silently accepting inert values', () => {
    expect(() => normalize({ managedMcpServers: {} })).toThrow('requires native managed settings');
    expect(() => normalize({ autoConnectIde: true })).toThrow('belongs in ~/.claude.json');
    expect(() => normalize({ apiKeyHelper: 'echo secret' })).toThrow('Authentication is owned');
    expect(() => normalize({ model: 'retired-model' })).toThrow('Use the model control');
    expect(() => normalize({ sandbox: { network: { allowManagedDomainsOnly: true } } })).toThrow('requires native managed settings');
  });

  it('rejects prototype keys and encodes literal dots in ownership paths', () => {
    expect(() => normalize(JSON.parse('{"env":{"__proto__":"x"}}'))).toThrow('unsafe key');
    const { partial, owned_paths } = renderClaudeSettingsPartial(normalize({ modelSettings: { 'custom.model': { effortLevel: 'high' } } }));
    expect(partial.modelSettings).toEqual({ 'custom.model': { effortLevel: 'high' } });
    expect(owned_paths).toContain('json:["modelSettings","custom.model","effortLevel"]');
  });

  it('owns explicit empty objects that enable native features', () => {
    const { partial, owned_paths } = renderClaudeSettingsPartial(normalize({ sandbox: { network: { tlsTerminate: {} } } }));
    expect(partial.sandbox).toEqual({ network: { tlsTerminate: {} } });
    expect(owned_paths).toContain('sandbox.network.tlsTerminate');
  });

  it('requires an upgraded host only when literal-key ownership is needed', () => {
    const opts = {
      host: { claudeWrapperVersion: '0.9.65' } as never,
      settings: { native_settings: { enabledPlugins: { 'review@fleet.example': true } } },
      baseUrl: null,
      apiKey: null,
    };
    expect(() => renderClaudeSettingsPartialForHost(opts)).toThrow('require cxx 0.9.66');
    expect(() => renderClaudeSettingsPartialForHost({ ...opts, host: { claudeWrapperVersion: '0.9.66' } as never })).not.toThrow();
    expect(() => renderClaudeSettingsPartialForHost({ ...opts, settings: { native_settings: { language: 'german' } } })).not.toThrow();
  });
});
