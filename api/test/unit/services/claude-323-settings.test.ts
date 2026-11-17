import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { normalizeSettings } from '../../../src/services/config-normalizer.js';
import {
  ClientConfigService,
  renderClaudeSettingsPartial,
  renderClaudeSettingsPartialForHost,
} from '../../../src/services/client-config.js';
import {
  normalizeClaudeNativeSettings,
  normalizeStoredClaudeNativeSettings,
} from '../../../src/services/claude-native-settings.js';
import {
  CLAUDE_MANAGED_ONLY_SETTINGS,
  CLAUDE_NATIVE_SETTING_RULES,
} from '../../../src/services/claude-native-settings-catalog.js';

describe('Claude 2.1.323 retired and Desktop-only settings', () => {
  it.each([{ type: 'command', command: 'must-not-run' }, false, null, 'old'])(
    'rejects new removed subagentStatusLine input %j',
    (value) => {
      const raw = { native_settings: { subagentStatusLine: value } };
      expect(() => normalizeClaudeNativeSettings(raw.native_settings)).toThrow(
        'Removed in Claude Code 2.1.323',
      );
      expect(() => new ClientConfigService({} as never).render(raw, 'claude')).toThrow(
        'native_settings.subagentStatusLine',
      );
    },
  );

  it('removes only the actual historical native root leaf and does not mutate input', () => {
    const raw = {
      subagentStatusLine: { type: 'command', command: 'must-not-run' },
      statusLine: { type: 'command', command: 'keep' },
      env: { subagentStatusLine: 'literal', 'native_settings.subagentStatusLine': 'dotted' },
      pluginConfigs: { 'subagentStatusLine.with.dots': { options: { subagentStatusLine: 'opaque' } } },
    };
    const before = structuredClone(raw);
    const healed = normalizeStoredClaudeNativeSettings(raw);
    expect(healed).toEqual({ statusLine: raw.statusLine, env: raw.env, pluginConfigs: raw.pluginConfigs });
    expect(raw).toEqual(before);
    expect(normalizeStoredClaudeNativeSettings(healed)).toEqual(healed);
    const settings = normalizeSettings(
      { native_settings: raw },
      { engine: 'claude', applyCodexDefaults: false },
    );
    const rendered = renderClaudeSettingsPartial(settings);
    expect(rendered.partial).not.toHaveProperty('subagentStatusLine');
    expect(rendered.partial).toMatchObject(healed);
    expect(rendered.owned_paths).not.toContain('subagentStatusLine');
    expect(rendered.owned_paths).toContain('statusLine.command');
    expect(rendered.owned_paths).toContain('json:["env","native_settings.subagentStatusLine"]');
    const host = renderClaudeSettingsPartialForHost({
      host: { claudeClientVersion: '2.1.326', claudeWrapperVersion: '0.9.181' } as never,
      settings,
      baseUrl: null,
      apiKey: null,
    });
    expect(host.partial).toMatchObject(healed);
    expect(host.owned_paths).not.toContain('subagentStatusLine');
  });

  it('keeps unrelated invalid stored input available for a precise correction', () => {
    expect(() => normalizeStoredClaudeNativeSettings({ subagentStatusLine: {}, language: false })).toThrow(
      'native_settings.language',
    );
    expect(() =>
      normalizeStoredClaudeNativeSettings({ subagentStatusLine: {}, unknownSetting: true }),
    ).toThrow('native_settings.unknownSetting');
  });

  it('reads healed settings while preserving the exact historical revision body and hash', async () => {
    const body = '{"subagentStatusLine":{"type":"command","command":"old"}}';
    const sha = createHash('sha256').update(body).digest('hex');
    const row = {
      id: 9,
      engine: 'claude',
      settings: {
        native_settings: { subagentStatusLine: { type: 'command', command: 'old' }, language: 'german' },
      },
      body,
      sha256: sha,
      updatedAt: '2026-11-01T00:00:00Z',
    };
    const query = { from: () => query, where: () => query, orderBy: () => query, limit: async () => [row] };
    const result = await new ClientConfigService({ select: () => query } as never).adminFetch('claude');
    expect(result.validation_error).toBeUndefined();
    expect(result.settings?.native_settings).toEqual({ language: 'german' });
    expect(result).toMatchObject({ revision: '9', content: body, sha256: sha, updated_at: row.updatedAt });
    expect(row.settings.native_settings).toHaveProperty('subagentStatusLine');
    Object.assign(row.settings.native_settings, { unknownFutureField: true });
    const invalid = await new ClientConfigService({ select: () => query } as never).adminFetch('claude');
    expect(invalid.validation_error?.param).toBe('native_settings.unknownFutureField');
    expect(invalid.settings).toEqual(row.settings);
    expect(invalid).toMatchObject({ revision: '9', content: body, sha256: sha });
  });

  it.each([true, false])('diagnoses Desktop managed policy even when set to %s', (value) => {
    expect(() => normalizeClaudeNativeSettings({ disableRemotePreviewScripts: value })).toThrow(
      'Desktop managed settings',
    );
    expect(() =>
      new ClientConfigService({} as never).render(
        { native_settings: { disableRemotePreviewScripts: value } },
        'claude',
      ),
    ).toThrow('SSH/WSL');
    expect(CLAUDE_MANAGED_ONLY_SETTINGS).toContain('disableRemotePreviewScripts');
    expect(CLAUDE_NATIVE_SETTING_RULES).not.toHaveProperty('disableRemotePreviewScripts');
    expect(CLAUDE_NATIVE_SETTING_RULES).not.toHaveProperty('subagentStatusLine');
  });
});
