import { describe, expect, it } from 'vitest';
import {
  buildModelTierTable,
  modelTier,
  renderModelTierGuidance,
} from '../../../src/services/model-tiers.js';
import { buildModelPolicy } from '../../../src/services/model-policy.js';
import { SUPPORTED_MODELS } from '../../../src/services/config-normalizer.js';
import { CLAUDE_SUPPORTED_MODELS } from '../../../src/services/claude-models.js';
import { GROK_SUPPORTED_MODELS } from '../../../src/services/grok-models.js';
import { ENGINE_CLAUDE, ENGINE_CODEX, ENGINE_GROK, ENGINES } from '../../../src/util/engine.js';

describe('modelTier', () => {
  // A catalog addition without a tier must fail here, not vanish from guidance.
  it.each([
    [ENGINE_CODEX, SUPPORTED_MODELS],
    [ENGINE_CLAUDE, CLAUDE_SUPPORTED_MODELS],
    [ENGINE_GROK, GROK_SUPPORTED_MODELS],
  ] as const)('assigns a tier to every supported %s model', (engine, models) => {
    for (const model of models) expect(modelTier(engine, model), `${engine}/${model}`).not.toBeNull();
  });

  it.each([
    [ENGINE_CLAUDE, 'claude-haiku-5-5', 1],
    [ENGINE_CLAUDE, 'claude-sonnet-5', 2],
    [ENGINE_CLAUDE, 'claude-opus-5-5[1m]', 3],
    [ENGINE_CLAUDE, 'opus', 3],
    [ENGINE_CLAUDE, 'claude-fable-5-1', 4],
    [ENGINE_CODEX, 'gpt-6-luna', 1],
    [ENGINE_CODEX, 'gpt-5.6-terra', 2],
    [ENGINE_CODEX, 'gpt-6.1-sol', 3],
    [ENGINE_CODEX, 'gpt-6-astra', 4],
    [ENGINE_GROK, 'grok-4.6', 1],
    [ENGINE_GROK, 'grok-4.7-build-fast', 1],
    [ENGINE_GROK, 'grok-4.7', 2],
  ] as const)('%s %s is Tier %d', (engine, model, tier) => {
    expect(modelTier(engine, model)).toBe(tier);
  });

  it('returns null for unknown or custom ids', () => {
    expect(modelTier(ENGINE_CODEX, 'my-local-llm')).toBeNull();
    expect(modelTier(ENGINE_CLAUDE, 'claude-mythos-1')).toBeNull();
    expect(modelTier(ENGINE_GROK, 'grok-9')).toBeNull();
    expect(modelTier(ENGINE_CODEX, null)).toBeNull();
  });
});

describe('buildModelTierTable', () => {
  const latest = Object.fromEntries(ENGINES.map((engine) => [engine, buildModelPolicy(engine).latest_models]));

  it('lists only the latest models of the active engines in canonical order', () => {
    const table = buildModelTierTable([ENGINE_GROK, ENGINE_CLAUDE], latest);
    expect(table.flatMap((row) => row.models.map((entry) => entry.engine))).not.toContain(ENGINE_CODEX);
    expect(table.find((row) => row.tier === 2)?.models).toEqual([
      { engine: ENGINE_CLAUDE, model: 'claude-sonnet-5-5' },
      { engine: ENGINE_GROK, model: 'grok-4.7' },
    ]);
    expect(table.flatMap((row) => row.models.map((entry) => entry.model))).not.toContain('grok-4.6');
  });

  it('omits empty tiers', () => {
    const table = buildModelTierTable([ENGINE_GROK], latest);
    expect(table.map((row) => row.tier)).toEqual([1, 2]);
    expect(buildModelTierTable([], latest)).toEqual([]);
  });
});

describe('renderModelTierGuidance', () => {
  const table = buildModelTierTable([ENGINE_CODEX], { codex: ['gpt-6-luna', 'gpt-6-astra'] });

  it('names the configured model and its tier', () => {
    const text = renderModelTierGuidance(table, { engine: ENGINE_CODEX, model: 'gpt-6-astra' });
    expect(text).toContain("configured codex model is `gpt-6-astra` (Tier 4)");
    expect(text).toContain('| 1 | ');
    expect(text).toContain('`gpt-6-luna`');
    expect(text).toContain('| 2 | ');
    expect(text).toContain('None available');
    expect(text).toContain('`Underclassed: Tier <n> required');
    // A one-tier gap is a self-rating too fuzzy to stop on; only two or more stop.
    expect(text).toMatch(/\*\*Task one tier above yours:\*\* report and proceed/);
    expect(text).toMatch(/\*\*Task two or more tiers above yours:\*\* stop before scouting or planning/);
    expect(text).not.toContain('Overclassed');
    // An explicit operator instruction outranks fleet policy; the stop must say so.
    expect(text).toContain('explicit operator override acknowledging this mismatch');
    expect(text).toContain('generic `GPT-6` does not');
    expect(text).toContain('selecting a model or assigning the task is not an override');
    expect(text).toContain('never abort on a guess');
  });

  it.each([ENGINE_CODEX, ENGINE_CLAUDE, ENGINE_GROK])('keeps all task definitions with only low-tier %s models', (engine) => {
    const models = { codex: 'gpt-6-luna', claude: 'claude-haiku-5-5', grok: 'grok-4.7' };
    const text = renderModelTierGuidance(
      buildModelTierTable([engine], { [engine]: [models[engine]] }), { engine, model: models[engine] },
    );
    for (const tier of [1, 2, 3, 4]) expect(text).toContain(`| ${tier} |`);
    expect(text).toContain('Whole-stack cleanup assessment is Tier 4');
    expect(text).toContain('`scout and prepare`');
    expect(text).toContain('stop before scouting or planning');
    expect(text).toContain('if none fits, say so');
  });

  it('falls back to self-identification for unpinned or unknown models', () => {
    expect(renderModelTierGuidance(table, { engine: ENGINE_CLAUDE, model: null }))
      .toContain('No claude model is pinned for this host.');
    expect(renderModelTierGuidance(table, { engine: ENGINE_CODEX, model: 'my-local-llm' }))
      .toContain('which has no fleet tier');
  });
});
