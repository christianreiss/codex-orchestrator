import { describe, expect, it } from 'vitest';
import { ClientConfigService } from '../../../src/services/client-config.js';
import { clientConfigDocuments } from '../../../src/db/schema.js';
import { createDbFake } from '../../helpers/db-fake.js';
import {
  ADVISOR_MODEL_ALIASES,
  claudeAdvisorPairIsValid,
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
  normalizeClaudeStatusLine,
  normalizeReasoningEffort,
  normalizeReasoningEffortForModel,
  normalizeSettings,
  normalizeStoredModel,
  normalizeSupportedModel,
  settingsHash,
} from '../../../src/services/config-normalizer.js';

describe('config-normalizer constants', () => {
  it('exposes the supported model list', () => {
    // `gpt-5.4-mini` is absent on purpose: its catalog entry carries an
    // `upgrade` block with `retirement_at` 2026-08-31, so it moved to
    // LEGACY_MODEL_UPGRADES. `gpt-5.3-codex-spark` left with codex-cli 0.158.0
    // (catalog, binary, and a live call all reject it) and heals the same way.
    expect(SUPPORTED_MODELS).toEqual([
      'gpt-6.1-sol',
      'gpt-6.1-terra',
      // Accepted for explicit authoring but live-catalog gated (unverified id).
      'gpt-6.1-luna',
      'gpt-6-astra',
      'gpt-6-sol',
      'gpt-6-luna',
      'gpt-5.6-sol',
      'gpt-5.6-terra',
      'gpt-5.6-luna',
    ]);
  });

  it('lists every reasoning effort tier', () => {
    expect(REASONING_EFFORTS).toEqual(['low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
  });

  it('matches the current Codex CLI model effort catalog and defaults', () => {
    // Mirrors codex-cli 0.164.0 models_cache.json, 2026-10-26.
    expect(MODEL_REASONING_EFFORTS).toEqual({
      'gpt-6.1-sol': ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
      'gpt-6.1-terra': ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
      // Unverified: copies GPT-6 Luna until an account catalog shows it.
      'gpt-6.1-luna': ['low', 'medium', 'high', 'xhigh', 'max'],
      'gpt-6-astra': ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
      'gpt-6-sol': ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
      'gpt-6-luna': ['low', 'medium', 'high', 'xhigh', 'max'],
      'gpt-5.6-sol': ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
      'gpt-5.6-terra': ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
      'gpt-5.6-luna': ['low', 'medium', 'high', 'xhigh', 'max'],
    });
    expect(CODEX_MODEL_DEFAULT_REASONING_EFFORTS).toEqual({
      'gpt-6.1-sol': 'low',
      'gpt-6.1-terra': 'low',
      'gpt-6.1-luna': 'medium',
      'gpt-6-astra': 'low',
      'gpt-6-sol': 'medium',
      'gpt-6-luna': 'medium',
      // Sol's catalog `default_reasoning_level` is `low`, not `medium`.
      'gpt-5.6-sol': 'low',
      'gpt-5.6-terra': 'medium',
      'gpt-5.6-luna': 'medium',
    });
  });

  it('lists personalities', () => {
    expect(PERSONALITIES).toEqual(['friendly', 'pragmatic', 'none']);
  });

  it('maps legacy models to upgrades', () => {
    expect(LEGACY_MODEL_UPGRADES['gpt-5.1-codex-max']).toBe(FORCE_UPGRADE_MODEL);
    expect(LEGACY_MODEL_UPGRADES['gpt-5.3-codex']).toBe(FORCE_UPGRADE_MODEL);
    expect(LEGACY_MODEL_UPGRADES['gpt-5.2']).toBe(FORCE_UPGRADE_MODEL);
    expect(LEGACY_MODEL_UPGRADES['gpt-5.4']).toBe('gpt-6-sol');
    // Retired 2026-08-31; current model guidance names GPT-6 Luna.
    expect(LEGACY_MODEL_UPGRADES['gpt-5.4-mini']).toBe('gpt-6-luna');
    // The forced migration effort must be one the replacement accepts.
    expect(MODEL_REASONING_EFFORTS['gpt-5.6-luna']).toContain(FORCE_UPGRADE_REASONING_EFFORT);
    expect(LEGACY_MODEL_UPGRADES['gpt-5.3-codex-spark']).toBe(FORCE_UPGRADE_MODEL);
  });

  it('maps legacy Claude models onto current gate ids', () => {
    expect(CLAUDE_LEGACY_MODEL_UPGRADES['claude-3-opus-20240229']).toBe('claude-opus-4-8');
    expect(CLAUDE_LEGACY_MODEL_UPGRADES['claude-opus-4-20250514']).toBe('claude-opus-4-8');
    expect(CLAUDE_LEGACY_MODEL_UPGRADES['claude-3-5-sonnet-20241022']).toBe('claude-sonnet-5-5');
    expect(CLAUDE_LEGACY_MODEL_UPGRADES['claude-3-haiku-20240307']).toBe('claude-haiku-4-5-20251001');
  });

  it('exposes Claude persistent effort capabilities and defaults', () => {
    // Ceiling is `xhigh`: the claude-cli settings schema declares
    // effortLevel as X(["low","medium","high","xhigh"]). `max` is
    // session-scoped (the --effort flag only) and must never be persisted.
    expect(CLAUDE_MODEL_REASONING_EFFORTS).toEqual({
      'claude-fable-5-1': ['low', 'medium', 'high', 'xhigh'],
      'claude-fable-5': ['low', 'medium', 'high', 'xhigh'],
      'claude-opus-5-5': ['low', 'medium', 'high', 'xhigh'],
      'claude-opus-5': ['low', 'medium', 'high', 'xhigh'],
      'claude-opus-4-8': ['low', 'medium', 'high', 'xhigh'],
      'claude-sonnet-5-5': ['low', 'medium', 'high', 'xhigh'],
      'claude-sonnet-5': ['low', 'medium', 'high', 'xhigh'],
      'claude-opus-4-7': ['low', 'medium', 'high', 'xhigh'],
      'claude-sonnet-4-6': ['low', 'medium', 'high'],
      'claude-haiku-5-5': ['low', 'medium', 'high', 'xhigh'],
      'claude-opus-4-6': ['low', 'medium', 'high'],
      'claude-opus-4-5-20251101': [],
      'claude-haiku-4-5-20251001': [],
    });
    expect(CLAUDE_MODEL_DEFAULT_REASONING_EFFORTS).toEqual({
      'claude-fable-5-1': 'high',
      'claude-fable-5': 'high',
      'claude-opus-5-5': 'medium',
      'claude-opus-5': 'high',
      'claude-opus-4-8': 'high',
      'claude-sonnet-5-5': 'medium',
      'claude-sonnet-5': 'high',
      'claude-opus-4-7': 'xhigh',
      'claude-sonnet-4-6': 'high',
      'claude-haiku-5-5': 'medium',
      'claude-opus-4-6': 'high',
      'claude-opus-4-5-20251101': null,
      'claude-haiku-4-5-20251001': null,
    });
  });
});

describe('normalizeStoredModel', () => {
  it('passes through supported models', () => {
    expect(normalizeStoredModel('gpt-6-astra')).toBe('gpt-6-astra');
    expect(normalizeStoredModel('gpt-5.6-terra')).toBe('gpt-5.6-terra');
    expect(normalizeStoredModel('gpt-5.3-codex-spark')).toBe('gpt-6-astra');
  });

  it('upgrades legacy models', () => {
    expect(normalizeStoredModel('gpt-5.4')).toBe('gpt-6-sol');
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

describe('Claude stored model migration', () => {
  it('heals deprecated top-level and environment selections and keeps active predecessors', () => {
    const opts = { applyCodexDefaults: false, engine: 'claude' as const };
    expect(normalizeSettings({ model: 'claude-sonnet-4-5-20250929', env: { ANTHROPIC_MODEL: 'claude-opus-4-1-20250805', CUSTOM: 'claude-opus-4-1-20250805' } }, opts)).toMatchObject({
      model: 'claude-sonnet-5-5', env: { ANTHROPIC_MODEL: 'claude-opus-4-8', CUSTOM: 'claude-opus-4-1-20250805' },
    });
    expect(normalizeSettings({ model: 'claude-opus-4-6', effortLevel: 'high' }, opts)).toMatchObject({ model: 'claude-opus-4-6', effortLevel: 'high' });
    expect(normalizeClaudeModel('my-provider/Custom.Model')).toBe('my-provider/Custom.Model');
  });
});

describe('normalizeClaudeAdvisorModel', () => {
  it('exposes the tier alias allowlist', () => {
    // Haiku5.5 now has advisor rank4, but the native advisor picker still
    // offers only ["fable","opus","sonnet"] in Claude Code 2.1.312.
    expect(ADVISOR_MODEL_ALIASES).toEqual(['opus', 'sonnet', 'fable']);
  });
  it('accepts the tier aliases case-insensitively and trims', () => {
    expect(normalizeClaudeAdvisorModel('opus')).toBe('opus');
    expect(normalizeClaudeAdvisorModel('  Sonnet ')).toBe('sonnet');
    expect(normalizeClaudeAdvisorModel('FABLE')).toBe('fable');
    // Dropped: the CLI silently discards it, so the fleet must not offer it.
    expect(normalizeClaudeAdvisorModel('HAIKU')).toBeNull();
  });

  it('rejects an advisor the session model outranks', () => {
    // rank(base) must be <= rank(advisor); unknown ids bail open, as upstream does.
    expect(claudeAdvisorPairIsValid('claude-sonnet-5', 'opus')).toBe(true);
    expect(claudeAdvisorPairIsValid('claude-sonnet-5', 'fable')).toBe(true);
    expect(claudeAdvisorPairIsValid('claude-sonnet-4-6', 'sonnet')).toBe(true);
    // Opus5 (rank7) cannot be advised by current Sonnet5.5 (rank6).
    expect(claudeAdvisorPairIsValid('claude-opus-5', 'sonnet')).toBe(false);
    // Fable5.1 (rank9) outranks current Opus5.5 (rank7).
    expect(claudeAdvisorPairIsValid('claude-fable-5-1', 'opus')).toBe(false);
    expect(claudeAdvisorPairIsValid('claude-opus-4-8', 'sonnet')).toBe(true);
    expect(claudeAdvisorPairIsValid('claude-haiku-5-5', 'claude-opus-4-6')).toBe(false);
    // Below the minimum advisor rank entirely.
    expect(claudeAdvisorPairIsValid('claude-sonnet-5', 'claude-haiku-4-5')).toBe(false);
    // Unknown on either side -> allowed, matching the CLI's open bail-out.
    expect(claudeAdvisorPairIsValid('claude-future-9', 'opus')).toBe(true);
    expect(claudeAdvisorPairIsValid('claude-opus-5', 'claude-future-9')).toBe(true);
  });

  it('keeps a stored pair the session model cannot use visible instead of dropping it', () => {
    expect(normalizeSettings({ model: 'claude-sonnet-5', advisorModel: 'opus' },
      { applyCodexDefaults: false }).advisorModel).toBe('opus');
    // Read normalization is tolerant; authoring rejects and host rendering omits and reports.
    expect(normalizeSettings({ model: 'claude-opus-5', advisorModel: 'sonnet' },
      { applyCodexDefaults: false }).advisorModel).toBe('sonnet');
  });
  it('accepts catalog full model IDs (canonicalizing legacy ones) and rejects others (-> null)', () => {
    expect(normalizeClaudeAdvisorModel('claude-opus-4-8')).toBe('claude-opus-4-8');
    expect(normalizeClaudeAdvisorModel(' Claude-Opus-5-5 ')).toBe('claude-opus-5-5');
    expect(normalizeClaudeAdvisorModel('claude-opus-4-1')).toBe('claude-opus-4-8');
    expect(normalizeClaudeAdvisorModel('claude-haiku-5-5')).toBe('claude-haiku-5-5');
    expect(normalizeClaudeAdvisorModel('gpt-5')).toBeNull();
    expect(normalizeClaudeAdvisorModel('claude-opus-5-5[1m]')).toBeNull();
    expect(normalizeClaudeAdvisorModel('')).toBeNull();
    expect(normalizeClaudeAdvisorModel(undefined)).toBeNull();
  });
});

describe('Claude advisorModel authoring', () => {
  const render = (settings: Record<string, unknown>) => new ClientConfigService({} as never).render(settings, 'claude');
  it('stores and renders aliases and full model IDs the native CLI accepts', () => {
    expect(render({ model: 'claude-sonnet-5', advisorModel: 'claude-opus-5-5' }).settings.advisorModel).toBe('claude-opus-5-5');
    expect(render({ model: 'claude-sonnet-5', advisorModel: 'Fable' }).settings.advisorModel).toBe('fable');
    // Unknown session ranks stay permissive, like the native gate.
    expect(render({ model: 'my-proxy/model', advisorModel: 'sonnet' }).settings.advisorModel).toBe('sonnet');
    expect(render({ model: 'claude-sonnet-5', advisorModel: '' }).settings).not.toHaveProperty('advisorModel');
  });
  it.each([
    [{ advisorModel: 'gpt-5' }, 'settings.advisorModel', 'unknown advisor model "gpt-5"; use opus, sonnet, fable or a full Claude model ID'],
    [{ advisorModel: 'haiku' }, 'settings.advisorModel', 'unknown advisor model "haiku"'],
    [{ advisorModel: 42 }, 'settings.advisorModel', 'expected a model alias or ID string'],
    [{ model: 'claude-sonnet-5', advisorModel: 'claude-haiku-4-5-20251001' }, 'settings.advisorModel', 'claude-haiku-4-5-20251001 cannot act as an advisor (advisor rank 1, minimum 2); Claude Code would run without an advisor'],
    [{ model: 'claude-opus-5', advisorModel: 'sonnet' }, 'settings.advisorModel', 'session model claude-opus-5 outranks advisor sonnet (rank 7 > 6); Claude Code would run without an advisor'],
    [{ model: 'claude-fable-5-1', native_settings: { advisorModel: 'opus' } }, 'native_settings.advisorModel', 'session model claude-fable-5-1 outranks advisor opus'],
    [{ native_settings: { advisorModel: 'claude-haiku-4-5' } }, 'native_settings.advisorModel', 'cannot act as an advisor'],
  ])('rejects %j on save instead of silently dropping it', (settings, param, message) => {
    expect(() => render(settings)).toThrow(expect.objectContaining({ status: 422, param, message: expect.stringContaining(message) }));
  });
  it('keeps unknown native advisor IDs permissive, like the native rank gate', () => {
    expect(render({ model: 'claude-opus-5', native_settings: { advisorModel: 'vendor/custom-advisor' } }).settings.native_settings)
      .toEqual({ advisorModel: 'vendor/custom-advisor' });
  });
  it('reports a stored invalid value on admin reads instead of normalizing it away', async () => {
    const db = createDbFake();
    db.tables.set(clientConfigDocuments, [{ id: 1, engine: 'claude', settings: { model: 'claude-opus-5', advisorModel: 'sonnet' }, body: '{}\n', sha256: '0'.repeat(64), updatedAt: '2026-10-28T00:00:00Z' }]);
    const fetched = await new ClientConfigService(db as never).adminFetch('claude');
    expect(fetched.settings).toMatchObject({ advisorModel: 'sonnet' });
    expect(fetched.validation_error).toMatchObject({ param: 'settings.advisorModel', message: expect.stringContaining('outranks') });
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
  it('exposes the current upstream `claude --permission-mode` choices, plus the legacy `default` alias', () => {
    expect(CLAUDE_PERMISSION_MODES).toEqual([
      'default',
      'manual',
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
    expect(normalizeReasoningEffort('LOW')).toBe('low');
    expect(normalizeReasoningEffort('high')).toBe('high');
    expect(normalizeReasoningEffort('xhigh')).toBe('xhigh');
    expect(normalizeReasoningEffort('MAX')).toBe('max');
    expect(normalizeReasoningEffort('ultra')).toBe('ultra');
  });
  it('rejects unknown values, including the retired `minimal` tier (no current model supports it)', () => {
    expect(normalizeReasoningEffort('extreme')).toBeNull();
    expect(normalizeReasoningEffort('minimal')).toBeNull();
  });
  it('restricts effort to those supported by model', () => {
    expect(normalizeReasoningEffortForModel('max', 'gpt-6-astra')).toBe('max');
    // Astra gained `ultra` in the CLI catalog.
    expect(normalizeReasoningEffortForModel('ultra', 'gpt-6-astra')).toBe('ultra');
    expect(normalizeReasoningEffortForModel('high', 'gpt-6-luna')).toBe('high');
    expect(normalizeReasoningEffortForModel('ultra', 'gpt-5.6-terra')).toBe('ultra');
    expect(normalizeReasoningEffortForModel('ultra', 'gpt-5.6-luna')).toBeNull();
    expect(normalizeReasoningEffortForModel('minimal', 'gpt-6-luna')).toBeNull();
    expect(normalizeReasoningEffortForModel('ultra', 'gpt-6-luna')).toBeNull();
  });

  it('returns each model native Codex default effort', () => {
    expect(defaultCodexReasoningEffortForModel('gpt-6-astra')).toBe('low');
    expect(defaultCodexReasoningEffortForModel('gpt-5.6-sol')).toBe('low');
    expect(defaultCodexReasoningEffortForModel('gpt-5.6-terra')).toBe('medium');
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
    expect(s.model).toBe('gpt-6-astra');
    expect(s.model_reasoning_effort).toBe('low');
    expect(s.notify).toEqual([]);
    expect(s.orchestrator_mcp_enabled).toBe(true);
    expect(s.features).toEqual({});
    expect(s.profiles).toEqual([]);
    expect(s.mcp_servers).toEqual([]);
  });

  it('uses the selected Codex model default when effort is absent or incompatible', () => {
    expect(normalizeSettings({ model: 'gpt-5.6-sol' }).model_reasoning_effort).toBe('low');
    expect(normalizeSettings({
      model: 'gpt-5.5',
      model_reasoning_effort: 'minimal',
    }).model_reasoning_effort).toBe('low');
    expect(normalizeSettings({
      profiles: [{ name: 'luna', model: 'gpt-5.6-luna', model_reasoning_effort: 'ultra' }],
    }).profiles).toEqual([
      { name: 'luna', model: 'gpt-5.6-luna', model_reasoning_effort: 'medium' },
    ]);
  });

  it('upgrades legacy models while preserving compatible reasoning', () => {
    const s = normalizeSettings({
      model: 'gpt-5.1-codex-max',
      model_reasoning_effort: 'medium',
    });
    expect(s.model).toBe(FORCE_UPGRADE_MODEL);
    expect(s.model_reasoning_effort).toBe('medium');
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
    // web_search is Codex's string enum, not a boolean; a legacy truthy value
    // migrates to 'live' rather than rendering a boolean Codex would reject.
    expect(s.web_search).toBe('live');
    expect(s.model_supports_reasoning_summaries).toBe(true);
  });

  it('strips invalid notify entries', () => {
    const s = normalizeSettings({ notify: ['mailto:a@b', 42, null, '  ', 'webhook'] });
    expect(s.notify).toEqual(['mailto:a@b', 'webhook']);
  });

  it('attaches advisorModel, omits it when off and keeps unknown stored values for correction', () => {
    expect(normalizeSettings({ advisorModel: 'opus' }).advisorModel).toBe('opus');
    expect(normalizeSettings({ advisorModel: 'OPUS' }).advisorModel).toBe('opus');
    expect(normalizeSettings({}).advisorModel).toBeUndefined();
    expect(normalizeSettings({ advisorModel: '  ' }).advisorModel).toBeUndefined();
    expect(normalizeSettings({ advisorModel: 'gpt-5' }).advisorModel).toBe('gpt-5');
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
      // A retired mini profile keeps its compatible authored effort.
      {
        name: 'tiny',
        model: 'gpt-6-luna',
        model_reasoning_effort: 'xhigh',
      },
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

describe('normalizeClaudeStatusLine', () => {
  it('keeps typed padding/refreshInterval and drops wrongly typed or unknown keys', () => {
    expect(
      normalizeClaudeStatusLine({ type: 'command', command: 'x', padding: 2, refreshInterval: 5, extra: 1 }),
    ).toEqual({ type: 'command', command: 'x', padding: 2, refreshInterval: 5 });
    expect(
      normalizeClaudeStatusLine({ type: 'command', command: 'x', padding: '2', refreshInterval: 0 }),
    ).toEqual({ type: 'command', command: 'x' });
  });
});

describe('normalizeApprovalPolicy', () => {
  it('heals the removed `untrusted` policy to `on-request`', () => {
    expect(normalizeApprovalPolicy('untrusted')).toBe('on-request');
    expect(normalizeApprovalPolicy(' Untrusted ')).toBe('on-request');
    expect(normalizeApprovalPolicy('never')).toBe('never');
    expect(normalizeApprovalPolicy('bogus')).toBeNull();
  });
});
