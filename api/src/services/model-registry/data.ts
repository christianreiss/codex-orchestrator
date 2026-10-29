/**
 * THE fleet model registry: every Codex, Claude and Grok model the fleet knows,
 * defined once. Every list, effort table, tier, upgrade map, signed launch
 * catalog and admin picker derives from this file (docs/model-registry.md).
 *
 * Adding or changing a model: edit this file, run `npm run models:generate`
 * (frontend constants + docs tier table) and update the registry snapshot.
 * Native facts come from the CLI's own catalog, never from the provider API.
 */
import type { ModelEntry } from './types.js';

const CODEX_FULL = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'] as const;
const CODEX_NO_ULTRA = ['low', 'medium', 'high', 'xhigh', 'max'] as const;

/**
 * Codex: `visibility == "list"` and not officially deprecated or retired in the
 * CLI's `models_cache.json`. `gpt-reserve` and `codex-auto-review` are hidden and
 * stay out. A catalog `upgrade` block is only a nudge, not a deprecation (the
 * GPT-5.6 rows carry one with `retirement_at: null`). Efforts and defaults
 * verified against codex-cli 0.164.0's account catalog, 2026-10-26, and the
 * bundled 0.165.0 catalog, 2026-10-28. Not filtered on `supported_in_api`: the
 * gateway serves through `codex exec` under ChatGPT auth.
 */
export const CODEX_MODELS = [
  // gpt-5.5 was retired for ChatGPT sign-in on 2026-10-14 (the bundled 0.165.0
  // catalog still lists it for API-key sessions); it heals to GPT-6.1 Sol.
  { id: 'gpt-6.1-sol', label: 'GPT-6.1 Sol', family: 'sol', tier: 3, status: 'active', efforts: CODEX_FULL, defaultEffort: 'low', upgradesFrom: ['gpt-5.5'] },
  // Native availability from CLI 0.159.0 (official models reference, 2026-10-26).
  { id: 'gpt-6.1-terra', label: 'GPT-6.1 Terra', family: 'terra', tier: 2, status: 'active', efforts: CODEX_FULL, defaultEffort: 'low', minCliVersion: '0.159.0' },
  // UNVERIFIED (2026-10-29): operator report that Luna 6.1 is released. The id
  // follows the 6.1 Sol/Terra pattern, but the codex-cli 0.165.0 account catalog
  // fetched 2026-10-29T06:47Z and the 0.165.0 binary do not list it. Efforts and
  // default copy GPT-6 Luna; no CLI floor is invented. Gated until an account
  // catalog shows it: then drop `liveCatalogRequired` and confirm the efforts.
  { id: 'gpt-6.1-luna', label: 'GPT-6.1 Luna', family: 'luna', tier: 1, status: 'active', efforts: CODEX_NO_ULTRA, defaultEffort: 'medium', liveCatalogRequired: true },
  // Native catalog default is `medium`; `low` by operator decision 2026-10-28,
  // matching the 0.165.0 bundled catalog. Per-host and fleet overrides still win.
  { id: 'gpt-6-astra', label: 'GPT-6 Astra', family: 'astra', tier: 5, status: 'active', efforts: CODEX_FULL, defaultEffort: 'low' },
  // https://learn.chatgpt.com/docs/models, verified 2026-10-26.
  { id: 'gpt-6-sol', label: 'GPT-6 Sol', family: 'sol', tier: 3, status: 'active', efforts: CODEX_FULL, defaultEffort: 'medium', upgradesFrom: ['gpt-5.4'] },
  { id: 'gpt-6-luna', label: 'GPT-6 Luna', family: 'luna', tier: 1, status: 'active', efforts: CODEX_NO_ULTRA, defaultEffort: 'medium', upgradesFrom: ['gpt-5.4-mini'] },
  { id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol', family: 'sol', tier: 3, status: 'active', efforts: CODEX_FULL, defaultEffort: 'low' },
  { id: 'gpt-5.6-terra', label: 'GPT-5.6 Terra', family: 'terra', tier: 2, status: 'active', efforts: CODEX_FULL, defaultEffort: 'medium' },
  { id: 'gpt-5.6-luna', label: 'GPT-5.6 Luna', family: 'luna', tier: 1, status: 'active', efforts: CODEX_NO_ULTRA, defaultEffort: 'medium' },
] as const satisfies readonly ModelEntry[];

/** Fleet defaults for new Codex configs and OpenAI-compatible requests. */
export const CODEX_DEFAULT_MODEL = 'gpt-6-astra';
export const CODEX_DEFAULT_EFFORT = 'low';

/**
 * Retired Codex ids the catalog names no replacement for: they follow the
 * fleet default (the forced upgrade), not a fixed successor.
 * `gpt-5.3-codex-spark` left the catalog and binary in codex-cli 0.158.0; a
 * live call is rejected "not supported when using Codex with a ChatGPT account".
 */
export const CODEX_FORCED_UPGRADES_FROM = [
  'gpt-5.3-codex',
  'gpt-5.2',
  'gpt-5.2-codex',
  'gpt-5.1-codex-max',
  'gpt-5.1-codex-mini',
  'gpt-5.3-codex-spark',
] as const;

const CLAUDE_ADAPTIVE = ['low', 'medium', 'high', 'xhigh'] as const;
const CLAUDE_CAPPED = ['low', 'medium', 'high'] as const;
const CLAUDE_1M = { maxInputTokens: 1_000_000, maxTokens: 128_000 } as const;
const CLAUDE_200K = { maxInputTokens: 200_000, maxTokens: 64_000 } as const;

/**
 * Claude: public, non-deprecated models verified 2026-10-28 against the vendor
 * lifecycle table and Claude Code 2.1.312's first-party native catalog.
 * Restricted-access Mythos models are not general fleet choices.
 *
 * - efforts: persisted native levels (code.claude.com/docs/en/model-config,
 *   2026-10-28). Opus 4.5 / Haiku 4.5 have no native effort control; Opus and
 *   Sonnet 4.6 stop at `high` for persisted settings but accept session `max`.
 * - minCliVersion: native Claude Code availability, same source.
 * - legacyUserEffort: the pre-per-model top-level `effortLevel` still applies;
 *   Opus 5.5 and every release after it ignore it.
 * - advisorRank: `advisor_rank` read out of the 2.1.312 binary, 2026-10-28.
 * - upgradesFrom: the "Recommended replacement" column of
 *   platform.claude.com/docs/en/about-claude/model-deprecations (2026-10-28).
 */
export const CLAUDE_MODELS = [
  { id: 'claude-fable-5-1', label: 'Fable 5.1', family: 'fable', tier: 5, status: 'active', efforts: CLAUDE_ADAPTIVE, defaultEffort: 'high', minCliVersion: '2.1.257', sessionEfforts: ['max'], legacyUserEffort: true, advisorRank: 9, api: { ...CLAUDE_1M, line: 'fable' } },
  { id: 'claude-fable-5', label: 'Fable 5', family: 'fable', tier: 5, status: 'active', efforts: CLAUDE_ADAPTIVE, defaultEffort: 'high', sessionEfforts: ['max'], legacyUserEffort: true, advisorRank: 8, api: { ...CLAUDE_1M, line: 'fable' } },
  { id: 'claude-opus-5-5', label: 'Opus 5.5', family: 'opus', tier: 4, status: 'active', efforts: CLAUDE_ADAPTIVE, defaultEffort: 'medium', minCliVersion: '2.1.280', sessionEfforts: ['max'], advisorRank: 7, api: { ...CLAUDE_1M, line: 'opus' } },
  { id: 'claude-opus-5', label: 'Opus 5', family: 'opus', tier: 4, status: 'active', efforts: CLAUDE_ADAPTIVE, defaultEffort: 'high', sessionEfforts: ['max'], legacyUserEffort: true, advisorRank: 7, api: { ...CLAUDE_1M, line: 'opus' } },
  {
    id: 'claude-opus-4-8', label: 'Opus 4.8', family: 'opus', tier: 4, status: 'active', efforts: CLAUDE_ADAPTIVE, defaultEffort: 'high', sessionEfforts: ['max'], legacyUserEffort: true, advisorRank: 5, api: { ...CLAUDE_1M, line: 'opus' },
    upgradesFrom: ['claude-3-opus-20240229', 'claude-opus-4-20250514', 'claude-opus-4-1-20250805', 'claude-opus-4-1', 'claude-opus-4-0', 'claude-2.0', 'claude-2.1'],
  },
  {
    id: 'claude-sonnet-5-5', label: 'Sonnet 5.5', family: 'sonnet', tier: 3, status: 'active', efforts: CLAUDE_ADAPTIVE, defaultEffort: 'medium', minCliVersion: '2.1.284', sessionEfforts: ['max'], advisorRank: 6, api: { ...CLAUDE_1M, line: 'sonnet' },
    upgradesFrom: [
      'claude-3-5-sonnet-20240620', 'claude-3-5-sonnet-20241022', 'claude-3-5-sonnet-latest', 'claude-sonnet-4-20250514',
      'claude-sonnet-4-5', 'claude-sonnet-4-5-20250929', 'claude-sonnet-4-5-latest', 'claude-sonnet-4-0',
      'claude-3-7-sonnet-20250219', 'claude-3-7-sonnet', 'claude-3-5-sonnet', 'claude-3-7-sonnet-latest', 'claude-3-sonnet-20240229',
    ],
  },
  { id: 'claude-sonnet-5', label: 'Sonnet 5', family: 'sonnet', tier: 3, status: 'active', efforts: CLAUDE_ADAPTIVE, defaultEffort: 'high', sessionEfforts: ['max'], legacyUserEffort: true, advisorRank: 4, api: { ...CLAUDE_1M, line: 'sonnet' } },
  { id: 'claude-opus-4-7', label: 'Opus 4.7', family: 'opus', tier: 4, status: 'active', efforts: CLAUDE_ADAPTIVE, defaultEffort: 'xhigh', sessionEfforts: ['max'], legacyUserEffort: true, advisorRank: 5, api: { ...CLAUDE_1M, line: 'opus' } },
  { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6', family: 'sonnet', tier: 3, status: 'active', efforts: CLAUDE_CAPPED, defaultEffort: 'high', sessionEfforts: ['max'], legacyUserEffort: true, advisorRank: 2, api: { ...CLAUDE_1M, line: 'sonnet' } },
  { id: 'claude-haiku-5-5', label: 'Haiku 5.5', family: 'haiku', tier: 1, status: 'active', efforts: CLAUDE_ADAPTIVE, defaultEffort: 'medium', minCliVersion: '2.1.293', sessionEfforts: ['max'], advisorRank: 4, api: { ...CLAUDE_1M, line: 'haiku' } },
  { id: 'claude-opus-4-6', label: 'Opus 4.6', family: 'opus', tier: 4, status: 'active', efforts: CLAUDE_CAPPED, defaultEffort: 'high', sessionEfforts: ['max'], legacyUserEffort: true, advisorRank: 3, api: { ...CLAUDE_1M, line: 'opus' } },
  { id: 'claude-opus-4-5-20251101', label: 'Opus 4.5', family: 'opus', tier: 4, status: 'active', efforts: [], defaultEffort: null, aliases: ['claude-opus-4-5'], api: { ...CLAUDE_200K, line: 'opus' } },
  {
    id: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5', family: 'haiku', tier: 1, status: 'active', efforts: [], defaultEffort: null, aliases: ['claude-haiku-4-5'], advisorRank: 1, api: { ...CLAUDE_200K, line: 'haiku' },
    upgradesFrom: [
      'claude-3-haiku-20240307', 'claude-3-5-haiku-latest', 'claude-3-5-haiku', 'claude-3-5-haiku-20241022',
      'claude-1.0', 'claude-1.1', 'claude-1.2', 'claude-1.3', 'claude-instant-1.0', 'claude-instant-1.1', 'claude-instant-1.2',
    ],
  },
] as const satisfies readonly ModelEntry[];

export const CLAUDE_DEFAULT_MODEL = 'claude-sonnet-5';

/**
 * Native advisor aliases and the concrete model the CLI's catalog resolves each
 * to (`aliases:{opus:{default:"claude-opus-5-5"},...}`, Claude Code 2.1.312).
 * Order is the order operators see. `haiku` stays absent: the native advisor
 * picker still offers only fable/opus/sonnet.
 */
export const CLAUDE_ADVISOR_ALIASES = {
  opus: 'claude-opus-5-5',
  sonnet: 'claude-sonnet-5-5',
  fable: 'claude-fable-5-1',
} as const;

const GROK_ADAPTIVE = ['low', 'medium', 'high', 'xhigh'] as const;

/**
 * Grok Build 1.0.46's subscription catalog, re-verified 2026-10-03 against the
 * live `cli-chat-proxy.grok.com/v1/models` listing and its `default_model`.
 * API-key catalog ids are separate. `grok-4.7-build-fast` is Grok 4.7 on faster
 * infrastructure (docs/model-tiers.md), so it shares 4.7's class.
 */
export const GROK_MODELS = [
  { id: 'grok-4.7', label: 'Grok 4.7', family: 'grok', tier: 2, status: 'active', efforts: GROK_ADAPTIVE, defaultEffort: 'high' },
  { id: 'grok-4.7-build-fast', label: 'Grok 4.7 Fast', family: 'grok-build-fast', tier: 2, status: 'active', efforts: GROK_ADAPTIVE, defaultEffort: 'high' },
  { id: 'grok-4.6', label: 'Grok 4.6', family: 'grok', tier: 2, status: 'active', efforts: GROK_ADAPTIVE, defaultEffort: 'high' },
  { id: 'grok-4.5', label: 'Grok 4.5', family: 'grok', tier: 1, status: 'active', efforts: ['low', 'medium', 'high'], defaultEffort: 'high' },
] as const satisfies readonly ModelEntry[];

export const GROK_DEFAULT_MODEL = 'grok-4.7';
