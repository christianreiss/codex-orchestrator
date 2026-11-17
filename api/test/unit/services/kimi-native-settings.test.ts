import { describe, expect, it } from 'vitest';
import { normalizeKimiNativeSettings, migrateStoredKimiNativeSettings, kimiNativeOwnedPaths } from '../../../src/services/kimi-native-settings.js';
import { ClientConfigService, renderTomlForHost } from '../../../src/services/client-config.js';

const service = new ClientConfigService({} as never);
const invalid = [
  { default_plan_mode: 'yes' }, { default_permission_mode: false }, { telemetry: 'false' }, { extra_skill_dirs: [1] },
  { loop_control: { max_attempts_per_step: -1 } }, { loop_control: { max_steps_per_turn: 1.5 } }, { loop_control: { max_attempts_per_step: 9007199254740992 } },
  { loop_control: { max_ralph_iterations: -2 } }, { loop_control: { compaction_trigger_ratio: 0.49 } },
  { loop_control: { compaction_trigger_ratio: 1 } }, { loop_control: { compaction_max_attempts: 0 } },
  { thinking: { enabled: 'yes' } }, { thinking: { enabled: true, typo: false } }, { thinking: { forced_effort: 'high' } },
  { hooks: [{ event: 'NotReal', command: 'echo ok' }] }, { hooks: [{ event: 'Stop', command: '' }] },
  { hooks: [{ event: 'Stop', command: 'echo ok', timeout: 0 }] }, { hooks: [{ event: 'Stop', command: 'echo ok', timeout: 601 }] },
  { hooks: [{ event: 'Stop', command: 'echo ok', cwd: '/tmp' }] },
  { secondary_model: { force: true } }, { secondary_model: { max_output_size: 100 } },
  { loop_control: { max_retries_per_step: 10 } }, { loop_control: { max_steps_per_run: 10 } },
  { task: { max_running_tasks: 2 } }, { background: { max_running_tasks: 2 } }, { task: { print_max_turns: 0 } },
  { providers: { test: { custom_headers: { 'X-Header': false } } } }, { providers: { test: { model_source: 'bogus' } } },
  { providers: { test: { source: { malformed: null } } } }, { providers: { test: { source: { malformed: [null] } } } },
  { models: { 'a.b': { max_context_size: 0 } } }, { models: { 'a.b': { overrides: { provider: 'test' } } } },
  { mcp: { startup_timeout_ms: 2147483648 } }, { subagent: { timeout_ms: -1 } },
  { permission: { rules: [{ decision: 'maybe', pattern: 'Read' }] } },
  { permission: { rules: [{ decision: 'allow', pattern: 'Bash(' }] } },
  { permission: { rules: [{ decision: 'allow', pattern: 'Read', scope: 'session-runtime' }] } },
  { services: { unknown: { base_url: 'https://example.com' } } }, { cron: { disabled: true } },
  { token_counting: { strategy: 'bogus' } }, { model_catalog: { refresh_interval_ms: -1 } },
  { environments: { default: 'missing' } }, { environments: { local: { type: 'ssh', host: 'test' } } },
  { nativeTypo: true },
];

describe('Kimi native settings schema and retirements', () => {
  it.each(invalid)('rejects invalid or ignored authored fields: %j', input => {
    expect(() => normalizeKimiNativeSettings(input)).toThrow();
    expect(() => service.render({ native_settings: input }, 'kimi')).toThrow();
  });
  it('preserves real user defaults, exact map names, boundaries and absence without coercion', () => {
    const input = {
      default_provider: 'my.provider', default_plan_mode: false, extra_skill_dirs: ['/tmp/custom'],
      model_catalog: { refresh_on_start: false, refresh_interval_ms: 0 },
      loop_control: { max_attempts_per_step: 0, max_steps_per_turn: 0, max_ralph_iterations: -1, compaction_trigger_ratio: 0.99, compaction_max_attempts: 1 },
      secondary_model: { default_model: 'my.model', models: { 'my.model': '' }, default_effort: 'high' },
      providers: { 'my.provider': { type: 'openai', api_key_env: 'TEST_API_KEY', custom_headers: { 'X.Literal-Header': 'yes' }, env: { 'LITERAL.ENV': 'value' } } },
      models: { 'my.model': { provider: 'my.provider', model: 'my-model', max_context_size: 1000, overrides: { max_output_size: 5 } } },
      hooks: [{ event: 'Stop', command: 'false', timeout: 600 }],
      permission: { rules: [{ decision: 'allow', pattern: 'Bash(echo *)' }] },
      mcp: { startup_timeout_ms: 2147483647 }, background: { bash_task_timeout_s: 0 },
      environments: { box: { type: 'ssh', host: 'example', defaultCwd: '/tmp', remoteBin: '/bin/kimi' }, default: 'box' },
    };
    expect(normalizeKimiNativeSettings(input)).toEqual(input);
    expect(normalizeKimiNativeSettings({})).toEqual({});
    expect(kimiNativeOwnedPaths(input)).toContain('json:["providers","my.provider","custom_headers","X.Literal-Header"]');
    const rendered = service.render({ native_settings: input }, 'kimi');
    expect(rendered.content).toContain('[models."my.model".overrides]');
    expect(rendered.content).toContain('refresh_on_start = false');
    expect(rendered.content).toContain('remoteBin = "/bin/kimi"');
    expect(input.permission.rules[0]).not.toHaveProperty('scope');
  });
  it('heals exact stored legacy paths without overwriting explicit successors or unrelated data', () => {
    const input = { loop_control: { max_retries_per_step: 4, max_attempts_per_step: 8, max_steps_per_run: 0, reserved_context_size: 100 },
      secondary_model: { force: false, capabilities: ['thinking'], default_model: 'my.model', default_effort: 'high' },
      task: { max_running_tasks: 2, bash_task_timeout_s: 10 },
      models: { 'secondary_model.force': { model: 'literal', max_context_size: 123 } },
    };
    const expected = { loop_control: { max_attempts_per_step: 8, max_steps_per_turn: 0, reserved_context_size: 100 },
      secondary_model: { default_model: 'my.model', default_effort: 'high' }, task: { bash_task_timeout_s: 10 }, models: input.models };
    expect(migrateStoredKimiNativeSettings(input)).toEqual(expected);
    expect(migrateStoredKimiNativeSettings(expected)).toEqual(expected);
    expect(input.secondary_model.force).toBe(false);
    const rendered = renderTomlForHost({ settings: { native_settings: input }, engine: 'kimi', host: null, baseUrl: null, apiKey: null });
    expect(rendered.content).not.toContain('max_retries_per_step');
    expect(rendered.content).toContain('[models."secondary_model.force"]');
    expect(rendered.settings.native_settings).toEqual(expected);
  });
  it('retains invalid stored values and unknown siblings as actionable errors', () => {
    for (const input of [{ loop_control: { max_retries_per_step: 'bad' } }, { loop_control: { max_steps_per_run: -1 } }, { thinking: { unknown: true } }]) {
      expect(migrateStoredKimiNativeSettings(input)).toEqual(input);
      expect(() => renderTomlForHost({ settings: { native_settings: input }, engine: 'kimi', host: null, baseUrl: null, apiKey: null })).toThrow();
    }
  });
});

describe('Kimi native conditional capabilities', () => {
  const render = (version: string | null, native: unknown) => renderTomlForHost({ settings: { native_settings: native }, engine: 'kimi',
    host: { kimiClientVersion: version } as never, baseUrl: null, apiKey: null });
  it.each([{ providers: { example: { search_url: '' } } }, { providers: { example: { feedback_url: '' } } },
    { secondary_model: { default_model: 'primary', models: { primary: '' } } },
  ])('requires source-audited 2.6.2 for new semantics, including empty strings: %j', input => {
    expect(() => render('2.5.3', input)).toThrow(/2\.6\.2.*ckx update/);
    expect(() => render(null, input)).toThrow(/2\.6\.2.*unreported/);
    expect(() => render('not-a-version', input)).toThrow(/unreported/);
    expect(() => render('Kimi Code 2.6.2', input)).not.toThrow();
    expect(() => render('2.6.2', input)).not.toThrow();
    expect(() => render('2.6.3', input)).not.toThrow();
  });
  it('keeps 2.5.3 supported and treats map keys literally', () => {
    for (const input of [{ model_catalog: { refresh_on_start: false } }, { default_provider: 'search_url' },
      { providers: { 'feedback_url': { type: 'openai' } } }, { models: { primary: { model: 'literal' } } },
    ]) expect(() => render('2.5.3', input)).not.toThrow();
    expect(() => render('2.5.2', { watch: { enabled: false } })).toThrow(/2\.5\.3/);
  });
});
