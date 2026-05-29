import { describe, expect, it } from 'vitest';
import {
  CLAUDE_LEGACY_MODEL_UPGRADES,
  CLAUDE_SUPPORTED_MODELS,
  FORCE_UPGRADE_MODEL,
  FORCE_UPGRADE_REASONING_EFFORT,
  LEGACY_MODEL_UPGRADES,
  PERSONALITIES,
  REASONING_EFFORTS,
  SUPPORTED_MODELS,
  isLegacyModelUpgrade,
  normalizeApprovalPolicy,
  normalizeClaudeModel,
  normalizeReasoningEffort,
  normalizeReasoningEffortForModel,
  normalizeSettings,
  normalizeStoredModel,
  normalizeSupportedModel,
  settingsHash,
} from '../../../src/services/config-normalizer.js';

describe('config-normalizer constants', () => {
  it('exposes the supported model list', () => {
    expect(SUPPORTED_MODELS).toContain('gpt-5.4');
    expect(SUPPORTED_MODELS.length).toBeGreaterThanOrEqual(3);
  });

  it('lists every reasoning effort tier', () => {
    expect(REASONING_EFFORTS).toEqual(['minimal', 'low', 'medium', 'high']);
  });

  it('lists personalities', () => {
    expect(PERSONALITIES).toEqual(['friendly', 'pragmatic', 'none']);
  });

  it('maps legacy models to upgrades', () => {
    expect(LEGACY_MODEL_UPGRADES['gpt-5.1-codex-max']).toBe(FORCE_UPGRADE_MODEL);
  });

  it('maps legacy Claude models to upgrades', () => {
    expect(CLAUDE_LEGACY_MODEL_UPGRADES['claude-3-opus-20240229']).toBe('claude-opus-4-6');
    expect(CLAUDE_SUPPORTED_MODELS).toContain('claude-opus-4-6');
  });
});

describe('normalizeStoredModel', () => {
  it('passes through supported models', () => {
    expect(normalizeStoredModel('gpt-5.4')).toBe('gpt-5.4');
  });

  it('upgrades legacy models', () => {
    expect(normalizeStoredModel('gpt-5.1-codex-max')).toBe(FORCE_UPGRADE_MODEL);
    expect(isLegacyModelUpgrade('gpt-5.1-codex-max')).toBe(true);
  });

  it('passes through unknown models verbatim (forward-compat)', () => {
    expect(normalizeStoredModel('gpt-7.0')).toBe('gpt-7.0');
  });

  it('normalizes empty/blank to null', () => {
    expect(normalizeStoredModel(null)).toBeNull();
    expect(normalizeStoredModel('')).toBeNull();
    expect(normalizeStoredModel('  ')).toBeNull();
  });
});

describe('normalizeSupportedModel', () => {
  it('rejects unknown models', () => {
    expect(normalizeSupportedModel('gpt-7.0')).toBeNull();
  });
});

describe('normalizeClaudeModel', () => {
  it('upgrades legacy claude models', () => {
    expect(normalizeClaudeModel('claude-3-opus-20240229')).toBe('claude-opus-4-6');
  });
  it('passes through current claude models', () => {
    expect(normalizeClaudeModel('claude-sonnet-4-6')).toBe('claude-sonnet-4-6');
  });
});

describe('normalizeReasoningEffort', () => {
  it('accepts valid values', () => {
    expect(normalizeReasoningEffort('minimal')).toBe('minimal');
    expect(normalizeReasoningEffort('LOW')).toBe('low');
    expect(normalizeReasoningEffort('high')).toBe('high');
  });
  it('maps legacy xhigh to high', () => {
    expect(normalizeReasoningEffort('xhigh')).toBe('high');
  });
  it('rejects unknown values', () => {
    expect(normalizeReasoningEffort('extreme')).toBeNull();
  });
  it('restricts effort to those supported by model', () => {
    expect(normalizeReasoningEffortForModel('high', 'gpt-5.4')).toBe('high');
  });
});

describe('normalizeApprovalPolicy', () => {
  it('accepts canonical values', () => {
    expect(normalizeApprovalPolicy('on-request')).toBe('on-request');
    expect(normalizeApprovalPolicy('NEVER')).toBe('never');
  });
  it('rejects other strings', () => {
    expect(normalizeApprovalPolicy('always')).toBeNull();
  });
});

describe('normalizeSettings()', () => {
  it('produces the legacy default structure', () => {
    const s = normalizeSettings({});
    expect(s.personality).toBe('friendly');
    expect(s.notify).toEqual([]);
    expect(s.orchestrator_mcp_enabled).toBe(true);
    expect(s.features).toEqual({});
    expect(s.profiles).toEqual([]);
    expect(s.mcp_servers).toEqual([]);
  });

  it('force-upgrades legacy models with high reasoning', () => {
    const s = normalizeSettings({
      model: 'gpt-5.1-codex-max',
      model_reasoning_effort: 'medium',
    });
    expect(s.model).toBe(FORCE_UPGRADE_MODEL);
    expect(s.model_reasoning_effort).toBe(FORCE_UPGRADE_REASONING_EFFORT);
  });

  it('drops obsolete feature keys', () => {
    const s = normalizeSettings({
      features: {
        steer: true,
        collaboration_modes: true,
        memories: true,
      },
    });
    expect(s.features).not.toHaveProperty('steer');
    expect(s.features).not.toHaveProperty('collaboration_modes');
    expect(s.features.memories).toBe(true);
  });

  it('normalizes booleans', () => {
    const s = normalizeSettings({
      orchestrator_mcp_enabled: 'false',
      web_search: '1',
      model_supports_reasoning_summaries: 'yes',
    });
    expect(s.orchestrator_mcp_enabled).toBe(false);
    expect(s.web_search).toBe(true);
    expect(s.model_supports_reasoning_summaries).toBe(true);
  });

  it('strips invalid notify entries', () => {
    const s = normalizeSettings({ notify: ['mailto:a@b', 42, null, '  ', 'webhook'] });
    expect(s.notify).toEqual(['mailto:a@b', 'webhook']);
  });

  it('normalizes profile reasoning efforts', () => {
    const s = normalizeSettings({
      profiles: [
        { name: 'max', model: 'gpt-5.4', model_reasoning_effort: 'xhigh' },
        { name: 'tiny', model: 'gpt-5.4-mini', model_reasoning_effort: 'minimal' },
      ],
    });
    expect(s.profiles).toEqual([
      { name: 'max', model: 'gpt-5.4', model_reasoning_effort: 'high' },
      { name: 'tiny', model: 'gpt-5.4-mini', model_reasoning_effort: 'minimal' },
    ]);
  });
});

describe('settingsHash', () => {
  it('produces a stable hash regardless of key order', () => {
    const h1 = settingsHash({ a: 1, b: { c: 2, d: 3 } });
    const h2 = settingsHash({ b: { d: 3, c: 2 }, a: 1 });
    expect(h1).toBe(h2);
  });

  it('differs when values differ', () => {
    expect(settingsHash({ a: 1 })).not.toBe(settingsHash({ a: 2 }));
  });
});
