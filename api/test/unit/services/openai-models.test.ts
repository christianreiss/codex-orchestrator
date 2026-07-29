import { describe, it, expect } from 'vitest';
import {
  OPENAI_DEFAULT_MODEL,
  OPENAI_LEGACY_MODEL_UPGRADES,
  OPENAI_MODELS,
  UnsupportedModelError,
  buildModelList,
  buildModelObject,
  isSupportedModel,
  resolveRequestedModel,
} from '../../../src/services/openai-models.js';

describe('resolveRequestedModel', () => {
  it('falls back to the default for empty, blank and non-string values', () => {
    expect(resolveRequestedModel('')).toBe(OPENAI_DEFAULT_MODEL);
    expect(resolveRequestedModel(' ')).toBe(OPENAI_DEFAULT_MODEL);
    expect(resolveRequestedModel('   ')).toBe(OPENAI_DEFAULT_MODEL);
    expect(resolveRequestedModel(undefined)).toBe(OPENAI_DEFAULT_MODEL);
    expect(resolveRequestedModel(null)).toBe(OPENAI_DEFAULT_MODEL);
    expect(resolveRequestedModel(42)).toBe(OPENAI_DEFAULT_MODEL);
    expect(resolveRequestedModel({ id: 'gpt-5.6-terra' })).toBe(OPENAI_DEFAULT_MODEL);
  });

  it('passes every catalog model through unchanged', () => {
    expect(OPENAI_MODELS.length).toBeGreaterThan(0);
    for (const id of OPENAI_MODELS) {
      expect(isSupportedModel(id)).toBe(true);
      expect(resolveRequestedModel(id)).toBe(id);
      expect(resolveRequestedModel(`  ${id}  `)).toBe(id);
    }
  });

  it('upgrades every legacy alias, case-insensitively', () => {
    const legacy = Object.entries(OPENAI_LEGACY_MODEL_UPGRADES);
    expect(legacy.length).toBeGreaterThan(0);
    for (const [alias, upgraded] of legacy) {
      expect(resolveRequestedModel(alias)).toBe(upgraded);
      expect(resolveRequestedModel(alias.toUpperCase())).toBe(upgraded);
    }
    // Explicit mixed-case spelling of a known alias.
    expect(resolveRequestedModel('GPT-5.3-Codex')).toBe(OPENAI_LEGACY_MODEL_UPGRADES['gpt-5.3-codex']);
  });

  it('throws for unknown models', () => {
    expect(() => resolveRequestedModel('gpt-4o')).toThrow(UnsupportedModelError);
  });

  it('rejects inherited Object.prototype keys instead of resolving them', () => {
    for (const name of ['constructor', 'toString', 'valueOf', '__proto__', 'hasOwnProperty']) {
      expect(() => resolveRequestedModel(name)).toThrow(UnsupportedModelError);
    }
  });
});

describe('buildModelObject', () => {
  it('reports a stable created timestamp and owner', () => {
    const first = buildModelObject('gpt-5.6-terra');
    const second = buildModelObject('gpt-5.6-terra');
    expect(first).toEqual({
      id: 'gpt-5.6-terra',
      object: 'model',
      created: Math.floor(Date.UTC(2026, 0, 1) / 1000),
      owned_by: 'codex-orchestrator',
    });
    // Must not move between polls the way Date.now() would.
    expect(second.created).toBe(first.created);
  });
});

describe('buildModelList', () => {
  it('lists the catalog in order', () => {
    const list = buildModelList();
    expect(list.object).toBe('list');
    expect(list.data.map((m) => m.id)).toEqual([...OPENAI_MODELS]);
  });

  it('appends extras and dedupes on id', () => {
    const list = buildModelList(['gpt-5.6-terra', 'gpt-7.0', 'gpt-7.0']);
    expect(list.data.map((m) => m.id)).toEqual([...OPENAI_MODELS, 'gpt-7.0']);
    for (const entry of list.data) {
      expect(entry.object).toBe('model');
      expect(entry.owned_by).toBe('codex-orchestrator');
    }
  });
});
