import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import schema from '../../../src/services/codex-config-schema.json' with { type: 'json' };
import { ClientConfigService, renderTomlForHost } from '../../../src/services/client-config.js';
import { normalizeCodexNativeSettings } from '../../../src/services/codex-native-settings.js';
import { createDbFake } from '../../helpers/db-fake.js';

const native = (value: unknown, context = 'global', action = 'select_transcript') => ({ tui: { keymap: { [context]: { [action]: value } } } });
const accepted: Array<string | string[]> = ['ctrl-s', ' Control--ALT-shift-CMD--PAGEUP- ', 'ctrl-x ctrl-s', 'LEADER Return',
  'escape', 'spacebar', 'pgup', 'pgdn', 'pagedown', 'del', 'minus', 'alt-minus', 'f1', 'F24', 'f0001', 'f+1', 'f+024',
  'super-option-control-shift-a', '+', '?', 'x', 'ctrl-page--down', 'ctrl-x\u0085ctrl-s', '\u1680ctrl-s\u2000', [], ['ctrl-a', 'ctrl-x ctrl-s']];
const rejected = ['ctrl+s', 'invalid-key', '', ' \n\t', '-', '---', 'ctrl', 'ctrl-control-a', 'alt-option-x', 'cmd-super-x',
  'a-ctrl', 'page-shift-up', 'leader', 'leader leader', 'ctrl-x leader', 'a b c', 'ctrl - a', 'f0', 'f25', 'f256', 'f-1', 'f++1', 'f1.0',
  'é', 'İ', '\u007f', '\uFEFFctrl-s', 'ctrl-s\uFEFF', 'ctrl-a\u200bctrl-b'];
const field = 'tui.keymap.global.select_transcript';

describe('Codex native keybinding grammar', () => {
  it.each(accepted.map(value => [value]))('preserves valid spelling/alternatives and explicit unbinding: %j', value => {
    expect(normalizeCodexNativeSettings(native(value))).toEqual(native(value));
  });
  it.each(rejected)('rejects malformed bindings at root, profile, render and store: %j', async value => {
    const service = new ClientConfigService(createDbFake() as never);
    expect(() => normalizeCodexNativeSettings(native(value))).toThrow(field);
    expect(() => service.render({ native_settings: native(value) })).toThrow(field);
    expect(() => service.render({ profiles: [{ name: 'keys', native_settings: native(value) }] })).toThrow(field);
    await expect(service.store({ settings: { native_settings: native(value) } })).rejects.toMatchObject({ status: 422, param: expect.stringContaining(field) });
    await expect(service.store({ settings: { profiles: [{ name: 'keys', native_settings: native(value) }] } })).rejects.toMatchObject({ status: 422, param: expect.stringContaining(field) });
  });
  it('validates every schema KeybindingsSpec action, rather than only the new leaf', () => {
    const definitions = schema.definitions as unknown as Record<string, { properties?: Record<string, { allOf?: Array<{ $ref?: string }>; $ref?: string }> }>;
    for (const [context, contextShape] of Object.entries(definitions.TuiKeymap!.properties!)) {
      const name = contextShape.allOf![0]!.$ref!.split('/').at(-1)!;
      for (const action of Object.keys(definitions[name]!.properties!)) {
        expect(() => normalizeCodexNativeSettings(native('invalid-key', context, action))).toThrow(`tui.keymap.${context}.${action}`);
        expect(normalizeCodexNativeSettings(native([], context, action))).toEqual(native([], context, action));
      }
    }
  });
  it('reports malformed alternative indices and preserves old floors while gating explicit new unbinding', () => {
    expect(() => normalizeCodexNativeSettings(native(['ctrl-a', 'ctrl+s']))).toThrow(`${field}[1]`);
    for (const value of [[], 'ctrl-s']) for (const settings of [{ native_settings: native(value) }, { profiles: [{ name: 'keys', native_settings: native(value) }] }]) {
      expect(() => renderTomlForHost({ settings, host: { clientVersion: '0.165.0' } as never, baseUrl: null, apiKey: null })).toThrow(/0\.166\.0/);
      expect(() => renderTomlForHost({ settings, host: { clientVersion: '0.166.0' } as never, baseUrl: null, apiKey: null })).not.toThrow();
    }
    expect(() => renderTomlForHost({ settings: { native_settings: native([], 'global', 'open_transcript') }, host: { clientVersion: '0.162.1' } as never, baseUrl: null, apiKey: null })).not.toThrow();
  });
  it.skipIf(!process.env.CODEX_NATIVE_TEST_BIN)('matches pinned native 0.166 acceptance/rejection without sessions, inference or auth', () => {
    const home = mkdtempSync(join(tmpdir(), 'codex-keymap-parser-'));
    const env = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: join(home, 'home'), CODEX_HOME: home };
    mkdirSync(env.HOME);
    try {
      for (const [values, valid] of [[accepted, true], [rejected, false]] as const) for (const value of values) {
        writeFileSync(join(home, 'config.toml'), `[tui.keymap.global]\nselect_transcript = ${JSON.stringify(value)}\n`);
        const probe = spawnSync(process.env.CODEX_NATIVE_TEST_BIN!, ['features', 'list'], { env, encoding: 'utf8', timeout: 15000 });
        expect(probe.error).toBeUndefined();
        expect(probe.status === 0, `${JSON.stringify(value)}: ${probe.stderr}`).toBe(valid);
      }
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
});
