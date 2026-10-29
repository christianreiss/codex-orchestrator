import { describe, expect, it } from 'vitest';
import { ENGINES, type Engine } from '../../../src/util/engine.js';
import {
  MODEL_REGISTRY,
  acceptedModelIds,
  claudeAdvisorRanks,
  familyTiers,
  offeredModelIds,
  registryModels,
  upgradeMap,
} from '../../../src/services/model-registry/index.js';
import { CODEX_FORCED_UPGRADES_FROM, CLAUDE_ADVISOR_ALIASES } from '../../../src/services/model-registry/data.js';
import {
  CLAUDE_ADVISOR_ALIAS_TARGETS,
  CLAUDE_ADVISOR_RANKS,
  CODEX_MODEL_DEFAULT_REASONING_EFFORTS,
  DEFAULT_CODEX_MODEL,
  LEGACY_MODEL_UPGRADES,
  MODEL_REASONING_EFFORTS,
  REASONING_EFFORTS,
  SUPPORTED_MODELS,
} from '../../../src/services/config-normalizer.js';
import { CODEX_MODEL_MIN_CLI_VERSIONS } from '../../../src/services/codex-model-capabilities.js';
import {
  CLAUDE_DEFAULT_MODEL,
  CLAUDE_LEGACY_MODEL_UPGRADES,
  CLAUDE_MODEL_DEFAULT_REASONING_EFFORTS,
  CLAUDE_MODEL_LINES,
  CLAUDE_MODEL_METADATA,
  CLAUDE_MODEL_MIN_CLI_VERSIONS,
  CLAUDE_MODEL_REASONING_EFFORTS,
  CLAUDE_SUPPORTED_MODELS,
} from '../../../src/services/claude-models.js';
import { claudeSessionEfforts, claudeSupportsLegacyUserEffort } from '../../../src/services/claude-effort.js';
import {
  GROK_DEFAULT_MODEL,
  GROK_MODEL_DEFAULT_REASONING_EFFORTS,
  GROK_MODEL_REASONING_EFFORTS,
  GROK_SUPPORTED_MODELS,
} from '../../../src/services/grok-models.js';
import { modelTier } from '../../../src/services/model-tiers.js';
import { modelDefaultsCatalog } from '../../../src/services/model-defaults.js';

/**
 * The registry is the only place a model is defined (docs/model-registry.md).
 * These invariants keep it internally consistent, and the "derived views"
 * block proves every legacy export is computed from it rather than kept beside it.
 */
const ALL_EFFORTS = new Set(REASONING_EFFORTS);

describe.each(ENGINES)('model registry invariants: %s', (engine: Engine) => {
  const entries = registryModels(engine);
  const ids = entries.map((entry) => entry.id);
  const upgrades = upgradeMap(engine);

  it('has unique ids, and no retired id or alias shadows a registered id', () => {
    expect(new Set(ids).size).toBe(ids.length);
    const accepted = new Set(acceptedModelIds(engine));
    for (const from of Object.keys(upgrades)) expect(accepted.has(from), `${from} is both registered and an upgrade source`).toBe(false);
    const sources = entries.flatMap((entry) => [...(entry.upgradesFrom ?? []), ...(entry.aliases ?? [])]);
    expect(new Set(sources).size, 'an upgrade source names two successors').toBe(sources.length);
  });

  it('upgrades only to accepted, non-gated models', () => {
    for (const [from, to] of Object.entries(upgrades)) {
      expect(acceptedModelIds(engine), `${from} -> ${to}`).toContain(to);
      expect(entries.find((entry) => entry.id === to)?.liveCatalogRequired, `${from} -> ${to} is unverified`).not.toBe(true);
    }
  });

  it('gives every model a tier, a known effort set and a default inside it', () => {
    for (const entry of entries) {
      expect([1, 2, 3, 4, 5], entry.id).toContain(entry.tier);
      expect(entry.label.trim(), entry.id).not.toBe('');
      expect(entry.family.trim(), entry.id).not.toBe('');
      for (const effort of [...entry.efforts, ...(entry.sessionEfforts ?? [])]) expect(ALL_EFFORTS.has(effort), `${entry.id}: ${effort}`).toBe(true);
      if (entry.defaultEffort === null) expect(entry.efforts, entry.id).toEqual([]);
      else expect(entry.efforts, entry.id).toContain(entry.defaultEffort);
      if (entry.minCliVersion !== undefined) expect(entry.minCliVersion, entry.id).toMatch(/^\d+\.\d+\.\d+$/);
    }
  });

  it('defaults to an active, verified model', () => {
    const fallback = entries.find((entry) => entry.id === MODEL_REGISTRY[engine].defaultModel);
    expect(fallback?.status).toBe('active');
    expect(fallback?.liveCatalogRequired).not.toBe(true);
  });

  it('lists every retired entry as some successor\'s upgrade source', () => {
    for (const entry of entries.filter((candidate) => candidate.status === 'retired')) {
      expect(Object.keys(upgrades), entry.id).toContain(entry.id);
    }
  });

  it('keeps one tier per Codex/Claude family so unknown versions inherit it', () => {
    if (engine === 'grok') return;
    const tiers = familyTiers(engine);
    for (const entry of entries) expect(tiers[entry.family], entry.id).toBe(entry.tier);
  });

  it('resolves every model and alias to its registry tier', () => {
    for (const entry of entries) {
      expect(modelTier(engine, entry.id), entry.id).toBe(entry.tier);
      for (const alias of entry.aliases ?? []) expect(modelTier(engine, alias), alias).toBe(entry.tier);
    }
  });
});

describe('derived views equal the registry', () => {
  const table = <T>(engine: Engine, pick: (entry: ReturnType<typeof registryModels>[number]) => T | undefined) =>
    Object.fromEntries(registryModels(engine).flatMap((entry) => (pick(entry) === undefined ? [] : [[entry.id, pick(entry)]])));

  it('codex', () => {
    expect(SUPPORTED_MODELS).toEqual(acceptedModelIds('codex'));
    expect(MODEL_REASONING_EFFORTS).toEqual(table('codex', (entry) => entry.efforts));
    expect(CODEX_MODEL_DEFAULT_REASONING_EFFORTS).toEqual(table('codex', (entry) => entry.defaultEffort ?? undefined));
    expect(CODEX_MODEL_MIN_CLI_VERSIONS).toEqual(table('codex', (entry) => entry.minCliVersion));
    expect(DEFAULT_CODEX_MODEL).toBe(MODEL_REGISTRY.codex.defaultModel);
    expect(LEGACY_MODEL_UPGRADES).toEqual(upgradeMap('codex'));
    for (const from of CODEX_FORCED_UPGRADES_FROM) expect(LEGACY_MODEL_UPGRADES[from]).toBe(DEFAULT_CODEX_MODEL);
    expect(modelDefaultsCatalog('codex').map((entry) => entry.model)).toEqual(acceptedModelIds('codex'));
  });

  it('claude', () => {
    expect(CLAUDE_SUPPORTED_MODELS).toEqual(offeredModelIds('claude'));
    expect(CLAUDE_DEFAULT_MODEL).toBe(MODEL_REGISTRY.claude.defaultModel);
    expect(CLAUDE_MODEL_REASONING_EFFORTS).toEqual(table('claude', (entry) => entry.efforts));
    expect(CLAUDE_MODEL_DEFAULT_REASONING_EFFORTS).toEqual(table('claude', (entry) => entry.defaultEffort));
    expect(CLAUDE_MODEL_MIN_CLI_VERSIONS).toEqual(table('claude', (entry) => entry.minCliVersion));
    expect(CLAUDE_LEGACY_MODEL_UPGRADES).toEqual(upgradeMap('claude'));
    expect(CLAUDE_ADVISOR_RANKS).toEqual(claudeAdvisorRanks());
    expect(CLAUDE_ADVISOR_ALIAS_TARGETS).toEqual(CLAUDE_ADVISOR_ALIASES);
    for (const entry of registryModels('claude')) {
      expect(CLAUDE_MODEL_METADATA[entry.id as keyof typeof CLAUDE_MODEL_METADATA]?.displayName).toBe(`Claude ${entry.label}`);
      expect(CLAUDE_MODEL_LINES[entry.id as keyof typeof CLAUDE_MODEL_LINES]).toBe(entry.api?.line);
      expect(claudeSessionEfforts(entry.id)).toEqual([...(entry.sessionEfforts ?? [])]);
      expect(claudeSupportsLegacyUserEffort(entry.id)).toBe(entry.legacyUserEffort === true);
    }
    for (const target of Object.values(CLAUDE_ADVISOR_ALIASES)) expect(offeredModelIds('claude')).toContain(target);
  });

  it('grok', () => {
    expect(GROK_SUPPORTED_MODELS).toEqual(offeredModelIds('grok'));
    expect(GROK_DEFAULT_MODEL).toBe(MODEL_REGISTRY.grok.defaultModel);
    expect(GROK_MODEL_REASONING_EFFORTS).toEqual(table('grok', (entry) => entry.efforts));
    expect(GROK_MODEL_DEFAULT_REASONING_EFFORTS).toEqual(table('grok', (entry) => entry.defaultEffort ?? undefined));
  });
});

describe('registry snapshot', () => {
  it('records every model change for review', () => {
    // One line per model: a model change is this snapshot diff plus data.ts.
    const summary = Object.fromEntries(ENGINES.map((engine) => [engine, {
      default: MODEL_REGISTRY[engine].defaultModel,
      models: registryModels(engine).map((entry) => [
        entry.id, entry.status, `tier ${entry.tier}`, entry.efforts.join('|') || '-', entry.defaultEffort ?? '-',
        ...(entry.minCliVersion ? [`cli>=${entry.minCliVersion}`] : []),
        ...(entry.liveCatalogRequired ? ['live-catalog'] : []),
      ].join(' ')),
      upgrades: upgradeMap(engine),
    }]));
    expect(summary).toMatchSnapshot();
  });
});
