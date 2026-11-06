import { describe, expect, it } from 'vitest';
import { ClientConfigService, renderTomlForHost } from '../../../src/services/client-config.js';
import { normalizeGrokNativeSettings } from '../../../src/services/grok-native-settings.js';
import { assertNativeConfigSupport } from '../../../src/services/native-config-support.js';
import { createDbFake } from '../../helpers/db-fake.js';
import { clientConfigDocuments } from '../../../src/db/schema.js';

const additions = {
  keys: { vim: 'all' },
  features: { send_feedback_tool: false, request_compression: false, resume_pagination: true, daemon_feedback_drafts: false },
  ui: { single_ctrl_c_quit: true, multiline_default: false, at_picker_outside_workspace: false, kitty_keyboard: 'query' },
  managed_mcps: { allow_external_auth: false },
  model: { 'custom.with.dot': { interjection_reply_nudge: false } },
  workflows: { runtime: 'node' },
  hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'guard', failClosed: true }] }] },
};

describe('Grok 1.0.77 native defaults', () => {
  it('stores, reads, renders, updates and removes the complete addition set', async () => {
    const db = createDbFake(), configs = new ClientConfigService(db as never);
    const save = async (native_settings: unknown) => {
      const stored = await configs.store({ settings: { native_settings } }, null, 'grok');
      db.tables.get(clientConfigDocuments)!.sort((a, b) => Number(b.id) - Number(a.id));
      const fetched = await configs.adminFetch('grok');
      expect(fetched.settings?.native_settings).toEqual(native_settings);
      const rendered = renderTomlForHost({ engine: 'grok', settings: fetched.settings, host: { grokClientVersion: '1.0.77', grokWrapperVersion: '0.9.136' } as never, baseUrl: null, apiKey: null });
      expect(rendered.content).toBe(stored.content);
      return rendered;
    };
    const added = await save(additions);
    for (const line of ['vim = "all"', 'kitty_keyboard = "query"', 'runtime = "node"', 'single_ctrl_c_quit = true',
      'allow_external_auth = false', 'daemon_feedback_drafts = false', 'interjection_reply_nudge = false', 'failClosed = true']) {
      expect(added.content).toContain(line);
    }
    expect(added.owned_paths).toEqual(expect.arrayContaining([
      'keys.vim', 'features.send_feedback_tool', 'features.request_compression', 'features.resume_pagination',
      'features.daemon_feedback_drafts', 'ui.single_ctrl_c_quit', 'ui.multiline_default', 'ui.at_picker_outside_workspace',
      'ui.kitty_keyboard', 'managed_mcps.allow_external_auth', 'workflows.runtime', 'model.custom.with.dot.interjection_reply_nudge',
    ]));
    const updated = await save({ ...additions, ui: { ...additions.ui, kitty_keyboard: 'auto' }, workflows: { runtime: 'deno' } });
    expect(updated.content).toContain('kitty_keyboard = "auto"');
    expect(updated.content).toContain('runtime = "deno"');
    const removed = await save({});
    expect(removed.content).not.toContain('kitty_keyboard');
    expect(removed.owned_paths).not.toContain('workflows.runtime');
  });

  it.each([
    [{ ui: { kitty_keyboard: 'on' } }, 'native_settings.ui.kitty_keyboard: expected =auto or =query'],
    [{ workflows: { runtime: 'bun' } }, 'native_settings.workflows.runtime: expected =node or =deno'],
    [{ keys: { vim: 'insert' } }, 'native_settings.keys.vim: expected =off or =nav or =all'],
    [{ ui: { single_ctrl_c_quit: 'yes' } }, 'native_settings.ui.single_ctrl_c_quit: expected boolean'],
    [{ managed_mcps: { allow_external_auth: 1 } }, 'native_settings.managed_mcps.allow_external_auth: expected boolean'],
    [{ model: { custom: { interjection_reply_nudge: 'off' } } }, 'native_settings.model.custom.interjection_reply_nudge: expected boolean'],
    [{ hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: 'x', failClosed: 'true' }] }] } }, 'failClosed: expected boolean'],
    [{ hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: 'x', fail_closed: true }] }] } }, 'fail_closed: use failClosed'],
    [{ hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'x', onFailure: 'block' }] }] } }, 'onFailure: use failClosed'],
  ])('rejects wrong types, enums and alternate hook spellings with the setting path %#', (value, error) => {
    expect(() => normalizeGrokNativeSettings(value)).toThrow(error);
  });

  it.each([
    [{ cli: { channels: { nightly: { binary: 'grok', sources: [{ url: 'https://example.invalid', auth: 'anonymous' }] } } } }],
    [{ cli: { channels: {} } }],
    [{ version_overrides: [{ minimum_version: '1.0.71', cli: { channels: { nightly: { binary: 'grok' } } } }] }],
  ])('rejects custom update channels as fleet-owned updater policy %#', value => {
    expect(() => normalizeGrokNativeSettings(value)).toThrow('native_settings.cli.channels: updates are owned by the fleet version policy; managed launches never run the native updater');
  });

  it.each([
    [{ cursor_worker: { engine: 'typescript' } }, 'independent Cursor worker'],
    [{ cursor_worker: { any_repo: true } }, 'independent Cursor worker'],
    [{ experiments: { enabled: false } }, 'per-machine rollout'],
    [{ features: { writeback: false } }, 'unknown Grok setting'],
    [{ features: { image_edit: false } }, 'unknown Grok setting'],
    [{ fail_closed: true }, 'unknown Grok setting'],
    [{ ui: { disable_bypass_permissions_mode: true } }, 'unknown Grok setting'],
    [{ allow_hosted_models: ['grok-4.7'] }, 'unknown Grok setting'],
  ])('keeps requirements-only and worker keys rejected %#', (value, error) => {
    expect(() => normalizeGrokNativeSettings(value)).toThrow(error);
  });
});

describe('Grok 1.0.71–1.0.77 version floors', () => {
  const check = (version: string | null, native_settings: unknown) => assertNativeConfigSupport({ native_settings }, { grokClientVersion: version } as never, 'grok');
  it.each([
    [{ features: { send_feedback_tool: false } }, '1.0.71'], [{ ui: { single_ctrl_c_quit: false } }, '1.0.71'],
    [{ keys: { vim: 'all' } }, '1.0.71'],
    [{ hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: 'x', failClosed: false }] }] } }, '1.0.71'],
    [{ managed_mcps: { allow_external_auth: false } }, '1.0.73'], [{ ui: { multiline_default: false } }, '1.0.73'],
    [{ features: { request_compression: false } }, '1.0.74'], [{ features: { resume_pagination: false } }, '1.0.74'],
    [{ model: { 'literal.dot': { interjection_reply_nudge: false } } }, '1.0.74'],
    [{ ui: { at_picker_outside_workspace: false } }, '1.0.74'], [{ workflows: { runtime: 'deno' } }, '1.0.74'],
    [{ features: { daemon_feedback_drafts: false } }, '1.0.76'], [{ ui: { kitty_keyboard: 'auto' } }, '1.0.77'],
  ])('requires the first release that reads the setting, including false values %#', (native, version) => {
    const previous = `1.0.${Number(version.split('.')[2]) - 1}`;
    expect(() => check(previous, native)).toThrow(`grok native settings require CLI ${version} or newer; observed ${previous}`);
    expect(() => check(null, native)).toThrow('unreported');
    expect(() => check(version, native)).not.toThrow();
  });
  it('keeps nav/off Vim keys at 1.0.68 and skips future layers on older hosts', () => {
    expect(() => check('1.0.68', { keys: { vim: 'nav' } })).not.toThrow();
    expect(() => check('1.0.70', { keys: { vim: 'all' } })).toThrow('1.0.71 or newer');
    expect(() => check('1.0.70', { version_overrides: [{ minimum_version: '1.0.77', ui: { kitty_keyboard: 'query' } }] })).not.toThrow();
    expect(() => check('1.0.76', { version_overrides: [{ maximum_version: '1.0.76', ui: { kitty_keyboard: 'query' } }] })).toThrow('1.0.77');
    expect(() => check('1.0.77', additions)).not.toThrow();
    expect(() => check('1.0.76', additions)).toThrow('1.0.77 or newer');
  });
});
