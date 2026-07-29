import { describe, expect, it } from 'vitest';
import {
  ADVISOR_MODEL_ALIASES,
  CLAUDE_LEGACY_MODEL_UPGRADES,
  CLAUDE_MODEL_DEFAULT_REASONING_EFFORTS,
  CLAUDE_MODEL_REASONING_EFFORTS,
  CLAUDE_PERMISSION_MODES,
  CODEX_MODEL_DEFAULT_REASONING_EFFORTS,
  DEFAULT_CLAUDE_PERMISSION_MODE,
  FORCE_UPGRADE_MODEL,
  FORCE_UPGRADE_REASONING_EFFORT,
  LEGACY_MODEL_UPGRADES,
  MODEL_REASONING_EFFORTS,
  PERSONALITIES,
  REASONING_EFFORTS,
  SUPPORTED_MODELS,
  defaultCodexReasoningEffortForModel,
  isLegacyModelUpgrade,
  normalizeApprovalPolicy,
  normalizeClaudeAdvisorModel,
  normalizeClaudeEffortLevel,
  normalizeClaudeModel,
  normalizeClaudePermissionMode,
  normalizeReasoningEffort,
  normalizeReasoningEffortForModel,
  normalizeSettings,
  normalizeStoredModel,
  normalizeSupportedModel,
  settingsHash,
} from '../../../src/services/config-normalizer.js';

describe('config-normalizer constants', () => {
  it('exposes the supported model list', () => {
    expect(SUPPORTED_MODELS).toEqual([
      'gpt-5.6-sol',
      'gpt-5.6-terra',
      'gpt-5.6-luna',
      'gpt-5.5',
      'gpt-5.4',
      'gpt-5.4-mini',
      'gpt-5.3-codex-spark',
    ]);
  });

  it('lists every reasoning effort tier', () => {
    expect(REASONING_EFFORTS).toEqual(['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
  });

  it('matches the current Codex CLI model effort catalog and defaults', () => {
    expect(MODEL_REASONING_EFFORTS).toEqual({
      'gpt-5.6-sol': ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
      'gpt-5.6-terra': ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
      'gpt-5.6-luna': ['low', 'medium', 'high', 'xhigh', 'max'],
      'gpt-5.5': ['low', 'medium', 'high', 'xhigh'],
      'gpt-5.4': ['low', 'medium', 'high', 'xhigh'],
      'gpt-5.4-mini': ['low', 'medium', 'high', 'xhigh'],
      'gpt-5.3-codex-spark': ['low', 'medium', 'high', 'xhigh'],
    });
    expect(CODEX_MODEL_DEFAULT_REASONING_EFFORTS).toEqual({
      'gpt-5.6-sol': 'medium',
      'gpt-5.6-terra': 'medium',
      'gpt-5.6-luna': 'medium',
      'gpt-5.5': 'medium',
      'gpt-5.4': 'medium',
      'gpt-5.4-mini': 'medium',
      'gpt-5.3-codex-spark': 'high',
    });
  });

  it('lists personalities', () => {
    expect(PERSONALITIES).toEqual(['friendly', 'pragmatic', 'none']);
  });

  it('maps legacy models to upgrades', () => {
    expect(LEGACY_MODEL_UPGRADES['gpt-5.1-codex-max']).toBe(FORCE_UPGRADE_MODEL);
    expect(LEGACY_MODEL_UPGRADES['gpt-5.3-codex']).toBe(FORCE_UPGRADE_MODEL);
    expect(LEGACY_MODEL_UPGRADES['gpt-5.2']).toBe(FORCE_UPGRADE_MODEL);
    expect(LEGACY_MODEL_UPGRADES['gpt-5.3-codex-spark']).toBeUndefined();
  });

  it('maps legacy Claude models onto current gate ids', () => {
    expect(CLAUDE_LEGACY_MODEL_UPGRADES['claude-3-opus-20240229']).toBe('claude-opus-4-8');
    expect(CLAUDE_LEGACY_MODEL_UPGRADES['claude-opus-4-20250514']).toBe('claude-opus-4-8');
    expect(CLAUDE_LEGACY_MODEL_UPGRADES['claude-3-5-sonnet-20241022']).toBe('claude-sonnet-5');
    expect(CLAUDE_LEGACY_MODEL_UPGRADES['claude-3-haiku-20240307']).toBe('claude-haiku-4-5-20251001');
  });

  it('exposes Claude persistent effort capabilities and defaults', () => {
    expect(CLAUDE_MODEL_REASONING_EFFORTS).toEqual({
      'claude-fable-5': ['low', 'medium', 'high', 'xhigh'],
      'claude-opus-5': ['low', 'medium', 'high', 'xhigh'],
      'claude-opus-4-8': ['low', 'medium', 'high', 'xhigh'],
      'claude-sonnet-5': ['low', 'medium', 'high', 'xhigh'],
      'claude-opus-4-7': ['low', 'medium', 'high', 'xhigh'],
      'claude-sonnet-4-6': ['low', 'medium', 'high'],
      'claude-haiku-4-5-20251001': [],
    });
    expect(CLAUDE_MODEL_DEFAULT_REASONING_EFFORTS).toEqual({
      'claude-fable-5': 'high',
      'claude-opus-5': 'high',
      'claude-opus-4-8': 'high',
      'claude-sonnet-5': 'high',
      'claude-opus-4-7': 'xhigh',
      'claude-sonnet-4-6': 'high',
      'claude-haiku-4-5-20251001': null,
    });
  });
});

describe('normalizeStoredModel', () => {
  it('passes through supported models', () => {
    expect(normalizeStoredModel('gpt-5.6-terra')).toBe('gpt-5.6-terra');
    expect(normalizeStoredModel('gpt-5.3-codex-spark')).toBe('gpt-5.3-codex-spark');
  });

  it('upgrades legacy models', () => {
    expect(normalizeStoredModel('gpt-5.1-codex-max')).toBe(FORCE_UPGRADE_MODEL);
    expect(isLegacyModelUpgrade('gpt-5.1-codex-max')).toBe(true);
    expect(normalizeStoredModel('gpt-5.3-codex')).toBe(FORCE_UPGRADE_MODEL);
    expect(normalizeStoredModel('gpt-5.2')).toBe(FORCE_UPGRADE_MODEL);
  });

  it('passes through unknown models verbatim (forward-compat)', () => {
    expect(normalizeStoredModel('gpt-7.0')).toBe('gpt-7.0');
  });

  it('normalizes empty/blank to null', () => {
    expect(normalizeStoredModel(null)).toBeNull();
    expect(normalizeStoredModel('')).toBeNull();
    expect(normalizeStoredModel('  ')).toBeNull();
  });

  it('does not treat inherited Object.prototype names as legacy upgrades', () => {
    expect(isLegacyModelUpgrade('toString')).toBe(false);
    expect(isLegacyModelUpgrade('constructor')).toBe(false);
    expect(isLegacyModelUpgrade('__proto__')).toBe(false);
    expect(normalizeStoredModel('toString')).toBe('toString');
  });
});

describe('normalizeSupportedModel', () => {
  it('rejects unknown models', () => {
    expect(normalizeSupportedModel('gpt-7.0')).toBeNull();
  });

  it('rejects inherited Object.prototype names', () => {
    expect(normalizeSupportedModel('constructor')).toBeNull();
    expect(normalizeSupportedModel('toString')).toBeNull();
    expect(normalizeSupportedModel('__proto__')).toBeNull();
  });
});

describe('normalizeClaudeModel', () => {
  it('upgrades legacy claude models', () => {
    expect(normalizeClaudeModel('claude-3-opus-20240229')).toBe('claude-opus-4-8');
  });
  it('passes through current claude models', () => {
    expect(normalizeClaudeModel('claude-sonnet-5')).toBe('claude-sonnet-5');
  });
  it('passes inherited Object.prototype names through verbatim', () => {
    expect(normalizeClaudeModel('valueOf')).toBe('valueOf');
    expect(normalizeClaudeModel('constructor')).toBe('constructor');
  });
});

describe('normalizeClaudeAdvisorModel', () => {
  it('exposes the tier alias allowlist', () => {
    expect(ADVISOR_MODEL_ALIASES).toEqual(['opus', 'sonnet', 'haiku']);
  });
  it('accepts the tier aliases case-insensitively and trims', () => {
    expect(normalizeClaudeAdvisorModel('opus')).toBe('opus');
    expect(normalizeClaudeAdvisorModel('  Sonnet ')).toBe('sonnet');
    expect(normalizeClaudeAdvisorModel('HAIKU')).toBe('haiku');
  });
  it('rejects non-alias values and empty/off (-> null)', () => {
    expect(normalizeClaudeAdvisorModel('claude-opus-4-8')).toBeNull();
    expect(normalizeClaudeAdvisorModel('gpt-5')).toBeNull();
    expect(normalizeClaudeAdvisorModel('')).toBeNull();
    expect(normalizeClaudeAdvisorModel(undefined)).toBeNull();
  });
});

describe('normalizeClaudeEffortLevel', () => {
  it('accepts only efforts supported by the selected Claude model', () => {
    expect(normalizeClaudeEffortLevel('xhigh', 'claude-fable-5')).toBe('xhigh');
    expect(normalizeClaudeEffortLevel('xhigh', 'claude-opus-5')).toBe('xhigh');
    expect(normalizeClaudeEffortLevel('xhigh', 'claude-opus-4-8')).toBe('xhigh');
    expect(normalizeClaudeEffortLevel('xhigh', 'claude-sonnet-5')).toBe('xhigh');
    expect(normalizeClaudeEffortLevel('xhigh', 'claude-opus-4-7')).toBe('xhigh');
    expect(normalizeClaudeEffortLevel('HIGH', 'claude-sonnet-4-6')).toBe('high');
    expect(normalizeClaudeEffortLevel('xhigh', 'claude-sonnet-4-6')).toBeNull();
    expect(normalizeClaudeEffortLevel('high', 'claude-haiku-4-5-20251001')).toBeNull();
  });
});

describe('normalizeClaudePermissionMode', () => {
  it('exposes exactly the upstream `claude --permission-mode` choices', () => {
    expect(CLAUDE_PERMISSION_MODES).toEqual([
      'default',
      'acceptEdits',
      'plan',
      'auto',
      'dontAsk',
      'bypassPermissions',
    ]);
    expect(DEFAULT_CLAUDE_PERMISSION_MODE).toBe('auto');
    // The default must itself be a valid choice.
    expect(CLAUDE_PERMISSION_MODES).toContain(DEFAULT_CLAUDE_PERMISSION_MODE);
  });
  it('accepts every valid mode, including auto', () => {
    for (const mode of CLAUDE_PERMISSION_MODES) {
      expect(normalizeClaudePermissionMode(mode)).toBe(mode);
    }
  });
  it('rejects the bogus legacy `autoEdit` value and other junk (-> null)', () => {
    expect(normalizeClaudePermissionMode('autoEdit')).toBeNull();
    expect(normalizeClaudePermissionMode('AUTO')).toBeNull();
    expect(normalizeClaudePermissionMode('')).toBeNull();
    expect(normalizeClaudePermissionMode(undefined)).toBeNull();
  });
});

describe('normalizeReasoningEffort', () => {
  it('accepts valid values', () => {
    expect(normalizeReasoningEffort('minimal')).toBe('minimal');
    expect(normalizeReasoningEffort('LOW')).toBe('low');
    expect(normalizeReasoningEffort('high')).toBe('high');
    expect(normalizeReasoningEffort('xhigh')).toBe('xhigh');
    expect(normalizeReasoningEffort('MAX')).toBe('max');
    expect(normalizeReasoningEffort('ultra')).toBe('ultra');
  });
  it('rejects unknown values', () => {
    expect(normalizeReasoningEffort('extreme')).toBeNull();
  });
  it('restricts effort to those supported by model', () => {
    expect(normalizeReasoningEffortForModel('high', 'gpt-5.5')).toBe('high');
    expect(normalizeReasoningEffortForModel('xhigh', 'gpt-5.3-codex-spark')).toBe('xhigh');
    expect(normalizeReasoningEffortForModel('ultra', 'gpt-5.6-terra')).toBe('ultra');
    expect(normalizeReasoningEffortForModel('ultra', 'gpt-5.6-luna')).toBeNull();
    expect(normalizeReasoningEffortForModel('minimal', 'gpt-5.5')).toBeNull();
    expect(normalizeReasoningEffortForModel('ultra', 'gpt-5.5')).toBeNull();
  });

  it('returns each model native Codex default effort', () => {
    expect(defaultCodexReasoningEffortForModel('gpt-5.6-sol')).toBe('medium');
    expect(defaultCodexReasoningEffortForModel('gpt-5.6-terra')).toBe('medium');
    expect(defaultCodexReasoningEffortForModel('gpt-5.3-codex-spark')).toBe('high');
    expect(defaultCodexReasoningEffortForModel('unknown')).toBeNull();
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
    expect(s.model).toBe('gpt-5.6-terra');
    expect(s.model_reasoning_effort).toBe('medium');
    expect(s.notify).toEqual([]);
    expect(s.orchestrator_mcp_enabled).toBe(true);
    expect(s.features).toEqual({});
    expect(s.profiles).toEqual([]);
    expect(s.mcp_servers).toEqual([]);
  });

  it('uses the selected Codex model default when effort is absent or incompatible', () => {
    expect(normalizeSettings({ model: 'gpt-5.6-sol' }).model_reasoning_effort).toBe('medium');
    expect(normalizeSettings({
      model: 'gpt-5.5',
      model_reasoning_effort: 'minimal',
    }).model_reasoning_effort).toBe('medium');
    expect(normalizeSettings({
      profiles: [{ name: 'luna', model: 'gpt-5.6-luna', model_reasoning_effort: 'ultra' }],
    }).profiles).toEqual([
      { name: 'luna', model: 'gpt-5.6-luna', model_reasoning_effort: 'medium' },
    ]);
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

  it('attaches a valid advisorModel and omits it when off/invalid', () => {
    expect(normalizeSettings({ advisorModel: 'opus' }).advisorModel).toBe('opus');
    expect(normalizeSettings({ advisorModel: 'OPUS' }).advisorModel).toBe('opus');
    expect(normalizeSettings({}).advisorModel).toBeUndefined();
    expect(normalizeSettings({ advisorModel: 'gpt-5' }).advisorModel).toBeUndefined();
  });

  it('attaches a compatible Claude effortLevel and omits incompatible values', () => {
    expect(normalizeSettings({
      model: 'claude-opus-4-7',
      effortLevel: 'xhigh',
    }, { applyCodexDefaults: false }).effortLevel).toBe('xhigh');
    expect(normalizeSettings({
      model: 'claude-sonnet-4-6',
      effortLevel: 'xhigh',
    }, { applyCodexDefaults: false }).effortLevel).toBeUndefined();
    expect(normalizeSettings({
      model: 'claude-haiku-4-5-20251001',
      effortLevel: 'high',
    }, { applyCodexDefaults: false }).effortLevel).toBeUndefined();
  });

  it('normalizes profile reasoning efforts', () => {
    const s = normalizeSettings({
      profiles: [
        { name: 'max', model: 'gpt-5.6-terra', model_reasoning_effort: 'xhigh' },
        { name: 'tiny', model: 'gpt-5.4-mini', model_reasoning_effort: 'xhigh' },
      ],
    });
    expect(s.profiles).toEqual([
      { name: 'max', model: 'gpt-5.6-terra', model_reasoning_effort: 'xhigh' },
      { name: 'tiny', model: 'gpt-5.4-mini', model_reasoning_effort: 'xhigh' },
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
