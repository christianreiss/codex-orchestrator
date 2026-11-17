import { z } from 'zod';
import { ValidationError } from '../http/errors.js';
import { renderGrokNativeToml } from './grok-native-settings.js';

// Audited against MoonshotAI/kimi-code tag @moonshot-ai/kimi-code@2.6.2
// (6a8493df3e1d796a63f7c7ca0de76c1e690cd943), configSection contributions.
// Fixed schema keys are strict; record names and header/env keys remain literal.
// Keep the original JSON after validation: parsing must never inject defaults or
// silently strip an authored setting. Native files/auth/registry state are separate.
const str = z.string();
const bool = z.boolean();
const strings = z.array(str);
const stringMap = z.record(str);
type TomlValue = string | number | boolean | TomlValue[] | { [key: string]: TomlValue };
const tomlValue: z.ZodType<TomlValue> = z.lazy(() => z.union([
  str, bool, z.number().finite().refine(value => Number.isSafeInteger(value) || !Number.isInteger(value) || /e/i.test(String(value)), 'Integer cannot be represented losslessly in native TOML'),
  z.array(tomlValue), z.record(tomlValue),
]));
const int = (minimum = 0) => z.number().int().safe().min(minimum);
const object = <T extends z.ZodRawShape>(fields: T) => z.object(fields).strict();
const oauth = object({ storage: z.enum(['file', 'keyring']), key: str.min(1), oauth_host: str.min(1).optional() });
const provider = object({
  model_source: z.enum(['static', 'discover', 'oauth-catalog']).optional(),
  base_url: str.optional(), search_url: str.optional(), feedback_url: str.optional(),
  custom_headers: stringMap.optional(), default_model: str.optional(), type: str.optional(),
  api_key: str.optional(), api_key_env: str.optional(), oauth: oauth.optional(),
  env: stringMap.optional(), source: z.record(tomlValue).optional(),
});
const tuning = {
  max_context_size: int(1).optional(), max_input_size: int(1).optional(), max_output_size: int(1).optional(),
  capabilities: strings.optional(), display_name: str.optional(), reasoning_key: str.optional(),
  adaptive_thinking: bool.optional(), support_efforts: strings.optional(), default_effort: str.optional(), off_effort: str.optional(),
};
const model = object({
  ...tuning, provider_id: str.optional(), provider: str.optional(), model: str.optional(),
  base_url: str.optional(), api_key: str.optional(), oauth: oauth.optional(),
  protocol: z.enum(['anthropic', 'openai', 'openai_responses', 'google-genai']).optional(),
  name: str.optional(), aliases: strings.optional(), beta_api: bool.optional(),
  overrides: object(tuning).optional(),
  upgrade: object({ model: str.min(1), migration_markdown: str, retirement_at: str.optional() }).optional(),
});
const task = object({
  keep_alive_on_exit: bool.optional(), bash_auto_background_on_timeout: bool.optional(),
  bash_task_timeout_s: int().optional(), kill_grace_period_ms: int().optional(),
  print_wait_ceiling_s: int(1).optional(), print_max_turns: int(1).optional(),
  print_background_mode: z.enum(['exit', 'drain', 'steer']).optional(),
});
const service = object({ base_url: str.optional(), api_key: str.optional(), oauth: oauth.optional(), custom_headers: stringMap.optional() });
const hookEvents = ['PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PermissionRequest', 'PermissionResult',
  'UserPromptSubmit', 'UserPromptQueued', 'TurnStarted', 'Stop', 'StopFailure', 'Interrupt', 'SessionStart',
  'SessionEnd', 'SessionHeartbeat', 'SubagentStart', 'SubagentStop', 'TaskStarted', 'PreCompact', 'PostCompact', 'Notification'] as const;
const permissionPattern = str.min(1).refine(value => {
  const trimmed = value.trim();
  const open = trimmed.indexOf('(');
  return trimmed.length > 0 && (open < 0 || (open > 0 && trimmed.endsWith(')')));
}, 'Invalid permission rule pattern');
// Native remote declarations deliberately retain their camelCase field names.
const remotePaths = { remoteBin: str.min(1).optional(), defaultCwd: str.min(1).optional() };
const remote = z.union([
  object({ type: z.literal('ssh'), host: str.min(1), ...remotePaths }),
  object({ type: z.literal('docker'), container: str.min(1), context: str.min(1).optional(), ...remotePaths }),
  object({ command: str.min(1), args: strings.optional(), env: stringMap.optional(), ...remotePaths }),
]);
const environments = z.record(z.union([str, remote])).superRefine((entries, ctx) => {
  for (const [name, entry] of Object.entries(entries)) {
    if (name === 'default') {
      if (typeof entry !== 'string') ctx.addIssue({ code: 'custom', path: [name], message: 'Expected a configured environment id' });
    } else if (typeof entry === 'string' || !name || name !== name.trim() || name.length > 64 || name === 'local') {
      ctx.addIssue({ code: 'custom', path: [name], message: 'Invalid remote environment entry or id' });
    }
  }
  if (typeof entries.default === 'string') {
    const target = entries[entries.default];
    if (!target || typeof target === 'string' || !target.defaultCwd)
      ctx.addIssue({ code: 'custom', path: ['default'], message: 'Default environment must reference an entry with defaultCwd' });
  }
});
const schema = object({
  default_model: str.optional(), default_provider: str.optional(),
  default_permission_mode: z.enum(['manual', 'yolo', 'auto']).optional(), default_plan_mode: bool.optional(),
  merge_all_available_skills: bool.optional(), extra_skill_dirs: strings.optional(), extra_agent_dirs: strings.optional(),
  builtin_product_skills: bool.optional(), telemetry: bool.optional(), auto_session_title: bool.optional(), disable_feedback_survey: bool.optional(),
  providers: z.record(provider).optional(), models: z.record(model).optional(),
  model_catalog: object({ refresh_interval_ms: int().optional(), refresh_on_start: bool.optional() }).optional(),
  secondary_model: object({ default_model: str.min(1).optional(), models: stringMap.optional(), model: str.min(1).optional(), default_effort: str.optional() }).superRefine((pool, ctx) => {
    if (pool.models !== undefined && (!pool.default_model || !Object.hasOwn(pool.models, pool.default_model)))
      ctx.addIssue({ code: 'custom', path: ['default_model'], message: 'Required and must name a secondary_model.models entry when a pool is configured' });
  }).optional(),
  thinking: object({ enabled: bool.optional(), effort: str.optional(), keep: str.optional() }).optional(),
  loop_control: object({
    max_steps_per_turn: int().optional(), max_attempts_per_step: int().optional(), max_ralph_iterations: int(-1).optional(),
    reserved_context_size: int().optional(), compaction_trigger_ratio: z.number().min(0.5).max(0.99).optional(), compaction_max_attempts: int(1).optional(),
  }).optional(),
  token_counting: object({ strategy: z.enum(['measured+estimated', 'measured', 'estimated']) }).optional(),
  task: task.optional(), background: task.optional(),
  subagent: object({ timeout_ms: int().optional() }).optional(), swarm: object({ timeout_ms: int().optional() }).optional(),
  mcp: object({
    startup_timeout_ms: int(1).max(2147483647).optional(), tool_timeout_ms: int(1).max(2147483647).optional(), default_deferred: bool.optional(),
    reconnect_initial_delay_ms: int(1).max(2147483647).optional(), reconnect_max_delay_ms: int(1).max(2147483647).optional(),
  }).optional(),
  identity: object({ name: str.optional(), slug: str.optional() }).optional(),
  tools: object({ enabled: strings.optional(), disabled: strings.optional() }).optional(),
  read: object({ default_max_chars: int(1).optional(), max_chars: int(1).optional() }).optional(),
  image: object({ max_edge_px: int(1).optional(), read_byte_budget: int(1).optional() }).optional(),
  database: object({ base: bool.optional(), global_search: bool.optional(), search: bool.optional(), search_sync_session_cap: int(1).optional(), search_sync_debounce_ms: int().optional() }).optional(),
  watch: object({ enabled: bool.optional() }).optional(), workspace: object({ require_trust: bool.optional() }).optional(),
  experimental: z.record(bool).optional(),
  services: object({ moonshot_search: service.optional(), moonshot_fetch: service.optional() }).optional(),
  permission: object({
    dangerous_command_guard: bool.optional(),
    rules: z.array(object({ decision: z.enum(['allow', 'deny', 'ask']), scope: z.enum(['project', 'user']).optional(), pattern: permissionPattern, reason: str.optional() })).optional(),
  }).optional(),
  environments: environments.optional(),
  hooks: z.array(object({ event: z.enum(hookEvents), matcher: str.optional(), command: str.min(1), timeout: int(1).max(600).optional() })).optional(),
});

const removedSecondary = ['force', 'max_context_size', 'max_input_size', 'max_output_size', 'capabilities',
  'display_name', 'reasoning_key', 'adaptive_thinking', 'support_efforts', 'off_effort'] as const;
const renames = { max_retries_per_step: 'max_attempts_per_step', max_steps_per_run: 'max_steps_per_turn' } as const;
function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
function reject(path: string, message: string): never {
  throw new ValidationError(`Kimi native_settings.${path}: ${message}`, { param: `settings.native_settings.${path}` });
}
export function normalizeKimiNativeSettings(value: unknown): Record<string, unknown> | undefined {
  if (value === undefined || value === null) return undefined;
  const input = record(value);
  if (!input) throw new ValidationError('Kimi native_settings must be an object', { param: 'settings.native_settings' });
  for (const [oldKey, next] of Object.entries(renames)) {
    if (Object.hasOwn(record(input.loop_control) ?? {}, oldKey)) reject(`loop_control.${oldKey}`, `retired; use loop_control.${next}`);
  }
  for (const key of removedSecondary) if (Object.hasOwn(record(input.secondary_model) ?? {}, key))
    reject(`secondary_model.${key}`, key === 'force' ? 'removed; default_model already pins a single-model pool' : 'removed; configure tuning on the referenced models entry');
  for (const section of ['task', 'background']) if (Object.hasOwn(record(input[section]) ?? {}, 'max_running_tasks'))
    reject(`${section}.max_running_tasks`, 'removed in Kimi 2.6; no current replacement');
  if (Object.hasOwn(input, 'cron')) reject('cron', 'internal environment-bound controls are not persistent user settings');
  if (Object.hasOwn(record(input.thinking) ?? {}, 'forced_effort')) reject('thinking.forced_effort', 'owned by KIMI_MODEL_THINKING_EFFORT; use thinking.effort for user defaults');
  const result = schema.safeParse(input);
  if (!result.success) {
    const issue = result.error.issues[0]!;
    const path = [...issue.path, ...(issue.code === 'unrecognized_keys' ? [issue.keys[0]!] : [])].join('.');
    reject(path, issue.code === 'unrecognized_keys' ? 'unsupported user setting' : issue.message);
  }
  return structuredClone(input);
}

/** Only verified obsolete paths are healed on stored reads, never on new writes. */
export function migrateStoredKimiNativeSettings(value: unknown): unknown {
  const out = structuredClone(value);
  const root = record(out);
  if (!root) return out;
  const loop = record(root.loop_control);
  if (loop) for (const [oldKey, next] of Object.entries(renames)) {
    if (!Object.hasOwn(loop, oldKey)) continue;
    // Invalid historical values remain visible for correction. Explicit successors win.
    const parsed = int().safeParse(loop[oldKey]);
    if (Object.hasOwn(loop, next) || parsed.success) {
      if (!Object.hasOwn(loop, next)) loop[next] = loop[oldKey];
      delete loop[oldKey];
    }
  }
  const secondary = record(root.secondary_model);
  if (secondary) for (const key of removedSecondary) delete secondary[key];
  for (const section of ['task', 'background']) {
    const tasks = record(root[section]);
    if (tasks) delete tasks.max_running_tasks;
  }
  return out;
}

/** Additions relative to the source-audited 2.5.3 floor; map names are opaque. */
export function kimiNativeMinimum(value: unknown): '2.5.3' | '2.6.2' {
  const root = record(value) ?? {};
  const providers = record(root.providers) ?? {};
  const pool = record(record(root.secondary_model)?.models) ?? {};
  return Object.values(providers).some(value => {
    const provider = record(value) ?? {};
    return Object.hasOwn(provider, 'search_url') || Object.hasOwn(provider, 'feedback_url');
  }) || Object.hasOwn(pool, 'primary') ? '2.6.2' : '2.5.3';
}
/** Same TOML encoding primitives; Kimi's schema and ownership are independent. */
export const renderKimiNativeToml = renderGrokNativeToml;
export function kimiNativeOwnedPaths(value: Record<string, unknown>): string[] {
  const paths: string[] = [];
  function walk(value: unknown, path: string[]) {
    if (path[0] === 'mcp_servers' && path.length === 2) paths.push(`mcp_servers.${path[1]}`);
    else if (value && typeof value === 'object' && !Array.isArray(value))
      for (const [key, item] of Object.entries(value)) walk(item, [...path, key]);
    else if (path.length)
      paths.push(path.some((p) => p.includes('.')) ? `json:${JSON.stringify(path)}` : path.join('.'));
  }
  walk(value, []);
  return paths;
}
