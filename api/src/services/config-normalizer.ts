/**
 * Port of src/Services/ConfigNormalizer.php (the essential subset). This
 * service exposes the constants the legacy admin config form relies on
 * (supported models, reasoning efforts, personalities) and produces a
 * normalized settings object that the TOML renderer in `client-config.ts`
 * consumes. The shape preserves the legacy section order:
 *
 *   model / model_provider / local_provider / profile / personality /
 *   approval_policy / sandbox_mode / web_search / model_reasoning_effort /
 *   model_reasoning_summary / model_verbosity / model_supports_reasoning_summaries /
 *   model_context_window / model_max_output_tokens / notify
 *
 * followed by section tables: [features], [notice], [security],
 * [sandbox_workspace_write], [shell_environment_policy], [[profiles]],
 * [[mcp_servers]].
 *
 * That field order is still the accepted-input/normalized shape, but as of
 * codex-cli 0.156.1 (reproduced live, 2026-09-23) it is no longer what
 * `client-config.ts`'s `renderToml` writes verbatim: `local_provider` is
 * rendered as `oss_provider` (upstream rename), `profile` is never rendered
 * at top level (a literal `profile = "…"` is now a hard boot error, not a
 * warning — kept here only for `applyHostModelOverrides`' internal profile
 * routing), and `model_supports_reasoning_summaries` /
 * `model_max_output_tokens` are accepted for ingest but dropped from every
 * render (top-level and per-profile) — codex-cli reports both `ignored`
 * everywhere. See `renderToml` for the exact skip/rename lists.
 */

import { createHash } from 'node:crypto';
import { ValidationError } from '../http/errors.js';
import { CODEX_RETIRED_FEATURE_KEYS, normalizeCodexNativeSettings, validateCodexFeatureDocument, type CodexApprovalPolicy } from './codex-native-settings.js';
import { CODEX_WEB_SEARCH_VALUES, type CodexWebSearch } from './agent-security-levels.js';
import { CLAUDE_LEGACY_MODEL_UPGRADES as CLAUDE_MODEL_UPGRADES, CLAUDE_MODEL_REASONING_EFFORTS, CLAUDE_MODEL_ENV_KEYS, normalizeClaudeModelReference } from './claude-models.js';
import { normalizeClaudeNativeSettings } from './claude-native-settings.js';
import { DEFAULT_CODEX_MODEL, DEFAULT_CODEX_REASONING_EFFORT, LEGACY_MODEL_UPGRADES } from './codex-model-upgrades.js';
import { MODEL_REASONING_EFFORTS, CODEX_MODEL_DEFAULT_REASONING_EFFORTS } from './codex-model-capabilities.js';
export { DEFAULT_CODEX_MODEL, DEFAULT_CODEX_REASONING_EFFORT, FORCE_UPGRADE_MODEL, FORCE_UPGRADE_REASONING_EFFORT, LEGACY_MODEL_UPGRADES } from './codex-model-upgrades.js';

/**
 * Codex model ids the fleet offers. Derived from the CLI's own catalog
 * (`models_cache.json`): an entry belongs here iff `visibility == "list"` and
 * `upgrade == null`. `gpt-reserve` and `codex-auto-review` are `visibility:
 * hide` and stay out; a model that grows an `upgrade` block is deprecated
 * upstream and moves to LEGACY_MODEL_UPGRADES.
 *
 * Deliberately NOT filtered on the catalog's `supported_in_api` flag: that
 * describes OpenAI's platform API, and this list also feeds `/v1/models`, which
 * is served by the codex runner shelling out to `codex exec` under ChatGPT
 * auth, so an entry with `supported_in_api: false` would still be servable.
 *
 * Verified against models_cache.json from codex-cli 0.164.0, 2026-10-26.
 * GPT-5.5 is already hidden and deprecated, before its October 14 retirement;
 * the fleet migrates it now to the catalog replacement, GPT-6.1 Sol.
 */
export const SUPPORTED_MODELS: readonly string[] = [
  'gpt-6.1-sol',
  'gpt-6.1-terra',
  'gpt-6-astra',
  'gpt-6-sol',
  'gpt-6-luna',
  'gpt-5.6-sol',
  'gpt-5.6-terra',
  'gpt-5.6-luna',
];

// Stored and request-side selections use one migration map so a deprecated ID
// cannot survive one render path or migrate to a model the gateway rejects.
export const CLAUDE_LEGACY_MODEL_UPGRADES: Readonly<Record<string, string>> = CLAUDE_MODEL_UPGRADES;

/**
 * Own-property lookup into the upgrade maps above. Model ids arrive from clients
 * and stored overrides, so a bare index would resolve `toString`, `constructor`
 * or `__proto__` to an inherited Object.prototype member.
 */
function legacyUpgrade(map: Readonly<Record<string, string>>, key: string): string | undefined {
  return Object.prototype.hasOwnProperty.call(map, key) ? map[key] : undefined;
}

/** Same own-property guard for the per-model effort tables below. */
export function modelEntry<T>(map: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.prototype.hasOwnProperty.call(map, key) ? map[key] : undefined;
}

export const REASONING_EFFORTS: readonly string[] = [
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
  'ultra',
];

export { MODEL_REASONING_EFFORTS, CODEX_MODEL_DEFAULT_REASONING_EFFORTS } from './codex-model-capabilities.js';

export { CLAUDE_MODEL_REASONING_EFFORTS, CLAUDE_MODEL_DEFAULT_REASONING_EFFORTS } from './claude-models.js';

export const PERSONALITIES: readonly string[] = ['friendly', 'pragmatic', 'none'];

// `untrusted` is gone: codex-cli 0.158.0 refuses to load a config that carries it
// ("approval_policy = \"untrusted\" is no longer supported; remove this setting"),
// which takes `codex mcp list` and every launch down with it. normalizeApprovalPolicy
// heals a stored `untrusted` to the nearest remaining policy, `on-request`.
export const APPROVAL_POLICIES: readonly string[] = ['on-request', 'never'];

export const DROPPED_FEATURE_KEYS = CODEX_RETIRED_FEATURE_KEYS;

export interface NormalizedSettings {
  /** Engine-native opt-in fields, validated by that engine's current schema or catalog. */
  native_settings?: Record<string, unknown>;
  model: string | null;
  model_provider: string | null;
  local_provider: string | null;
  profile: string | null;
  personality: string;
  approval_policy: CodexApprovalPolicy | null;
  sandbox_mode: string | null;
  web_search: CodexWebSearch | null;
  model_reasoning_effort: string | null;
  model_reasoning_summary: string | null;
  model_verbosity: string | null;
  model_supports_reasoning_summaries: boolean | null;
  model_context_window: number | null;
  model_max_output_tokens: number | null;
  notify: string[];
  orchestrator_mcp_enabled: boolean;
  security: { dangerously_bypass_approvals_and_sandbox: boolean | null };
  features: Record<string, unknown>;
  notice: Record<string, unknown>;
  sandbox_workspace_write: Record<string, unknown>;
  shell_environment_policy: Record<string, unknown>;
  profiles: Array<Record<string, unknown>>;
  mcp_servers: Array<Record<string, unknown>>;
  // Claude-only settings.json sub-blocks. Optional: absent on codex configs so
  // the codex TOML render (fixed allowlist) and its settings hash are unaffected.
  hooks?: Record<string, unknown>;
  statusLine?: Record<string, unknown>;
  permissions?: { allow: string[]; ask: string[]; deny: string[] };
  permissionMode?: string;
  env?: Record<string, string>;
  advisorModel?: string;
  effortLevel?: string;
  reasoning_effort?: string;
  // Grok's native per-model default context window, in tokens.
  context_window?: number;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * `[shell_environment_policy]` as codex-cli parses it: `set` is a string map
 * (`invalid type: sequence, expected a map in shell_environment_policy.set`
 * otherwise, confirmed live 2026-10-12). Stored documents carry the legacy
 * `set = []`, so an array is healed here: `KEY=VALUE` strings become map
 * entries, anything else is dropped. Every other key passes through.
 */
function normalizeShellEnvironmentPolicy(value: unknown): Record<string, unknown> {
  const policy = { ...asRecord(value) };
  if (!('set' in policy)) return policy;
  const set = policy.set;
  if (Array.isArray(set)) {
    const entries: Record<string, string> = {};
    for (const item of set) {
      if (typeof item !== 'string') continue;
      const eq = item.indexOf('=');
      if (eq > 0) entries[item.slice(0, eq)] = item.slice(eq + 1);
    }
    if (Object.keys(entries).length > 0) policy.set = entries;
    else delete policy.set;
  } else if (set === null || typeof set !== 'object') {
    delete policy.set;
  }
  return policy;
}

export function normalizeString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

export function normalizeBool(value: unknown, fallback: boolean | null = null): boolean | null {
  if (typeof value === 'boolean') return value;
  if (value === 1 || value === '1' || value === 'true' || value === 'yes' || value === 'on') return true;
  if (value === 0 || value === '0' || value === 'false' || value === 'no' || value === 'off') return false;
  if (value === null || value === undefined) return fallback;
  return fallback;
}

export function normalizeInt(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === 'string' && value.trim() !== '' && /^-?\d+$/.test(value.trim())) {
    return parseInt(value.trim(), 10);
  }
  return null;
}

export function normalizeStoredModel(value: unknown): string | null {
  const s = normalizeString(value);
  if (s === null) return null;
  const upgraded = legacyUpgrade(LEGACY_MODEL_UPGRADES, s);
  if (upgraded !== undefined) return upgraded;
  if (SUPPORTED_MODELS.includes(s)) return s;
  // Pass-through any other model so wrappers can self-test newer models.
  return s;
}

export function isLegacyModelUpgrade(value: unknown): boolean {
  const s = normalizeString(value);
  if (s === null) return false;
  return legacyUpgrade(LEGACY_MODEL_UPGRADES, s) !== undefined;
}

export function normalizeSupportedModel(value: unknown): string | null {
  const s = normalizeString(value);
  if (s === null) return null;
  const upgraded = legacyUpgrade(LEGACY_MODEL_UPGRADES, s);
  if (upgraded !== undefined) return upgraded;
  return SUPPORTED_MODELS.includes(s) ? s : null;
}

export function normalizeClaudeModel(value: unknown): string | null {
  const s = normalizeString(value);
  if (s === null) return null;
  // Upgrade known legacy ids; pass through anything else verbatim so wrappers
  // can self-test newer models (the inference gate is the real allowlist).
  return normalizeClaudeModelReference(s);
}

export function normalizeReasoningEffort(value: unknown): string | null {
  const s = normalizeString(value);
  if (s === null) return null;
  const lower = s.toLowerCase();
  return REASONING_EFFORTS.includes(lower) ? lower : null;
}

export function normalizeReasoningEffortForModel(value: unknown, model: string | null): string | null {
  const effort = normalizeReasoningEffort(value);
  if (effort === null) return null;
  if (model === null) return effort;
  const supported = modelEntry(MODEL_REASONING_EFFORTS, model);
  if (!supported) return effort;
  return supported.includes(effort) ? effort : null;
}

export function defaultCodexReasoningEffortForModel(model: string | null): string | null {
  if (model === null) return null;
  return modelEntry(CODEX_MODEL_DEFAULT_REASONING_EFFORTS, model) ?? null;
}

/** Preserve compatible effort; only known retired references receive successor defaults. */
export function normalizeStoredCodexEffort(value: unknown, rawModel: unknown): string | null {
  const model = normalizeStoredModel(rawModel);
  return normalizeReasoningEffortForModel(value, model)
    ?? (isLegacyModelUpgrade(rawModel) ? defaultCodexReasoningEffortForModel(model) : null);
}

/** Claude settings.json `effortLevel`, constrained by the selected Claude model. */
export function normalizeClaudeEffortLevel(value: unknown, model: string | null): string | null {
  const effort = normalizeString(value)?.toLowerCase() ?? null;
  if (effort === null || model === null) return null;
  const supported = modelEntry(CLAUDE_MODEL_REASONING_EFFORTS, model);
  return supported?.includes(effort) ? effort : null;
}

export function normalizePersonality(value: unknown): string | null {
  const s = normalizeString(value);
  if (s === null) return null;
  const lower = s.toLowerCase();
  return PERSONALITIES.includes(lower) ? lower : null;
}

export function normalizeApprovalPolicy(value: unknown): CodexApprovalPolicy | null {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return normalizeCodexNativeSettings({ approval_policy: value })?.approval_policy as CodexApprovalPolicy;
  }
  const s = normalizeString(value);
  if (s === null) return null;
  const lower = s.toLowerCase();
  if (lower === 'untrusted' || lower === 'on-failure') return 'on-request';
  return APPROVAL_POLICIES.includes(lower) ? lower : null;
}

export function normalizeStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    const s = normalizeString(item);
    if (s !== null) out.push(s);
  }
  return out;
}

/**
 * Codex reads `web_search` as the string enum `disabled | cached | indexed |
 * live`, and rejects the whole config.toml if it is a boolean. Older stored
 * documents hold booleans, so those are mapped to the two ends rather than
 * dropped; anything else becomes null and the key is simply not emitted,
 * which is always safe.
 */
function normalizeWebSearch(value: unknown): CodexWebSearch | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') {
    const lowered = value.trim().toLowerCase();
    if (CODEX_WEB_SEARCH_VALUES.includes(lowered as CodexWebSearch)) {
      return lowered as CodexWebSearch;
    }
  }
  // Not one of Codex's values, so fall through to the boolean-ish forms a
  // stored document may still hold ("true"/"on"/1 and their opposites).
  const legacy = normalizeBool(value);
  if (legacy === null) return null;
  return legacy ? 'live' : 'disabled';
}

function normalizeLegacyWebSearch(settings: Record<string, unknown>): CodexWebSearch | null {
  const features = asRecord(settings.features);
  return normalizeWebSearch(settings.web_search ?? (
    features.web_search_request === true ? 'live'
      : features.web_search_cached === true ? 'cached'
        : features.web_search === true ? 'live'
          : ['web_search_request', 'web_search_cached', 'web_search'].some(key => features[key] === false) ? 'disabled' : undefined
  ));
}

function normalizeFeatures(value: unknown): Record<string, unknown> {
  const features = { ...asRecord(value) };
  if (features.hooks === undefined && features.codex_hooks !== undefined) features.hooks = features.codex_hooks;
  const cleaned: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(features)) {
    if (DROPPED_FEATURE_KEYS.includes(key) || key === 'guardianv2.thread_context') continue;
    if (key === 'web_search' || key === 'web_search_request' || key === 'web_search_cached') continue;
    cleaned[key] = raw && typeof raw === 'object' && !Array.isArray(raw)
      ? { ...raw as Record<string, unknown> }
      : typeof raw === 'boolean' ? raw : normalizeBool(raw, null);
  }
  const guardian = asRecord(cleaned.guardianv2);
  if (Object.hasOwn(guardian, 'thread_context')) delete guardian.thread_context;
  return cleaned;
}

/** Validate author input before stored-data coercions can discard invalid values. */
export function validateCodexFeatureAuthoring(raw: unknown): void {
  const input = asRecord(raw);
  const scopes: Array<[Record<string, unknown>, string]> = [[input, 'settings']];
  if (Array.isArray(input.profiles)) {
    input.profiles.forEach((profile, i) => scopes.push([asRecord(profile), `settings.profiles[${i}]`]));
  }
  for (const [scope, path] of scopes) {
    if (scope.features === undefined || scope.features === null) continue;
    if (typeof scope.features !== 'object' || Array.isArray(scope.features)) {
      throw new ValidationError(`${path}.features must be an object or null to clear it`, { param: `${path}.features` });
    }
    const features = { ...scope.features as Record<string, unknown> };
    for (const [key, value] of Object.entries(features)) {
      // Only value-preserving aliases retain authoring compatibility.
      if (['codex_hooks', 'web_search', 'web_search_request', 'web_search_cached'].includes(key)) {
        if (value !== null && typeof value !== 'boolean') {
          throw new ValidationError(`${path}.features.${key} must be boolean or null`, { param: `${path}.features.${key}` });
        }
        delete features[key];
        if (key === 'codex_hooks' && features.hooks === undefined) features.hooks = value;
      } else if (DROPPED_FEATURE_KEYS.includes(key) || key === 'guardianv2.thread_context') {
        throw new ValidationError(`${path}.features.${key} is removed or deprecated; omit it`, { param: `${path}.features.${key}` });
      }
    }
    if (Object.hasOwn(asRecord(features.guardianv2), 'thread_context')) {
      throw new ValidationError(`${path}.features.guardianv2.thread_context is removed; omit it`, { param: `${path}.features.guardianv2.thread_context` });
    }
    // These may be partial overlays. Check cross-field requirements after merging.
    validateCodexFeatureDocument(features, path, true);
  }
}

function normalizeProfiles(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return [];
  const out: Array<Record<string, unknown>> = [];
  for (const entry of value) {
    if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
      const input = entry as Record<string, unknown>;
      const native = normalizeCodexNativeSettings(input.native_settings);
      if (native && Object.keys(native).length > 0 && (typeof input.name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(input.name))) {
        throw new ValidationError('A native profile needs a file-safe name of 1–64 letters, digits, underscores or hyphens', { param: 'profiles.name' });
      }
      const profile: Record<string, unknown> = { ...input, ...(native !== undefined && { native_settings: native }) };
      if (profile.approval_policy !== undefined) profile.approval_policy = normalizeApprovalPolicy(profile.approval_policy);
      const webSearch = normalizeLegacyWebSearch(input);
      if (webSearch !== null) profile.web_search = webSearch;
      if (profile.features !== undefined) profile.features = normalizeFeatures(profile.features);
      const rawModel = profile.model;
      const model = normalizeStoredModel(rawModel);
      const reasoning = normalizeStoredCodexEffort(profile.model_reasoning_effort, rawModel)
        ?? ((profile.model_reasoning_effort != null || isLegacyModelUpgrade(rawModel)) && model !== null
          ? defaultCodexReasoningEffortForModel(model) : null);
      if (model !== null) profile.model = model;
      else delete profile.model;
      if (reasoning !== null) profile.model_reasoning_effort = reasoning;
      else delete profile.model_reasoning_effort;
      out.push(profile);
    }
  }
  return out;
}

function normalizeMcpServers(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return [];
  const out: Array<Record<string, unknown>> = [];
  for (const entry of value) {
    if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
      out.push({ ...(entry as Record<string, unknown>) });
    }
  }
  return out;
}

/**
 * Produce a fully normalized settings object matching the legacy PHP shape.
 */
export function normalizeSettings(
  raw: unknown,
  opts: { applyCodexDefaults?: boolean; engine?: 'codex' | 'claude' | 'grok' } = {},
): NormalizedSettings {
  const applyCodexDefaults = opts.applyCodexDefaults ?? true;
  const engine = opts.engine ?? (applyCodexDefaults ? 'codex' : 'claude');
  const isCodex = engine === 'codex';
  // 0071 explicitly migrates saved documents. New authoring must never silently
  // discard this newly retired option, including the legacy structured surface.
  if (isCodex) {
    const input = asRecord(raw);
    const scopes: Array<[Record<string, unknown>, string]> = [[input, 'settings']];
    if (Array.isArray(input.profiles)) {
      input.profiles.forEach((profile, i) => scopes.push([asRecord(profile), `settings.profiles[${i}]`]));
    }
    for (const [scope, path] of scopes) {
      if (Object.hasOwn(asRecord(scope.features), 'shell_zsh_fork')) {
        throw new ValidationError(`${path}.features.shell_zsh_fork is removed in Codex 0.163.0; omit it`, { param: `${path}.features.shell_zsh_fork` });
      }
    }
  }
  const native = isCodex ? normalizeCodexNativeSettings(asRecord(raw).native_settings) : undefined;
  const settings = asRecord(raw);
  const rawModel = settings.model ?? (applyCodexDefaults ? DEFAULT_CODEX_MODEL : undefined);
  const model = engine === 'claude' ? normalizeClaudeModel(rawModel) : normalizeStoredModel(rawModel);

  const personality = normalizePersonality(settings.personality) ?? 'friendly';
  const reasoning = normalizeStoredCodexEffort(settings.model_reasoning_effort, rawModel)
    ?? (applyCodexDefaults
      ? defaultCodexReasoningEffortForModel(model) ?? DEFAULT_CODEX_REASONING_EFFORT
      : null);

  const security = asRecord(settings.security);
  const securityBypass = normalizeBool(security.dangerously_bypass_approvals_and_sandbox);

  const out: NormalizedSettings = {
    ...(native !== undefined && { native_settings: native }),
    model,
    model_provider: normalizeString(settings.model_provider),
    local_provider: normalizeString(settings.local_provider),
    profile: normalizeString(settings.profile),
    personality,
    approval_policy: normalizeApprovalPolicy(settings.approval_policy),
    sandbox_mode: normalizeString(settings.sandbox_mode),
    web_search: normalizeLegacyWebSearch(settings),
    model_reasoning_effort: reasoning,
    model_reasoning_summary: normalizeString(settings.model_reasoning_summary),
    model_verbosity: normalizeString(settings.model_verbosity),
    model_supports_reasoning_summaries: normalizeBool(settings.model_supports_reasoning_summaries),
    model_context_window: normalizeInt(settings.model_context_window),
    model_max_output_tokens: normalizeInt(settings.model_max_output_tokens),
    notify: normalizeStringList(settings.notify),
    orchestrator_mcp_enabled: normalizeBool(settings.orchestrator_mcp_enabled, true) ?? true,
    security: { dangerously_bypass_approvals_and_sandbox: securityBypass },
    features: normalizeFeatures(settings.features),
    notice: asRecord(settings.notice),
    sandbox_workspace_write: asRecord(settings.sandbox_workspace_write),
    shell_environment_policy: normalizeShellEnvironmentPolicy(settings.shell_environment_policy),
    profiles: normalizeProfiles(settings.profiles),
    mcp_servers: normalizeMcpServers(settings.mcp_servers),
  };

  if (engine === 'claude') {
    const native = normalizeClaudeNativeSettings(settings.native_settings);
    if (Object.keys(native).length > 0) out.native_settings = native;
  }

  // Claude-only sub-blocks: attach only when present so codex configs keep
  // their exact normalized shape (and settings hash).
  const hooks = normalizeClaudeHooks(settings.hooks);
  if (hooks) out.hooks = hooks;
  const statusLine = normalizeClaudeStatusLine(settings.statusLine ?? settings.status_line);
  if (statusLine) out.statusLine = statusLine;
  const permissions = normalizeClaudePermissions(settings.permissions);
  if (permissions) out.permissions = permissions;
  const permissionMode = normalizeClaudePermissionMode(settings.permissionMode);
  if (permissionMode) out.permissionMode = permissionMode;
  const env = normalizeClaudeEnv(settings.env);
  if (env) out.env = env;
  // Drop an advisor the session model cannot actually use. Shipping it would
  // put a key on every host that the CLI silently ignores (see
  // claudeAdvisorPairIsValid for the two gates and what they log).
  const advisorModel = normalizeClaudeAdvisorModel(settings.advisorModel);
  if (advisorModel && claudeAdvisorPairIsValid(settings.model, advisorModel)) {
    out.advisorModel = advisorModel;
  }
  const effortLevel = normalizeClaudeEffortLevel(settings.effortLevel, model);
  if (effortLevel) out.effortLevel = effortLevel;

  return out;
}

/**
 * Allowed values for the Claude `advisorModel` settings.json key. These are
 * the short tier aliases Claude Code resolves itself to the current model
 * version (e.g. `opus` -> claude-opus-5); we deliberately store the alias,
 * not a pinned full id, so the experimental advisor tracks the latest model.
 * `fable` confirmed as a live `--model` alias against claude-cli 2.1.224,
 * 2026-08-08 (`claude --model fable -p ...` resolves and answers) — it was
 * missing here because this list predates the Fable tier. Alias set re-checked
 * on claude-cli 2.1.261, 2026-09-06: still these four.
 */
export const ADVISOR_MODEL_ALIASES = ['opus', 'sonnet', 'fable'] as const;

/**
 * `advisor_rank` exactly as baked into the claude-cli model catalog (read out of
 * the 2.1.296 binary, 2026-10-12). The CLI uses it for two separate gates:
 *
 *   var fZr = 2
 *   function Mtn(e){ ...; let t = HXe(e); return t !== void 0 && t >= fZr }
 *     -> a model may act as an advisor at all only when its rank is >= 2.
 *   function _ue(e,t){ ...; let r = UXe(e), o = HXe(t); ...; return r <= o }
 *     -> rank(session model) must be <= rank(advisor).
 *
 * Fail either and `z0e` logs "[AdvisorTool] Skipping advisor - ..." and silently
 * runs with no advisor. Nothing surfaces to the operator, which is why the fleet
 * validates the pair here instead of shipping a setting that quietly does nothing.
 */
export const CLAUDE_ADVISOR_RANKS: Readonly<Record<string, number>> = {
  'claude-haiku-5-5': 4,
  'claude-haiku-4-5': 1,
  'claude-haiku-4-5-20251001': 1,
  'claude-sonnet-4-6': 2,
  'claude-sonnet-5-5': 6,
  'claude-sonnet-5': 4,
  'claude-opus-4-6': 3,
  'claude-opus-4-7': 5,
  'claude-opus-4-8': 5,
  'claude-opus-5': 7,
  'claude-opus-5-5': 7,
  'claude-fable-5': 8,
  'claude-fable-5-1': 9,
};

/** Minimum `advisor_rank` to be usable as an advisor at all (the CLI's `fZr`). */
export const CLAUDE_MIN_ADVISOR_RANK = 2;

/**
 * Tier alias -> concrete model, as the CLI's own catalog resolves them
 * (`aliases:{opus:{default:"claude-opus-5-5"},sonnet:{default:"claude-sonnet-5-5"},
 * fable:{default:"claude-fable-5-1"}}`). `haiku` remains absent from ADVISOR_MODEL_ALIASES: although Haiku 5.5
 * now has rank 4, the native advisor picker still offers only
 * `["fable","opus","sonnet"]` in Claude Code 2.1.296.
 */
export const CLAUDE_ADVISOR_ALIAS_TARGETS: Readonly<Record<string, string>> = {
  opus: 'claude-opus-5-5',
  sonnet: 'claude-sonnet-5-5',
  fable: 'claude-fable-5-1',
};

function advisorRank(model: string | null): number | undefined {
  if (model === null) return undefined;
  const resolved = modelEntry(CLAUDE_ADVISOR_ALIAS_TARGETS, model) ?? model;
  return modelEntry(CLAUDE_ADVISOR_RANKS, resolved);
}

/**
 * Whether `advisorModel` can actually advise a session running `model`.
 * Unknown ids on either side return true — the CLI's own gates bail open when a
 * rank is missing (`if (r === void 0 || o === void 0) return !0`), so a model
 * this table has not learned about yet must not be rejected here either.
 */
export function claudeAdvisorPairIsValid(model: unknown, advisorModel: unknown): boolean {
  const advisor = normalizeString(advisorModel);
  if (advisor === null) return true;
  const advisorRankValue = advisorRank(advisor);
  if (advisorRankValue === undefined) return true;
  if (advisorRankValue < CLAUDE_MIN_ADVISOR_RANK) return false;
  const baseRankValue = advisorRank(normalizeString(model));
  if (baseRankValue === undefined) return true;
  return baseRankValue <= advisorRankValue;
}

/**
 * Claude settings.json `advisorModel` key (experimental advisor tool). Restricts
 * to the tier alias set; anything else (including empty / off) -> null so the
 * key is omitted and the wrapper removes it on the host. Intentionally NOT
 * routed through normalizeClaudeModel, which is a pass-through and would not
 * enforce the alias allowlist.
 */
export function normalizeClaudeAdvisorModel(value: unknown): string | null {
  const s = normalizeString(value);
  if (s === null) return null;
  const lower = s.toLowerCase();
  return (ADVISOR_MODEL_ALIASES as readonly string[]).includes(lower) ? lower : null;
}

/** Claude settings.json `env` block: a flat string map. Coerces scalars. */
export function normalizeClaudeEnv(value: unknown): Record<string, string> | null {
  const rec = asRecord(value);
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(rec)) {
    if (typeof k !== 'string' || k.trim() === '') continue;
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
      out[k] = CLAUDE_MODEL_ENV_KEYS.includes(k) ? normalizeClaudeModelReference(String(v)) : String(v);
    }
  }
  return Object.keys(out).length > 0 ? out : null;
}

/** Claude settings.json `permissions` block: allow/ask/deny string arrays. */
export function normalizeClaudePermissions(
  value: unknown,
): { allow: string[]; ask: string[]; deny: string[] } | null {
  const rec = asRecord(value);
  const allow = normalizeStringList(rec.allow);
  const ask = normalizeStringList(rec.ask);
  const deny = normalizeStringList(rec.deny);
  if (allow.length === 0 && ask.length === 0 && deny.length === 0) return null;
  return { allow, ask, deny };
}

// The `--permission-mode` / `permissions.defaultMode` choices the upstream
// `claude` CLI accepts. Re-verified against claude-cli 2.1.261, 2026-09-06:
// `claude --help` lists `acceptEdits, auto, bypassPermissions, manual,
// dontAsk, plan` — `manual` replaces the old `default` label there. `default`
// is kept because it still passes live (`claude --permission-mode default -p
// ...` exits 0 with a real answer, unlike a genuinely rejected value), so any
// already-stored `default` override keeps working; `manual` is the value the
// CLI now documents and should be offered going forward.
export const CLAUDE_PERMISSION_MODES = [
  'default',
  'manual',
  'acceptEdits',
  'plan',
  'auto',
  'dontAsk',
  'bypassPermissions',
] as const;

/**
 * Fleet default permission mode applied to every Claude host when the settings
 * doc does not pin one. `auto` = Claude Code auto-approves tool calls with its
 * background safety checks (the "auto mode" operators asked for). Operators can
 * still pin `default` (prompt every time) or any other value in the fleet
 * settings. Rendered as `permissions.defaultMode`, NOT a top-level key — Claude
 * Code only reads the nested form.
 */
export const DEFAULT_CLAUDE_PERMISSION_MODE = 'auto';

/** Claude settings.json `permissions.defaultMode`: controls auto-approve aggressiveness. */
export function normalizeClaudePermissionMode(value: unknown): string | null {
  const s = normalizeString(value);
  if (s === null) return null;
  return (CLAUDE_PERMISSION_MODES as readonly string[]).includes(s) ? s : null;
}

/**
 * Claude settings.json `statusLine` block.
 *
 * NOT a verbatim pass-through: claude-cli 2.1.263 declares
 *
 *   statusLine: c({ type: C("command"), command: s(), padding: w().optional(),
 *                   refreshInterval: w().min(1).optional().catch(void 0), ... })
 *              .optional().describe("Custom status line display configuration")
 *
 * so `type` must be the literal "command" and `command` a string. An object
 * failing that is dropped by the CLI — and because the fleet suppresses its own
 * `cxx claude-quota-statusline` default whenever any statusLine is present, a
 * malformed admin value used to take the host's Claude quota telemetry offline
 * with nothing reporting it. Rejecting here means the fleet default survives.
 *
 * The optional siblings the CLI accepts (`padding`, `refreshInterval`,
 * `hideVimModeIndicator`) are preserved when present rather than stripped.
 */
export function normalizeClaudeStatusLine(value: unknown): Record<string, unknown> | null {
  const rec = asRecord(value);
  if (Object.keys(rec).length === 0) return null;
  if (rec.type !== 'command') return null;
  if (typeof rec.command !== 'string' || rec.command.trim() === '') return null;
  // `padding` and `refreshInterval` are typed in the claude-cli 2.1.284 schema
  // (`padding: k().optional()` has no `.catch`), so a wrongly-typed value would
  // fail the whole statusLine and take the quota telemetry with it. Keep the
  // typed keys only when valid and drop everything else.
  const out: Record<string, unknown> = { type: 'command', command: rec.command };
  if (typeof rec.padding === 'number' && Number.isFinite(rec.padding)) out.padding = rec.padding;
  if (typeof rec.refreshInterval === 'number' && Number.isFinite(rec.refreshInterval) && rec.refreshInterval >= 1) {
    out.refreshInterval = rec.refreshInterval;
  }
  if (typeof rec.hideVimModeIndicator === 'boolean') out.hideVimModeIndicator = rec.hideVimModeIndicator;
  return out;
}

/** Claude settings.json `hooks` block (event -> matcher[]): passed through verbatim. */
export function normalizeClaudeHooks(value: unknown): Record<string, unknown> | null {
  const rec = asRecord(value);
  return Object.keys(rec).length > 0 ? rec : null;
}

/**
 * Settings-only hash used to detect "settings changed" vs "TOML body changed".
 * Sorted-key serialization keeps the hash stable across reorderings.
 */
export function settingsHash(value: unknown): string {
  const sorted = sortKeysDeep(value);
  return createHash('sha256').update(JSON.stringify(sorted)).digest('hex');
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value && typeof value === 'object') {
    const keys = Object.keys(value as Record<string, unknown>).sort();
    const out: Record<string, unknown> = {};
    for (const k of keys) out[k] = sortKeysDeep((value as Record<string, unknown>)[k]);
    return out;
  }
  return value;
}
