import { describe, expect, it } from 'vitest';
import { ClientConfigService, renderTomlForHost } from '../../../src/services/client-config.js';
import { normalizeGrokNativeSettings } from '../../../src/services/grok-native-settings.js';
import { assertNativeConfigSupport } from '../../../src/services/native-config-support.js';
import { createDbFake } from '../../helpers/db-fake.js';
import { clientConfigDocuments } from '../../../src/db/schema.js';

const additions = {
  keys: { vim: 'nav' }, diagnostics: { error_reporting: false }, endpoints: { web_base_url: 'https://example.invalid' },
  features: { ask_answer_rows: false, cursor_marketplace: false, subagent_bundle: false, workflow_conversion: false, workspace_dashboard: false, worktree_inherits_main_approvals: false },
  memory_v2: { daily_token_cap: 1000000 }, model: { 'custom.with.dot': { vision: false, compaction_at_tokens: true, compactions_remaining: 255 } },
  hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo', args: ['--background', 'login'] }] }] },
  toolset: { image_gen: { base_url: 'https://image.invalid', env_key: ['IMAGE_KEY'] }, video_gen: { base_url: 'https://video.invalid', env_key: 'VIDEO_KEY' } },
  ui: { notifications: { program_status: { mode: 'off', query: false, children: false } } },
};
describe('Grok 1.0.70 native defaults', () => {
  it('stores, reads, renders, updates and removes the complete addition set', async () => {
    const db = createDbFake(), configs = new ClientConfigService(db as never);
    const save = async (native_settings: unknown) => {
      const stored = await configs.store({ settings: { native_settings } }, null, 'grok');
      db.tables.get(clientConfigDocuments)!.sort((a, b) => Number(b.id) - Number(a.id));
      const fetched = await configs.adminFetch('grok');
      expect(fetched.settings?.native_settings).toEqual(native_settings);
      const rendered = renderTomlForHost({ engine: 'grok', settings: fetched.settings, host: { grokClientVersion: '1.0.70', grokWrapperVersion: '0.9.136' } as never, baseUrl: null, apiKey: null });
      expect(rendered.content).toBe(stored.content);
      return rendered;
    };
    const added = await save(additions);
    expect(added.content).toContain('args = ["--background", "login"]');
    expect(added.owned_paths).toContain('model.custom.with.dot.vision');
    expect(added.owned_paths).toContain('ui.notifications.program_status.children');
    expect((await save({ ...additions, keys: { vim: 'off' } })).content).toContain('vim = "off"');
    const removed = await save({});
    expect(removed.content).not.toContain('program_status');
    expect(removed.owned_paths).not.toContain('keys.vim');
  });
  it.each(['auto', 'on', 'off'])('preserves program-status string form %s', mode => {
    expect(normalizeGrokNativeSettings({ ui: { notifications: { program_status: mode } } })).toEqual({ ui: { notifications: { program_status: mode } } });
  });
  it.each([
    [{ keys: { vim: 'insert' } }, 'expected =off'], [{ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo', args: 'bad' }] }] } }, 'expected string[]'],
    [{ ui: { simple_mode: false } }, 'retired'], [{ memory_v2: { compact_index_enabled: false } }, 'retired'],
    [{ ui: { vim_mode: false } }, 'keys.vim'], [{ ui: { collapsed_edit_blocks: false } }, 'ui.tool_call_density'],
    [{ ui: { group_tool_verbs: false } }, 'ui.tool_call_density'], [{ experiments: [] }, 'per-machine rollout'],
    [{ worker: { auto_start: false } }, 'independent Cursor worker'], [{ cursor_worker: {} }, 'independent Cursor worker'],
    [{ model: { custom: { compaction_at_tokens: {} } } }, 'expected boolean'], [{ model: { custom: { compactions_remaining: 256 } } }, '0–255'],
    [{ memory_v2: { daily_token_cap: 999999 } }, '1000000'], [{ ui: { notifications: { program_status: { typo: false } } } }, 'unknown Grok setting'],
  ])('rejects ineffective, wrong-scope and malformed input %#', (value, error) => expect(() => normalizeGrokNativeSettings(value)).toThrow(error));
  it('accepts the documented compactions-remaining alias with its native range', () => {
    expect(normalizeGrokNativeSettings({ model: { custom: { send_compactions_remaining: false } } })).toEqual({ model: { custom: { send_compactions_remaining: false } } });
    expect(() => normalizeGrokNativeSettings({ model: { custom: { send_compactions_remaining: -1 } } })).toThrow('0–255');
  });
  it('does not inject native defaults', () => expect(normalizeGrokNativeSettings({})).toEqual({}));
});

describe('Grok exact conditional native version floors', () => {
  const check = (version: string | null, native_settings: unknown) => assertNativeConfigSupport({ native_settings }, { grokClientVersion: version } as never, 'grok');
  it.each([
    [{ keys: { vim: 'off' } }, '1.0.68'], [{ features: { worktree_inherits_main_approvals: false } }, '1.0.67'],
    [{ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo', args: [] }] }] } }, '1.0.63'],
    [{ ui: { notifications: { program_status: { children: false } } } }, '1.0.63'],
    [{ features: { ask_answer_rows: false } }, '1.0.70'], [{ diagnostics: { error_reporting: false } }, '1.0.70'],
    [{ endpoints: { web_base_url: '' } }, '1.0.70'], [{ model: { 'literal.dot': { vision: false } } }, '1.0.70'],
  ])('gates actual configured values including false/empty %#', (native, version) => {
    expect(() => check('1.0.50', native)).toThrow(`${version} or newer`);
    expect(() => check(null, native)).toThrow('unreported');
    expect(() => check(version, native)).not.toThrow();
  });
  it('ignores opaque map names and retains old settings at their floor', () => {
    expect(() => check('1.0.50', { ui: { theme: 'keys.vim' }, model: { 'features.ask_answer_rows': { temperature: 0.1 } } })).not.toThrow();
    expect(() => check(null, {})).not.toThrow();
  });
  it('refuses features.zdr_access_enabled on hosts whose CLI no longer has it, without blocking older or unreported hosts', () => {
    const zdr = { features: { zdr_access_enabled: true } };
    expect(() => check('1.0.50', zdr)).not.toThrow();
    expect(() => check('1.0.63', zdr)).not.toThrow();
    expect(() => check(null, zdr)).not.toThrow();
    expect(() => check('1.0.64', zdr)).toThrow('features.zdr_access_enabled was removed in Grok Build 1.0.64; observed 1.0.64');
    expect(() => check('grok 1.0.70', { features: { zdr_access_enabled: false } })).toThrow('maximum_version = "1.0.63"');
    // A layer limited to older clients is skipped by newer hosts, exactly as native does.
    const layered = { version_overrides: [{ maximum_version: '1.0.63', features: { zdr_access_enabled: true } }] };
    expect(() => check('1.0.70', layered)).not.toThrow();
    expect(() => check('1.0.50', layered)).not.toThrow();
    expect(() => check('1.0.70', { version_overrides: [{ minimum_version: '1.0.60', features: { zdr_access_enabled: true } }] })).toThrow('removed in Grok Build 1.0.64');
  });
  it('checks applicable version patches while allowing older hosts to skip future layers', () => {
    expect(() => check('1.0.50', { version_overrides: [{ minimum_version: '1.0.68', keys: { vim: 'off' } }] })).not.toThrow();
    expect(() => check('1.0.67', { version_overrides: [{ maximum_version: '1.0.67', keys: { vim: 'off' } }] })).toThrow('1.0.68');
    expect(() => check('1.0.70', additions)).not.toThrow();
  });
});
