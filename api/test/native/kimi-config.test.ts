import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { ClientConfigService } from '../../src/services/client-config.js';
// Explicit opt-in: verified provider binaries only, no installed/user auth or inference.
const binaries = [process.env.TEST_KIMI_NATIVE_BINARY, process.env.TEST_KIMI_BASELINE_BINARY].filter((value): value is string => !!value);
describe.skipIf(!binaries.length)('native Kimi config doctor oracle', () => {
  it.each(binaries)('validates rendered TOML and rejects invalid types without executing a hook: %s', binary => {
    const home = mkdtempSync(join(tmpdir(), 'kimi-settings-oracle-'));
    try {
      const codeHome = join(home, 'kimi');
      mkdirSync(codeHome);
      const config = join(home, 'config.toml');
      const marker = join(home, 'NEVER_EXECUTE');
      const rendered = new ClientConfigService({} as never).render({ native_settings: {
        model_catalog: { refresh_on_start: false }, default_provider: 'custom.provider',
        providers: { 'custom.provider': { type: 'openai', custom_headers: { 'X.Literal': 'yes' } } },
        thinking: { enabled: false }, loop_control: { max_attempts_per_step: 0, compaction_trigger_ratio: 0.5 },
        hooks: [{ event: 'Stop', command: `touch '${marker}'`, timeout: 1 }],
      } }, 'kimi');
      const fixtures = [
        { body: rendered.content, exit: 0 },
        { body: 'default_plan_mode = "yes"', exit: 1 },
        { body: '[thinking]\nenabled = "yes"', exit: 1 },
        { body: '[loop_control]\nmax_attempts_per_step = -1', exit: 1 },
        { body: `[[hooks]]\nevent = "NotReal"\ncommand = "touch '${marker}'"\ntimeout = 0`, exit: 1 },
      ];
      for (const fixture of fixtures) {
        writeFileSync(config, fixture.body);
        const result = spawnSync(resolve(binary), ['doctor', 'config', config], {
          cwd: home, env: { PATH: process.env.PATH, HOME: home, KIMI_CODE_HOME: codeHome, XDG_CONFIG_HOME: join(home, 'xdg'), LANG: 'C.UTF-8' },
          encoding: 'utf8', timeout: 20_000,
        });
        expect(result.error, result.stderr).toBeUndefined();
        expect(result.status, result.stderr).toBe(fixture.exit);
        if (fixture.exit === 0) {
          // Doctor omits these SDK/TUI domains from its core-only inventory.
          // Their actual config mapper and product consumers are documented.
          const ignored = `${result.stdout}\n${result.stderr}`.match(/Unknown top-level keys ignored by the v2 engine: ([^\n]+)/)?.[1];
          if (ignored) expect(ignored.replace(/\.$/, '').split(', ').sort()).toEqual(['auto_session_title', 'disable_feedback_survey']);
        }
        expect(existsSync(marker)).toBe(false);
      }
    } finally { rmSync(home, { recursive: true, force: true }); }
  }, 60_000);
});
