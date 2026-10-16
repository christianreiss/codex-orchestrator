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
  it.each([
    [{ voice: { enabld: true } }, 'voice.enabld'],
    [{ permissions: { additionalDirectory: ['/tmp'] } }, 'permissions.additionalDirectory'],
    [{ sandbox: { filesystem: { denyReads: ['/tmp'] } } }, 'sandbox.filesystem.denyReads'],
    [{ sandbox: { credentials: { files: [{ path: '/tmp/key', mode: 'mask', injectHost: ['example.com'] }] } } }, 'sandbox.credentials.files.0.injectHost'],
    [{ sandbox: { credentials: { envVars: [{ name: 'KEY', mode: 'secret' }] } } }, 'sandbox.credentials.envVars.0.mode'],
    [{ sandbox: { credentials: { sigv4: { streaming: 'allow' } } } }, 'sandbox.credentials.sigv4.streaming'],
    [{ sandbox: { ripgrep: { command: 'rg', args: [false] } } }, 'sandbox.ripgrep.args.0'],
    [{ modelSettings: { 'vendor.model': { effortLevels: 'high' } } }, 'modelSettings["vendor.model"].effortLevels'],
    [{ modelPicker: { options: [{ model: 'sonnet', lable: 'Test' }] } }, 'modelPicker.options.0.lable'],
    [{ statusLine: { type: 'command', command: 'test', refreshIntervals: 10 } }, 'statusLine.refreshIntervals'],
    [{ fileSuggestion: { type: 'command', command: 'test', padding: 2 } }, 'fileSuggestion.padding'],
    [{ subagentStatusLine: { type: 'command', command: 'test', hideVimModeIndicator: true } }, 'subagentStatusLine.hideVimModeIndicator'],
    [{ spinnerVerbs: { mode: 'merge', verbs: [] } }, 'spinnerVerbs.mode'],
    [{ spinnerTipsOverride: { tips: [{ id: 'tip', text: 'test', cooldownSession: 2 }] } }, 'spinnerTipsOverride.tips.0.cooldownSession'],
    [{ spellcheck: { checker: 'magic' } }, 'spellcheck.checker'],
    [{ pluginConfigs: { 'plugin@fleet.example': { option: {} } } }, 'pluginConfigs["plugin@fleet.example"].option'],
    [{ extraKnownMarketplaces: { 'fleet.example': { source: { source: 'github', repo: 'org/repo', brach: 'main' } } } }, 'extraKnownMarketplaces["fleet.example"].source.brach'],
    [{ extraKnownMarketplaces: { fleet: { source: { source: 'github', repo: 'org/repo', skipLfs: true } } } }, 'extraKnownMarketplaces.fleet.source.skipLfs'],
    [{ allowedMcpServers: [{ serverCommands: ['test'] }] }, 'allowedMcpServers.0.serverCommands'],
    [{ deniedMcpServers: [{ serverName: 'test', serverUrl: 'https://example.com' }] }, 'deniedMcpServers.0'],
    [{ sshConfigs: [{ id: 'test', name: 'Test', sshHost: 'host', sshPort: '22' }] }, 'sshConfigs.0.sshPort'],
    [{ footerLinksRegexes: [{ type: 'regexp', pattern: '.*', url: 'https://example.com' }] }, 'footerLinksRegexes.0.type'],
    [{ hooks: { PostToolUses: [] } }, 'hooks.PostToolUses'],
    [{ hooks: { PermissionRequest: [{ hooks: [{ type: 'agent', prompt: 'test' }] }] } }, 'hooks.PermissionRequest.0.hooks.0.type'],
    [{ hooks: { SessionStart: [{ hooks: [{ type: 'http', url: 'https://example.com' }] }] } }, 'hooks.SessionStart.0.hooks.0.type'],
    [{ hooks: { PreCompact: [{ hooks: [{ type: 'prompt', prompt: 'test' }] }] } }, 'hooks.PreCompact.0.hooks.0.type'],
    [{ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'test', if: 'Bash(*)' }] }] } }, 'hooks.Stop.0.hooks.0.if'],
    [{ hooks: { Stop: [{ hook: [] }] } }, 'hooks.Stop.0.hooks'],
    [{ hooks: { Stop: [{ hooks: [{ type: 'prompt', prompt: 'test', modle: 'sonnet' }] }] } }, 'hooks.Stop.0.hooks.0.modle'],
    [{ hooks: { PostToolUse: [{ hooks: [{ type: 'command', command: 'test', async: 'true' }] }] } }, 'hooks.PostToolUse.0.hooks.0.async'],
    [{ hooks: { PostToolUse: [{ hooks: [{ type: 'http', url: 'https://example.com', headers: { 'X.Test': false } }] }] } }, 'hooks.PostToolUse.0.hooks.0.headers["X.Test"]'],
    [{ hooks: { Stop: [{ hooks: [{ type: 'agent', prompt: 'test', command: 'inert' }] }] } }, 'hooks.Stop.0.hooks.0.command'],
    [{ hooks: { Stop: [{ hooks: [{ type: 'mcp_tool', server: 'name.with.dots', tool: 'test', onFailure: 'block' }] }] } }, 'hooks.Stop.0.hooks.0.onFailure'],
  ])('rejects nested invalid authoring at the exact path: %j', (native, path) => {
    expect(() => normalizeClaudeNativeSettings(native)).toThrow(`native_settings.${path}`);
    expect(() => new ClientConfigService({} as never).render({ native_settings: native }, 'claude')).toThrow(`native_settings.${path}`);
  });

  it('retains arbitrary map keys and payloads through normalization, host render and exact ownership', () => {
    const native = {
      env: { 'custom.name': 'value' },
      modelSettings: { 'custom.model': { effortLevel: 'high', autoCompactWindow: 'auto' } },
      enabledPlugins: { 'review@fleet.example': true },
      skillOverrides: { 'review.code': 'name-only' },
      pluginConfigs: { 'review@fleet.example': { options: { 'custom.option': ['one'] }, mcpServers: { 'server.name': { 'custom.field': true } } } },
      sandbox: { ignoreViolations: { '/tmp/*.socket': ['network'] }, credentials: { files: [{ path: '/tmp/key', mode: 'mask', decode: 'jwt', maskClaims: ['api_key'] }], envVars: [{ name: 'TOKEN', mode: 'mask' }], sigv4: { streaming: 'deny' } } },
      extraKnownMarketplaces: { 'fleet.example': { source: { source: 'settings', name: 'fleet.example', plugins: [{ name: 'review', source: { source: 'archive', url: 'https://example.com/plugin.zip' } }] } } },
      hooks: { PostToolUse: [{ matcher: 'mcp__server.name__tool', hooks: [
        { type: 'command', command: 'test', args: ['--test'], async: true, shell: 'bash', onFailure: 'continue', timeout: 10 },
        { type: 'http', url: 'https://example.com', headers: { 'X.Name': 'value' }, allowedEnvVars: ['NAME'] },
        { type: 'mcp_tool', server: 'server.name', tool: 'tool.name', input: { arbitrary: { 'nested.name': [true, 1, null] } } },
        { type: 'prompt', prompt: 'test', model: 'sonnet', continueOnBlock: true },
        { type: 'agent', prompt: 'test', statusMessage: 'checking' },
      ] }] },
    };
    expect(normalizeClaudeNativeSettings(native)).toEqual(native);
    const rendered = renderClaudeSettingsPartialForHost({
      host: { claudeClientVersion: '2.1.301', claudeWrapperVersion: '0.9.88' } as never,
      settings: { native_settings: native }, baseUrl: null, apiKey: null,
    });
    expect(rendered.partial).toMatchObject(native);
    expect(rendered.owned_paths).toContain('json:["pluginConfigs","review@fleet.example","mcpServers","server.name","custom.field"]');
    expect(rendered.owned_paths).toContain('json:["sandbox","ignoreViolations","/tmp/*.socket"]');
    expect(rendered.owned_paths).toContain('hooks.PostToolUse');
    const afterRemoval = renderClaudeSettingsPartial(normalize({ env: native.env }));
    expect(afterRemoval.owned_paths).toContain('json:["env","custom.name"]');
    expect(afterRemoval.owned_paths.some(path => path.includes('pluginConfigs'))).toBe(false);
  });

  it('migrates deprecated model references without changing custom IDs or current overrides', () => {
    const native = {
      modelSettings: {
        'claude-sonnet-5-5': { effortLevel: 'medium' },
        'claude-sonnet-4-5-20250929': { effortLevel: 'high', autoCompactWindow: 300000 },
        'vendor.model': { effortLevel: 'high' },
      },
      fallbackModel: ['claude-sonnet-4-5', 'claude-sonnet-5-5', 'my-provider/deployment'],
      advisorModel: 'claude-opus-4-1-20250805',
      availableModels: ['claude-sonnet-4-5-20250929', 'opus'],
      modelPicker: { options: [{ model: 'claude-3-7-sonnet-20250219', behavesAs: 'claude-sonnet-4-5' }] },
      modelOverrides: { 'claude-sonnet-4-5': 'my-provider/deployment' },
      env: { ANTHROPIC_MODEL: 'claude-sonnet-4-5[1m]', CUSTOM: 'claude-sonnet-4-5' },
      hooks: { Stop: [{ hooks: [{ type: 'prompt', prompt: 'Check', model: 'claude-3-5-haiku-20241022' }] }] },
    };
    const result = normalizeClaudeNativeSettings(native);
    expect(result).toMatchObject({
      modelSettings: {
        'claude-sonnet-5-5': { effortLevel: 'medium', autoCompactWindow: 300000 },
        'vendor.model': { effortLevel: 'high' },
      },
      fallbackModel: ['claude-sonnet-5-5', 'my-provider/deployment'],
      advisorModel: 'claude-opus-4-8',
      availableModels: ['claude-sonnet-5-5', 'opus'],
      modelPicker: { options: [{ model: 'claude-sonnet-5-5', behavesAs: 'claude-sonnet-5-5' }] },
      modelOverrides: { 'claude-sonnet-5-5': 'my-provider/deployment' },
      env: { ANTHROPIC_MODEL: 'claude-sonnet-5-5[1m]', CUSTOM: 'claude-sonnet-4-5' },
      hooks: { Stop: [{ hooks: [{ model: 'claude-haiku-4-5-20251001' }] }] },
    });
    expect(result.modelSettings).not.toHaveProperty('claude-sonnet-4-5-20250929');
    expect(native.modelSettings).toHaveProperty('claude-sonnet-4-5-20250929');
    expect(normalizeClaudeNativeSettings(result)).toEqual(result);
    expect(JSON.parse(new ClientConfigService({} as never).render({ native_settings: native }, 'claude').content)).toMatchObject(result);
  });

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


  it.each([
    ['claude-sonnet-4-6', 'xhigh'], ['claude-opus-4-6', 'xhigh'], ['claude-sonnet-4-6[1m]', 'xhigh'],
    ['claude-haiku-4-5-20251001', 'low'], ['claude-opus-4-5-20251101', 'high'],
    ['claude-opus-5-5', 'max'], ['claude-opus-5-5', 'ultracode'],
  ])('rejects incompatible persisted effort for %s: %s', (model, effortLevel) => {
    expect(() => normalizeClaudeNativeSettings({ modelSettings: { [model]: { effortLevel } } })).toThrow(`native_settings.modelSettings.${model}.effortLevel`);
  });

  it('allows per-model persistent levels and separate session caps', () => {
    const native = { ultracode: true, modelSettings: {
      'claude-haiku-5-5': { effortLevel: 'xhigh', maxEffortLevel: 'max' },
      'claude-opus-4-6': { effortLevel: 'high', maxEffortLevel: 'max' },
      'claude-sonnet-4-6': { effortLevel: 'medium', maxEffortLevel: 'max' },
    } };
    expect(normalizeClaudeNativeSettings(native)).toEqual(native);
    expect(() => normalizeClaudeNativeSettings({ modelSettings: { 'claude-sonnet-4-6': { maxEffortLevel: 'xhigh' } } })).toThrow('maxEffortLevel');
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
    const beforeInvalid = structuredClone(row);
    await expect(service.store({ settings: { native_settings: { voice: { enabld: true } } } }, null, 'claude'))
      .rejects.toThrow('native_settings.voice.enabld');
    expect(row).toEqual(beforeInvalid);
    expect(await service.adminFetch('claude')).toEqual(first);
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
      host: { claudeClientVersion: '2.1.296', claudeWrapperVersion: '0.9.65' } as never,
      settings: { native_settings: { enabledPlugins: { 'review@fleet.example': true } } },
      baseUrl: null,
      apiKey: null,
    };
    expect(() => renderClaudeSettingsPartialForHost(opts)).toThrow('require cxx 0.9.66');
    expect(() => renderClaudeSettingsPartialForHost({ ...opts, host: { claudeClientVersion: '2.1.296', claudeWrapperVersion: '0.9.66' } as never })).not.toThrow();
    expect(() => renderClaudeSettingsPartialForHost({ ...opts, settings: { native_settings: { language: 'german' } } })).not.toThrow();
  });
});
