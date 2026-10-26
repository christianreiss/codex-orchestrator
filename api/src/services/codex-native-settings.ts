/**
 * Codex 0.163.0 native configuration, audited 2026-10-16.
 * Schema: https://learn.chatgpt.com/docs/config-schema.json (redirect target of
 * https://developers.openai.com/codex/config-schema.json).
 * Original SHA-256: e9dd16b9d1710e57b020e42da4af6d6606e8f44cb028a2e94196dee3890d9170.
 * Feature retirement comes from `codex features list`, not the schema: upstream
 * deliberately retains removed keys in that schema for compatibility.
 */
import { Ajv } from 'ajv';
import schema from './codex-config-schema.json' with { type: 'json' };
import { ValidationError } from '../http/errors.js';
import { MODEL_REASONING_EFFORTS, CODEX_MODEL_DEFAULT_REASONING_EFFORTS } from './codex-model-capabilities.js';
import { upgradeCodexModelId } from './codex-model-upgrades.js';

export const CODEX_RETIRED_FEATURE_KEYS: readonly string[] = [
  "apply_patch_freeform",
  "apply_patch_preserve_line_endings",
  "apps_mcp_path_override",
  "code_mode_buffered_exec",
  "codex_git_commit",
  "collaboration_modes",
  "elevated_windows_sandbox",
  "enable_fanout",
  "experimental_windows_sandbox",
  "external_migration",
  "guardian_ext",
  "image_detail_original",
  "item_ids",
  "js_repl",
  "js_repl_tools_only",
  "local_thread_store_shared_compression",
  "multi_agent_mode",
  "personality",
  "plugin_hooks",
  "remote_compaction_v2",
  "remote_control",
  "remote_models",
  "request_rule",
  "resize_all_images",
  "responses_websockets",
  "responses_websockets_v2",
  "search_tool",
  "send_async_message",
  "shell_zsh_fork",
  "skill_env_var_dependency_prompt",
  "sqlite",
  "steer",
  "terminal_resize_reflow",
  "tool_search",
  "tool_search_always_defer_mcp_tools",
  "transcript_v2",
  "tui_app_server",
  "unavailable_dummy_tools",
  "undo",
  "unified_exec_zsh_fork",
  "use_legacy_landlock",
  "use_linux_sandbox_bwrap",
  "web_search_cached",
  "web_search_request",
  "workspace_owner_usage_nudge",
  "enable_experimental_windows_sandbox",
  "request_permissions",
  "voice_transcription",
  "web_search",
  "codex_hooks"
];

export type NativeSettings = Record<string, unknown>;
export type CodexApprovalPolicy = string | { granular: Record<string, boolean> };

const validate = new Ajv({ strict: false, allErrors: true, validateFormats: false }).compile(schema);
const retiredRootKeys = new Set([
  'personality', 'profile', 'profiles', 'model_max_output_tokens',
  'model_supports_reasoning_summaries', 'experimental_instructions_file',
]);
const unsafeKeys = new Set(['__proto__', 'prototype', 'constructor']);

export function nativeRecord(value: unknown): NativeSettings {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as NativeSettings : {};
}

function cloneJson(value: unknown, path: string): unknown {
  if (value === null) throw new ValidationError(`${path}: TOML has no null value; omit the key instead`, { param: path });
  if (typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map((entry, i) => cloneJson(entry, `${path}[${i}]`));
  if (value && typeof value === 'object') {
    const out: NativeSettings = {};
    for (const [key, entry] of Object.entries(value)) {
      if (unsafeKeys.has(key)) throw new ValidationError(`${path}.${key} is not a safe configuration key`, { param: path });
      out[key] = cloneJson(entry, `${path}.${key}`);
    }
    return out;
  }
  throw new ValidationError(`${path} must contain JSON values`, { param: path });
}

/** Authoring boundary: upstream schema constraints, no retired keys or coercion. */
export function normalizeCodexNativeSettings(value: unknown): NativeSettings | undefined {
  if (value === undefined || value === null) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ValidationError('native_settings must be an object', { param: 'native_settings' });
  }
  const out = cloneJson(value, 'native_settings') as NativeSettings;
  for (const key of ['requirements', 'allowed_approval_policies', 'allowed_sandbox_modes', 'allow_managed_hooks_only', 'managed_hooks', 'allow_remote_control']) {
    if (Object.hasOwn(out, key)) throw new ValidationError(`native_settings.${key} belongs to admin-enforced requirements.toml, not user config.toml; configure it through your native device or enterprise policy deployment`, { param: `native_settings.${key}` });
  }
  for (const key of Object.keys(out)) {
    if (retiredRootKeys.has(key)) throw new ValidationError(`native_settings.${key} is retired; use current native settings or profile sidecars`, { param: `native_settings.${key}` });
  }
  for (const key of ['model', 'model_reasoning_effort']) {
    if (Object.hasOwn(out, key)) throw new ValidationError(`native_settings.${key} is owned by the structured model controls; set ${key} outside native_settings`, { param: `native_settings.${key}` });
  }
  const features = nativeRecord(out.features);
  for (const key of Object.keys(features)) {
    if (CODEX_RETIRED_FEATURE_KEYS.includes(key)) throw new ValidationError(`native_settings.features.${key} is removed or deprecated`, { param: `native_settings.features.${key}` });
  }
  if (Object.hasOwn(nativeRecord(features.guardianv2), 'thread_context')) {
    throw new ValidationError('native_settings.features.guardianv2.thread_context is removed', { param: 'native_settings.features.guardianv2.thread_context' });
  }
  // Model ids live in several native scopes, including profile sidecars. Migrate
  // known deprecated choices only; provider-specific and future ids pass through.
  const agents = nativeRecord(out.agents);
  const rawSubagentModel = agents.default_subagent_model;
  for (const [record, keys] of [
    [out, ['review_model', 'experimental_realtime_ws_model']],
    [nativeRecord(out.agents), ['default_subagent_model']],
    [nativeRecord(out.memories), ['extract_model', 'consolidation_model']],
  ] as const) {
    for (const key of keys) if (typeof record[key] === 'string') record[key] = upgradeCodexModelId(record[key]);
  }
  if (typeof rawSubagentModel === 'string' && agents.default_subagent_model !== rawSubagentModel) {
    const model = String(agents.default_subagent_model);
    const rawEffort = agents.default_subagent_reasoning_effort;
    const effort = typeof rawEffort === 'string' ? rawEffort.trim().toLowerCase() : '';
    agents.default_subagent_reasoning_effort = MODEL_REASONING_EFFORTS[model]?.includes(effort)
      ? effort : CODEX_MODEL_DEFAULT_REASONING_EFFORTS[model];
  }
  validateCodexConfigDocument(out);
  return out;
}

/** Validate the final render-equivalent object after explicit fleet overrides. */
export function validateCodexConfigDocument(out: NativeSettings, opts: { partialFeatures?: boolean; path?: string } = {}): void {
  const path = opts.path ?? 'native_settings';
  const budget = nativeRecord(nativeRecord(out.features).rollout_budget);
  if (!opts.partialFeatures && budget.enabled === true) {
    for (const key of ['limit_tokens', 'reminder_at_remaining_tokens']) {
      if (!Object.hasOwn(budget, key)) throw new ValidationError(`${path}.features.rollout_budget.${key} is required when enabled`, { param: `${path}.features.rollout_budget.${key}` });
    }
  }
  if (!validate(out)) {
    const error = validate.errors?.[0];
    const location = error?.instancePath.replaceAll('/', '.') ?? '';
    const property = error?.keyword === 'additionalProperties' ? `.${String(error.params.additionalProperty)}` : '';
    // Only describe paths/rules, never echo settings (which may hold credentials).
    throw new ValidationError(`${path}${location}${property}: ${error?.message ?? 'invalid Codex configuration'}`, { param: `${path}${location}${property}` });
  }
}

/** Known structured feature nulls withdraw an override; validate their keys too.
 * Nested nulls remain invalid because TOML cannot represent them.
 */
export function validateCodexFeatureDocument(features: NativeSettings, path: string, partialFeatures = false): void {
  const checked = Object.fromEntries(Object.entries(features).map(([key, value]) => [key, value === null ? false : value]));
  validateCodexConfigDocument({ features: cloneJson(checked, `${path}.features`) }, { path, partialFeatures });
}

/** Deep merge with explicit values winning. No array concatenation or mutation. */
export function mergeNativeSettings(base: NativeSettings, overlay: NativeSettings): NativeSettings {
  const out = { ...base };
  for (const [key, value] of Object.entries(overlay)) {
    if (unsafeKeys.has(key) || value === null || value === undefined) continue;
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      out[key] = mergeNativeSettings(nativeRecord(out[key]), value as NativeSettings);
    } else {
      out[key] = value;
    }
  }
  return out;
}

/** Compose MCP only while rendering; never persist native entries as structured copies. */
export function codexMcpServers(settings: NativeSettings): Array<Record<string, unknown>> {
  const nativeMcp = nativeRecord(nativeRecord(settings.native_settings).mcp_servers);
  const servers = new Map(Object.entries(nativeMcp).map(([name, entry]) => [name, { ...nativeRecord(entry), name }]));
  if (Array.isArray(settings.mcp_servers)) {
    for (const server of settings.mcp_servers) {
      const record = nativeRecord(server);
      if (typeof record.name === 'string') servers.set(record.name, { ...mergeNativeSettings(servers.get(record.name) ?? {}, record), name: record.name });
    }
  }
  return [...servers.values()];
}
