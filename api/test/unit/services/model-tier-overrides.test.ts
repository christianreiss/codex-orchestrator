import { describe, expect, it } from 'vitest';
import {
  buildModelTierTable,
  DEFAULT_TIER_RESOLVER,
  modelTier,
  modelTierCatalog,
  parseModelTierOverrides,
  serializeModelTierOverrides,
  tierResolver,
  validateModelTierOverrides,
} from '../../../src/services/model-tiers.js';
import { registryModels } from '../../../src/services/model-registry/index.js';
import { ENGINE_CLAUDE, ENGINE_CODEX, ENGINE_GROK, ENGINE_KIMI, ENGINES } from '../../../src/util/engine.js';

const placed = (overrides: object) => tierResolver(JSON.stringify(overrides));

describe('operator tier placements', () => {
  it('leave every registry tier untouched when none are stored', () => {
    for (const raw of [null, '', '{}', 'not json', '[]']) {
      const resolver = tierResolver(raw);
      for (const engine of ENGINES) {
        for (const entry of registryModels(engine)) {
          if (entry.status === 'retired') continue;
          expect(resolver.tier(engine, entry.id), `${engine}/${entry.id}`).toBe(entry.tier);
        }
      }
    }
    expect(tierResolver(null)).toBe(DEFAULT_TIER_RESOLVER);
  });

  it('reach the [1m] variant, a dated snapshot and an alias of a moved model', () => {
    const resolver = placed({ claude: { 'claude-opus-5-5': 5, 'claude-opus-4-5-20251101': 2 } });
    for (const id of ['claude-opus-5-5', 'claude-opus-5-5[1m]', 'claude-opus-5-5-20261201', 'CLAUDE-OPUS-5-5']) {
      expect(resolver.tier(ENGINE_CLAUDE, id), id).toBe(5);
    }
    expect(resolver.tier(ENGINE_CLAUDE, 'claude-opus-4-5')).toBe(2);
    expect(resolver.tier(ENGINE_CLAUDE, 'claude-opus-4-8')).toBe(4);
  });

  it('send a family split by a placement to its newest member, without one to its shared tier', () => {
    const split = placed({ claude: { 'claude-opus-5-5': 5 } });
    // The CLI's bare alias and an unknown new version mean the newest Opus.
    expect(split.tier(ENGINE_CLAUDE, 'opus')).toBe(5);
    expect(split.tier(ENGINE_CLAUDE, 'claude-opus-6')).toBe(5);
    const whole = placed({ codex: Object.fromEntries(registryModels(ENGINE_CODEX).filter((e) => e.family === 'sol').map((e) => [e.id, 4])) });
    expect(whole.tier(ENGINE_CODEX, 'gpt-6.3-sol')).toBe(4);
    expect(DEFAULT_TIER_RESOLVER.tier(ENGINE_CLAUDE, 'opus')).toBe(4);
    // Grok and Kimi rank by exact id only, placed or not.
    expect(placed({ grok: { 'grok-4.7': 3 } }).tier(ENGINE_GROK, 'grok-4.8')).toBeNull();
    const kimi = placed({ kimi: { 'k3.1-pro': 4 } });
    expect(kimi.tier(ENGINE_KIMI, 'k3.1-pro')).toBe(4);
    expect(kimi.tier(ENGINE_KIMI, 'k3.1-pro-highspeed')).toBe(3);
    expect(kimi.tier(ENGINE_KIMI, 'k3.2-pro')).toBeNull();
  });

  it('move a model between rows of the guidance table and the strongest pick', () => {
    const models = { claude: ['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-fable-5-2'] };
    expect(buildModelTierTable([ENGINE_CLAUDE], models).at(-1)!.models[0]!.model).toBe('claude-fable-5-2');
    const table = buildModelTierTable([ENGINE_CLAUDE], models, placed({ claude: { 'claude-fable-5-2': 3 } }));
    expect(table.map((row) => [row.tier, row.models.map((m) => m.model)])).toEqual([
      [3, ['claude-sonnet-5-5', 'claude-fable-5-2']],
      [4, ['claude-opus-5-5']],
    ]);
    expect(modelTier(ENGINE_CLAUDE, 'claude-fable-5-2')).toBe(5);
  });

  it('read tolerantly: unknown engines, retired or unknown ids, bad tiers and defaults are dropped', () => {
    expect(parseModelTierOverrides(JSON.stringify({
      claude: { 'claude-opus-5-5': 5, 'claude-sonnet-5-5': 3, 'claude-nope': 2, 'claude-haiku-5-5': 9 },
      mystery: { x: 1 },
      codex: 'oops',
    }))).toEqual({ claude: { 'claude-opus-5-5': 5 } });
  });

  it('write strictly and store only deviations in registry order', () => {
    expect(validateModelTierOverrides({ claude: { 'claude-nope': 2 }, mystery: {} }).errors).toEqual([
      'claude/claude-nope is not a registered model',
      'unknown engine mystery',
    ]);
    expect(validateModelTierOverrides({ codex: { 'gpt-6.2-sol': 7 } }).errors).toEqual(['codex/gpt-6.2-sol: tier must be 1 to 5']);
    expect(validateModelTierOverrides([]).errors).toHaveLength(1);
    const { overrides, errors } = validateModelTierOverrides({ claude: { 'claude-sonnet-5-5': 4, 'claude-fable-5-2': 5, 'claude-opus-5-5': 4 } });
    expect(errors).toEqual([]);
    expect(serializeModelTierOverrides(overrides)).toBe('{"claude":{"claude-sonnet-5-5":4}}');
  });

  it('list each non-retired model with its default and effective tier', () => {
    const catalog = modelTierCatalog(placed({ claude: { 'claude-sonnet-5-5': 4 } }));
    expect(catalog.find((e) => e.id === 'claude-sonnet-5-5')).toMatchObject({ engine: 'claude', label: 'Sonnet 5.5', default_tier: 3, tier: 4 });
    expect(catalog.find((e) => e.id === 'claude-opus-5-5')).toMatchObject({ default_tier: 4, tier: 4 });
    expect(new Set(catalog.map((e) => e.engine))).toEqual(new Set(ENGINES));
  });
});
