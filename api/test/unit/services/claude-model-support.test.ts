import { describe, expect, it } from 'vitest';
import { assertClaudeModelVersion, claudeModelMinimum } from '../../../src/services/claude-model-support.js';
import { CLAUDE_MODEL_MIN_CLI_VERSIONS, CLAUDE_SUPPORTED_MODELS } from '../../../src/services/claude-models.js';
import { modelDefaultsCatalog, modelLaunchCatalog, ModelDefaultsService } from '../../../src/services/model-defaults.js';
import { renderClaudeSettingsPartialForHost, renderTomlForHost } from '../../../src/services/client-config.js';
import { buildModelPolicy } from '../../../src/services/model-policy.js';
import { ENGINE_CLAUDE } from '../../../src/util/engine.js';
import { createDbFake } from '../../helpers/db-fake.js';

// code.claude.com/docs/en/model-config, checked 2026-10-28: "Sonnet 5.5 requires
// Claude Code v2.1.284 or later, and Opus 5.5 requires v2.1.280 or later." /
// "Use v2.1.293 or later with Haiku 5.5." / "Fable 5.1 requires Claude Code v2.1.257".
const DOCUMENTED = {
  'claude-fable-5-1': '2.1.257',
  'claude-opus-5-5': '2.1.280',
  'claude-sonnet-5-5': '2.1.284',
  'claude-haiku-5-5': '2.1.293',
};

const host = (version: string | null, override: string | null = null) =>
  ({ claudeClientVersion: version, claudeModelOverride: override, claudeReasoningEffortOverride: null }) as never;
const partial = (settings: unknown, version: string | null, override: string | null = null, policy?: ReturnType<typeof buildModelPolicy>) =>
  renderClaudeSettingsPartialForHost({ settings, host: host(version, override), baseUrl: null, apiKey: null, engine: ENGINE_CLAUDE, modelPolicy: policy });
const legacy = (settings: unknown, version: string | null, override: string | null = null) =>
  renderTomlForHost({ settings, host: host(version, override), baseUrl: null, apiKey: null, engine: ENGINE_CLAUDE });

describe('Claude native model compatibility', () => {
  it('records exactly the documented per-model CLI minimums', () => {
    expect(CLAUDE_MODEL_MIN_CLI_VERSIONS).toEqual(DOCUMENTED);
    for (const model of Object.keys(DOCUMENTED)) expect(CLAUDE_SUPPORTED_MODELS).toContain(model);
  });

  it.each([
    ['claude-sonnet-5-5', '2.1.283', '2.1.284'],
    ['claude-haiku-5-5', '2.1.292', '2.1.293'],
    ['claude-opus-5-5', '2.1.279', '2.1.280'],
    ['claude-fable-5-1', '2.1.256', '2.1.257'],
  ])('%s refuses %s and accepts %s', (model, below, at) => {
    expect(() => assertClaudeModelVersion(model, below)).toThrow(new RegExp(`${at.replace(/\./g, '\\.')}.*clx update`));
    expect(() => assertClaudeModelVersion(model, null)).toThrow(/unreported/);
    expect(() => assertClaudeModelVersion(model, `${at} (Claude Code)`)).not.toThrow();
    expect(() => assertClaudeModelVersion(`${model.toUpperCase()}[1m]`, below)).toThrow();
  });

  it('invents no minimum for older, alias, retired-migrated or custom ids', () => {
    for (const model of ['claude-sonnet-5', 'claude-opus-4-8', 'sonnet', 'opus', 'opusplan', 'vendor/claude-sonnet-5-5', '', null]) {
      expect(claudeModelMinimum(model)).toBeUndefined();
      expect(() => assertClaudeModelVersion(model, null)).not.toThrow();
    }
    // A retired id migrates to Sonnet 5.5 and therefore inherits its floor.
    expect(claudeModelMinimum('claude-3-5-sonnet-20241022')).toBe('2.1.284');
  });

  it('checks the effective host model on both Claude renders, but not unhosted fleet authoring', async () => {
    for (const render of [partial, legacy]) {
      expect(() => render({ model: 'claude-sonnet-5-5' }, '2.1.283')).toThrow(/2\.1\.284.*clx update/);
      expect(() => render({ model: 'claude-sonnet-5' }, '2.1.283', 'claude-haiku-5-5')).toThrow(/2\.1\.293/);
      expect(() => render({ model: 'claude-sonnet-5-5' }, '2.1.270', 'claude-sonnet-5')).not.toThrow();
      expect(() => render({ model: 'claude-sonnet-5-5' }, '2.1.284')).not.toThrow();
      expect(() => render({ model: 'claude-sonnet-5' }, null)).not.toThrow();
    }
    expect(() => renderClaudeSettingsPartialForHost({ settings: { model: 'claude-sonnet-5-5' }, host: null, baseUrl: null, apiKey: null, engine: ENGINE_CLAUDE })).not.toThrow();
    const defaults = new ModelDefaultsService(createDbFake() as never);
    await expect(defaults.set('claude', { model: 'claude-haiku-5-5' })).resolves.toMatchObject({ model: 'claude-haiku-5-5' });
  });

  it('checks the latest-family replacement the wrapper will launch', () => {
    const policy = buildModelPolicy('claude', true);
    expect(() => partial({ model: 'claude-sonnet-5' }, '2.1.283')).not.toThrow();
    expect(() => partial({ model: 'claude-sonnet-5' }, '2.1.283', null, policy)).toThrow(/claude-sonnet-5-5.*2\.1\.284/);
    expect(() => partial({ model: 'claude-sonnet-5' }, '2.1.284', null, policy)).not.toThrow();
  });

  it('advertises minimums and filters only incompatible signed host choices', () => {
    const catalog = modelDefaultsCatalog('claude');
    for (const [model, minimum] of Object.entries(DOCUMENTED)) expect(catalog.find(entry => entry.model === model)?.min_cli_version).toBe(minimum);
    expect(catalog.find(entry => entry.model === 'claude-sonnet-5')).not.toHaveProperty('min_cli_version');
    const ids = (version: string | null) => modelLaunchCatalog('claude', undefined, version).models.map(entry => entry.model);
    expect(ids('2.1.283')).not.toContain('claude-sonnet-5-5');
    expect(ids('2.1.284')).toContain('claude-sonnet-5-5');
    expect(ids('2.1.292')).not.toContain('claude-haiku-5-5');
    expect(ids('2.1.293 (Claude Code)')).toContain('claude-haiku-5-5');
    for (const version of [null, 'unknown']) {
      expect(ids(version)).not.toContain('claude-fable-5-1');
      expect(ids(version)).toContain('claude-sonnet-5');
    }
    expect(modelLaunchCatalog('claude', undefined, '2.1.312').models.find(entry => entry.model === 'claude-sonnet-5-5')?.min_cli_version).toBe('2.1.284');
    expect(modelLaunchCatalog('claude').models.map(entry => entry.model)).toContain('claude-haiku-5-5');
  });
});
