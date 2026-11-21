import { describe, expect, it } from 'vitest';
import { normalizeSettings } from '../../../src/services/config-normalizer.js';
import {
  ClientConfigService,
  renderClaudeSettingsPartial,
  renderClaudeSettingsPartialForHost,
} from '../../../src/services/client-config.js';
import { normalizeClaudeNativeSettings } from '../../../src/services/claude-native-settings.js';

const normalize = (native: Record<string, unknown>) =>
  normalizeSettings({ native_settings: native }, { applyCodexDefaults: false, engine: 'claude' });
const mcpHook = (extra: Record<string, unknown> = {}) => ({
  hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'mcp_tool', server: 'policy.server', tool: 'check', ...extra }] }] },
});
const forHost = (version: string | null, native: Record<string, unknown>) =>
  renderClaudeSettingsPartialForHost({
    host: { claudeClientVersion: version, claudeWrapperVersion: '0.9.181' } as never,
    settings: normalize(native), baseUrl: null, apiKey: null,
  });

it('explains why the Claude 2.1.330 enterprise sign-in rule cannot be written in user settings', () => {
  expect(() => normalizeClaudeNativeSettings({ enforceAnthropicSignIn: true })).toThrow(/enforceAnthropicSignIn.*requires native managed settings/);
});

describe('Claude 2.1.328 mcp_tool hook onFailure', () => {
  it.each(['continue', 'block'])('accepts onFailure=%s and keeps it through normalization', onFailure => {
    const native = mcpHook({ onFailure, input: { path: '${file}' } });
    expect(normalizeClaudeNativeSettings(native)).toEqual(native);
    expect(normalize(native).native_settings).toEqual(native);
  });

  it.each(['warn', 'Block', '', true, 1, null, {}])('rejects invalid onFailure=%j at the exact path', onFailure => {
    const path = 'native_settings.hooks.PreToolUse.0.hooks.0.onFailure';
    expect(() => normalizeClaudeNativeSettings(mcpHook({ onFailure }))).toThrow(path);
    expect(() => new ClientConfigService({} as never).render({ native_settings: mcpHook({ onFailure }) }, 'claude')).toThrow(path);
  });

  it('keeps command and http onFailure behaviour unchanged', () => {
    const native = { hooks: { PostToolUse: [{ hooks: [
      { type: 'command', command: 'test', onFailure: 'block' },
      { type: 'http', url: 'https://example.com', onFailure: 'continue' },
    ] }] } };
    expect(normalizeClaudeNativeSettings(native)).toEqual(native);
    expect(() => normalizeClaudeNativeSettings({ hooks: { PostToolUse: [{ hooks: [{ type: 'command', command: 'x', onFailure: 'warn' }] }] } }))
      .toThrow('onFailure');
    expect(() => normalizeClaudeNativeSettings({ hooks: { PostToolUse: [{ hooks: [{ type: 'prompt', prompt: 'x', onFailure: 'block' }] }] } }))
      .toThrow('onFailure');
    // No 2.1.328 gate for command/http hooks: an older observed CLI still renders them.
    expect(forHost('2.1.327', native).partial).toMatchObject(native);
  });

  it.each(['block', 'continue'])('gates onFailure=%s on observed CLI 2.1.328', onFailure => {
    const native = mcpHook({ onFailure });
    expect(() => forHost(null, native)).toThrow(/2\.1\.328.*observed unreported/);
    expect(() => forHost('2.1.327', native)).toThrow(/2\.1\.328.*observed 2\.1\.327.*clx update/);
    expect(forHost('2.1.328', native).partial).toMatchObject(native);
    expect(forHost('2.1.329 (Claude Code)', native).partial).toMatchObject(native);
  });

  it('leaves mcp_tool hooks without onFailure on the existing floor', () => {
    const plain = mcpHook();
    expect(forHost('2.1.327', plain).partial).toMatchObject(plain);
    expect(() => forHost('2.1.295', plain)).toThrow(/2\.1\.296/);
  });

  it('does not gate the host-less preview or admin partial', () => {
    const settings = normalize(mcpHook({ onFailure: 'block' }));
    const preview = new ClientConfigService({} as never).render(settings, 'claude');
    expect(JSON.parse(preview.content)).toMatchObject(mcpHook({ onFailure: 'block' }));
    expect(renderClaudeSettingsPartial(settings).partial).toMatchObject(mcpHook({ onFailure: 'block' }));
  });

  it('round-trips store, preview and host render, and removal drops the owned hooks', async () => {
    let row: Record<string, unknown> | undefined;
    let id = 0;
    const query = {
      from: () => query, where: () => query, orderBy: () => query,
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
    const native = mcpHook({ onFailure: 'block' });
    await service.store({ settings: { native_settings: native } }, null, 'claude');
    const fetched = await service.adminFetch('claude');
    expect(fetched.settings?.native_settings).toEqual(native);
    expect(JSON.parse(fetched.content!)).toMatchObject(native);
    const rendered = forHost('2.1.328', fetched.settings!.native_settings as Record<string, unknown>);
    expect(rendered.partial).toMatchObject(native);
    expect(rendered.owned_paths).toContain('hooks.PreToolUse');

    await service.store({ settings: { native_settings: { language: 'german' } } }, null, 'claude');
    const removed = await service.adminFetch('claude');
    expect(removed.settings?.native_settings).toEqual({ language: 'german' });
    const after = forHost('2.1.327', removed.settings!.native_settings as Record<string, unknown>);
    expect(after.partial).not.toHaveProperty('hooks');
    expect(after.owned_paths).not.toContain('hooks.PreToolUse');
  });
});
