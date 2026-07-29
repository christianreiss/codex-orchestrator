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
 */

import { createHash } from 'node:crypto';

/** Fleet defaults for new Codex configs and OpenAI-compatible requests. */
export const DEFAULT_CODEX_MODEL = 'gpt-5.6-terra';
export const DEFAULT_CODEX_REASONING_EFFORT = 'medium';

export const FORCE_UPGRADE_MODEL = DEFAULT_CODEX_MODEL;
export const FORCE_UPGRADE_REASONING_EFFORT = 'high';

export const SUPPORTED_MODELS: readonly string[] = [
  'gpt-5.6-sol',
  'gpt-5.6-terra',
  'gpt-5.6-luna',
  'gpt-5.5',
  'gpt-5.4',
  'gpt-5.4-mini',
  'gpt-5.3-codex-spark',
];

export const LEGACY_MODEL_UPGRADES: Readonly<Record<string, string>> = {
  'gpt-5.3-codex': FORCE_UPGRADE_MODEL,
  'gpt-5.2': FORCE_UPGRADE_MODEL,
  'gpt-5.2-codex': FORCE_UPGRADE_MODEL,
  'gpt-5.1-codex-max': FORCE_UPGRADE_MODEL,
  'gpt-5.1-codex-mini': FORCE_UPGRADE_MODEL,
};

// Legacy stored-override ids mapped onto the canonical gate ids defined in
// api/src/services/claude-models.ts (CLAUDE_SUPPORTED_MODELS). Values MUST be
// valid gate models so the rendered per-host config and the inference gate
// agree — never downgrade to a gate-rejected id. This map is the stored-override
// input domain and is deliberately separate from the gate's request-side map.
export const CLAUDE_LEGACY_MODEL_UPGRADES: Readonly<Record<string, string>> = {
  'claude-3-opus-20240229': 'claude-opus-4-8',
  'claude-3-sonnet-20240229': 'claude-sonnet-5',
  'claude-3-haiku-20240307': 'claude-haiku-4-5-20251001',
  'claude-3-5-sonnet-20240620': 'claude-sonnet-5',
  'claude-3-5-sonnet-20241022': 'claude-sonnet-5',
  'claude-3-5-haiku-20241022': 'claude-haiku-4-5-20251001',
  'claude-sonnet-4-20250514': 'claude-sonnet-5',
  'claude-opus-4-20250514': 'claude-opus-4-8',
};

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
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
  'ultra',
];

export const MODEL_REASONING_EFFORTS: Readonly<Record<string, readonly string[]>> = {
  'gpt-5.6-sol': ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
  'gpt-5.6-terra': ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
  'gpt-5.6-luna': ['low', 'medium', 'high', 'xhigh', 'max'],
  'gpt-5.5': ['low', 'medium', 'high', 'xhigh'],
  'gpt-5.4': ['low', 'medium', 'high', 'xhigh'],
  'gpt-5.4-mini': ['low', 'medium', 'high', 'xhigh'],
  'gpt-5.3-codex-spark': ['low', 'medium', 'high', 'xhigh'],
};

/** Defaults reported by the current Codex CLI model catalog. */
export const CODEX_MODEL_DEFAULT_REASONING_EFFORTS: Readonly<Record<string, string>> = {
  'gpt-5.6-sol': 'low',
  'gpt-5.6-terra': 'medium',
  'gpt-5.6-luna': 'medium',
  'gpt-5.5': 'medium',
  'gpt-5.4': 'medium',
  'gpt-5.4-mini': 'medium',
  'gpt-5.3-codex-spark': 'high',
};

/** Claude Code effort levels that may be persisted in settings.json per model. */
export const CLAUDE_MODEL_REASONING_EFFORTS: Readonly<Record<string, readonly string[]>> = {
  'claude-fable-5': ['low', 'medium', 'high', 'xhigh'],
  'claude-opus-4-8': ['low', 'medium', 'high', 'xhigh'],
  'claude-sonnet-5': ['low', 'medium', 'high', 'xhigh'],
  'claude-opus-4-7': ['low', 'medium', 'high', 'xhigh'],
  'claude-sonnet-4-6': ['low', 'medium', 'high'],
  'claude-haiku-4-5-20251001': [],
};

/** Fleet defaults used when an operator selects a Claude model without an effort. */
export const CLAUDE_MODEL_DEFAULT_REASONING_EFFORTS: Readonly<Record<string, string | null>> = {
  'claude-fable-5': 'high',
  'claude-opus-4-8': 'high',
  'claude-sonnet-5': 'high',
  'claude-opus-4-7': 'xhigh',
  'claude-sonnet-4-6': 'high',
  'claude-haiku-4-5-20251001': null,
};

export const PERSONALITIES: readonly string[] = ['friendly', 'pragmatic', 'none'];

export const APPROVAL_POLICIES: readonly string[] = ['untrusted', 'on-request', 'on-failure', 'never'];

export const DROPPED_FEATURE_KEYS: readonly string[] = [
  'steer',
  'collaboration_modes',
  'elevated_windows_sandbox',
  'experimental_windows_sandbox',
  'enable_experimental_windows_sandbox',
  'remote_models',
  'request_permissions',
  'request_rule',
  'responses_websockets',
  'responses_websockets_v2',
  'search_tool',
  'sqlite',
  'use_linux_sandbox_bwrap',
  'web_search_cached',
  'web_search_request',
];

export interface NormalizedSettings {
  model: string | null;
  model_provider: string | null;
  local_provider: string | null;
  profile: string | null;
  personality: string;
  approval_policy: string | null;
  sandbox_mode: string | null;
  web_search: boolean | null;
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
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
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
  return legacyUpgrade(CLAUDE_LEGACY_MODEL_UPGRADES, s) ?? s;
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

export function normalizeApprovalPolicy(value: unknown): string | null {
  const s = normalizeString(value);
  if (s === null) return null;
  const lower = s.toLowerCase();
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

function normalizeWebSearch(value: unknown): boolean | null {
  if (value === null || value === undefined) return null;
  return normalizeBool(value);
}

function normalizeFeatures(value: unknown): Record<string, unknown> {
  const features = asRecord(value);
  const cleaned: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(features)) {
    if (DROPPED_FEATURE_KEYS.includes(key)) continue;
    if (key === 'web_search' || key === 'web_search_request' || key === 'web_search_cached') continue;
    cleaned[key] = typeof raw === 'boolean' ? raw : normalizeBool(raw, null);
  }
  return cleaned;
}

function normalizeProfiles(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return [];
  const out: Array<Record<string, unknown>> = [];
  for (const entry of value) {
    if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
      const profile = { ...(entry as Record<string, unknown>) };
      const rawModel = profile.model;
      const model = normalizeStoredModel(rawModel);
      const forceUpgraded = isLegacyModelUpgrade(rawModel);
      const reasoning = forceUpgraded && model !== null
        ? FORCE_UPGRADE_REASONING_EFFORT
        : normalizeReasoningEffortForModel(profile.model_reasoning_effort, model)
          ?? (profile.model !== undefined ? defaultCodexReasoningEffortForModel(model) : null);
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
  opts: { applyCodexDefaults?: boolean } = {},
): NormalizedSettings {
  const settings = asRecord(raw);
  const applyCodexDefaults = opts.applyCodexDefaults ?? true;
  const rawModel = settings.model ?? (applyCodexDefaults ? DEFAULT_CODEX_MODEL : undefined);
  const model = normalizeStoredModel(rawModel);
  const forceUpgraded = isLegacyModelUpgrade(rawModel);

  const personality = normalizePersonality(settings.personality) ?? 'friendly';
  const reasoning = forceUpgraded && model !== null
    ? FORCE_UPGRADE_REASONING_EFFORT
    : normalizeReasoningEffortForModel(
      settings.model_reasoning_effort,
      model,
    ) ?? (applyCodexDefaults
      ? defaultCodexReasoningEffortForModel(model) ?? DEFAULT_CODEX_REASONING_EFFORT
      : null);

  const security = asRecord(settings.security);
  const securityBypass = normalizeBool(security.dangerously_bypass_approvals_and_sandbox);

  const out: NormalizedSettings = {
    model,
    model_provider: normalizeString(settings.model_provider),
    local_provider: normalizeString(settings.local_provider),
    profile: normalizeString(settings.profile),
    personality,
    approval_policy: normalizeApprovalPolicy(settings.approval_policy),
    sandbox_mode: normalizeString(settings.sandbox_mode),
    web_search: normalizeWebSearch(settings.web_search),
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
    shell_environment_policy: asRecord(settings.shell_environment_policy),
    profiles: normalizeProfiles(settings.profiles),
    mcp_servers: normalizeMcpServers(settings.mcp_servers),
  };

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
  const advisorModel = normalizeClaudeAdvisorModel(settings.advisorModel);
  if (advisorModel) out.advisorModel = advisorModel;
  const effortLevel = normalizeClaudeEffortLevel(settings.effortLevel, model);
  if (effortLevel) out.effortLevel = effortLevel;

  return out;
}

/**
 * Allowed values for the Claude `advisorModel` settings.json key. These are
 * the short tier aliases Claude Code resolves itself to the current model
 * version (e.g. `opus` -> claude-opus-4-8); we deliberately store the alias,
 * not a pinned full id, so the experimental advisor tracks the latest model.
 */
export const ADVISOR_MODEL_ALIASES = ['opus', 'sonnet', 'haiku'] as const;

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
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') out[k] = String(v);
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

// The exact `--permission-mode` / `permissions.defaultMode` choices the upstream
// `claude` CLI accepts (verified against `claude --help`). Anything outside this
// set is rejected by Claude Code, so we drop it on normalize.
export const CLAUDE_PERMISSION_MODES = [
  'default',
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

/** Claude settings.json `statusLine` block: passed through verbatim. */
export function normalizeClaudeStatusLine(value: unknown): Record<string, unknown> | null {
  const rec = asRecord(value);
  return Object.keys(rec).length > 0 ? rec : null;
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
