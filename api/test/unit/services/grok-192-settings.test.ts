import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { normalizeGrokNativeSettings, grokNativeOwnedPaths } from '../../../src/services/grok-native-settings.js';
import { renderTomlForHost } from '../../../src/services/client-config.js';

const render = (version: string | null, native_settings: Record<string, unknown>) => renderTomlForHost({
  engine: 'grok', settings: { native_settings }, host: { grokClientVersion: version, grokWrapperVersion: '0.9.192' } as never,
  baseUrl: null, apiKey: null,
});

describe('Grok 1.0.90–1.0.92 observed-version configuration', () => {
  it.each([
    { auto_mode: { classifier_model: 'fixture', classify_timeout_ms: 500, prompt_type: 'just_command', reasoning_effort: 'max' } },
    { model: { 'fixture.with.dots': { supports_reasoning_text_replay: false } } },
  ])('gates classifier and replay fields at 1.0.90', native => {
    expect(normalizeGrokNativeSettings(native)).toEqual(native);
    expect(() => render('1.0.89', native)).toThrow(/1\.0\.90/);
    expect(() => render(null, native)).toThrow(/unreported/);
    expect(render('1.0.90', native).content).toMatch(/classify_timeout_ms = 500|supports_reasoning_text_replay = false/);
  });

  it('preserves zero and false at the native consumer boundary', () => {
    const native = { features: { wrap_image_relay: false }, models: { headless_retry_deadline_secs: 0 } };
    expect(normalizeGrokNativeSettings(native)).toEqual(native);
    expect(() => render('1.0.91', native)).toThrow(/1\.0\.92/);
    const value = render('1.0.92', native);
    expect(value.content).toContain('headless_retry_deadline_secs = 0');
    expect(value.content).toContain('wrap_image_relay = false');
    expect(value.owned_paths).toEqual(expect.arrayContaining(grokNativeOwnedPaths(native)));
    expect(render('1.0.92', {}).content).not.toContain('headless_retry_deadline_secs');
  });

  it.each([-1, 0.5, '5', Number.MAX_SAFE_INTEGER + 1])('refuses an invalid native unsigned timer %s', value => {
    for (const native of [{ models: { headless_retry_deadline_secs: value } }, { auto_mode: { classify_timeout_ms: value } }]) {
      expect(() => normalizeGrokNativeSettings(native)).toThrow(/integer/);
    }
  });

  it('retains older dashboard values only in active compatible layers', () => {
    for (const native of [{ dashboard: { grouping: 'state' } }, { features: { workspace_dashboard: false } }]) {
      expect(normalizeGrokNativeSettings(native)).toEqual(native);
      expect(() => render('1.0.89', native)).not.toThrow();
      expect(() => render('1.0.92', native)).toThrow(/removed in Grok Build 1\.0\.90/);
      const bounded = { version_overrides: [{ maximum_version: '1.0.89', ...native }] };
      expect(() => render('1.0.89', bounded)).not.toThrow();
      expect(() => render('1.0.92', bounded)).not.toThrow();
    }
  });

  it.skipIf(!process.env.GROK_NATIVE_TEST_BIN)('sends current host TOML to the real native offline inspector', () => {
    const native = {
      auto_mode: { classifier_model: 'fixture', classify_timeout_ms: 500, prompt_type: 'bare_instructions', reasoning_effort: 'low' },
      features: { wrap_image_relay: false }, models: { headless_retry_deadline_secs: 0 },
      model: { 'fixture.with.dots': { supports_reasoning_text_replay: false } },
      version_overrides: [{ maximum_version: '1.0.89', dashboard: { grouping: 'state' }, features: { workspace_dashboard: false } }],
    };
    const home = mkdtempSync(join(tmpdir(), 'grok-192-config-'));
    try {
      writeFileSync(join(home, 'config.toml'), render('1.0.92', native).content, { mode: 0o600 });
      const output = execFileSync(process.env.GROK_NATIVE_TEST_BIN!, ['--no-leader', 'inspect', '--json'], {
        cwd: home, env: { HOME: home, GROK_HOME: home, GROK_NO_AUTO_UPDATE: '1', PATH: '' }, timeout: 10000, encoding: 'utf8',
      });
      expect(JSON.parse(output).configWarnings ?? []).toEqual([]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('refuses shared daemon lifetime control, including conditional false', () => {
    const native = { features: { shared_daemon_keep_alive: false } };
    for (const input of [native, { version_overrides: [{ minimum_version: '1.0.91', ...native }] }]) {
      expect(() => normalizeGrokNativeSettings(input)).toThrow(/private leader/);
    }
  });
});
