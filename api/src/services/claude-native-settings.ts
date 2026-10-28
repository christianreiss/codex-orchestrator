import { z } from 'zod';
import { CLAUDE_MODEL_REASONING_EFFORTS, CLAUDE_MODEL_ENV_KEYS, normalizeClaudeModelReference } from './claude-models.js';
import { claudeSessionEfforts } from './claude-effort.js';
import { ValidationError } from '../http/errors.js';
import {
  CLAUDE_GLOBAL_ONLY_SETTINGS,
  CLAUDE_MANAGED_ONLY_SETTINGS,
  CLAUDE_MANAGED_ONLY_NESTED_SETTINGS,
  CLAUDE_NATIVE_NESTED_SETTING_RULES,
  CLAUDE_NATIVE_SETTING_RULES,
} from './claude-native-settings-catalog.js';

const deprecated: Readonly<Record<string, string>> = {
  includeCoAuthoredBy: 'Use attribution.commit and attribution.pr instead.',
  disableArtifact: 'Use enableArtifact instead.',
  voiceEnabled: 'Use voice.enabled instead.',
  keybindingFlavor: 'Removed: word editing always follows readline conventions.',
  taskOutputMaxChars: 'Removed with TaskOutput in Claude Code 2.1.277.',
  ignorePatterns: 'Use permissions.deny instead.',
  permissionExplainerEnabled: 'Removed with Ctrl+E permission explanations in Claude Code 2.1.257.',
  teammateDefaultModel: 'Removed in Claude Code 2.1.234; configure the agent model instead.',
};
const reserved: Readonly<Record<string, string>> = {
  model: 'Use the model control.',
  effortLevel: 'Use the reasoning effort control, or modelSettings for per-model defaults.',
  apiKeyHelper: 'Authentication is owned by the managed launch and overrides apiKeyHelper.',
  autoUpdatesChannel: 'Native updates are disabled; use the fleet Claude version control.',
  // Only constrains native auto-updates and `claude update`, both off under managed launches.
  minimumVersion: 'Native updates are disabled; use the fleet Claude version control.',
  sshHostCommands: 'Only Claude Desktop 3.6556.0 or newer reads this setting; configure it through Desktop user or managed settings, not fleet CLI defaults.',
};
const forbiddenKeys = new Set(['__proto__', 'prototype', 'constructor']);
const efforts = ['low', 'medium', 'high', 'xhigh'];

function fail(path: string, message: string): never {
  throw new ValidationError(`native_settings.${path}: ${message}`, { param: `native_settings.${path}` });
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function assertType(value: unknown, types: string | readonly string[], path: string): void {
  const actual = Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value;
  if (!(typeof types === 'string' ? [types] : types).includes(actual)) fail(path, `expected ${typeof types === 'string' ? types : types.join(' or ')}`);
  if (actual === 'number' && !Number.isFinite(value)) fail(path, 'expected a finite number');
}
function strings(value: unknown, path: string): void {
  assertType(value, 'array', path);
  for (const [i, item] of (value as unknown[]).entries()) assertType(item, 'string', `${path}.${i}`);
}
function choice(value: unknown, values: readonly string[], path: string): void {
  if (typeof value !== 'string' || !values.includes(value)) fail(path, `expected ${values.join(', ')}`);
}
function range(value: unknown, min: number, max: number, path: string, integer = true): void {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) {
    fail(path, `expected ${integer ? 'an integer' : 'a number'} from ${min} to ${max}`);
  }
}

/** Validate JSON before merging it or constructing the wrapper's dotted paths. */
function jsonCopy(value: unknown, path: string, depth = 0): unknown {
  if (depth > 32) fail(path, 'settings are nested too deeply');
  if (Array.isArray(value)) return value.map((v, i) => jsonCopy(v, `${path}.${i}`, depth + 1));
  if (record(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      if (forbiddenKeys.has(key)) fail(path, `unsafe key ${key}`);
      out[key] = jsonCopy(item, path ? `${path}.${key}` : key, depth + 1);
    }
    return out;
  }
  if (value === null || ['string', 'boolean'].includes(typeof value)) return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  return fail(path, 'expected a JSON value');
}

// Public fixed-object grammar, verified against the 2.1.310 native schema and
// https://code.claude.com/docs/en/{settings-reference,hooks,plugins/marketplace-reference}.
// Maps deliberately validate their values without interpreting names as paths.
const text = z.string();
const flag = z.boolean();
const textList = z.array(text);
const textMap = z.record(text);
const commandLine = z.object({ type: z.literal('command'), command: text }).strict();
const modelEntry = z.object({
  effortLevel: z.enum(['low', 'medium', 'high', 'xhigh']).optional(),
  maxEffortLevel: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).optional(),
  autoCompactWindow: z.union([z.number().int().min(100_000).max(1_000_000), z.literal('auto')]).optional(),
}).strict();
const pluginOption = z.union([text, z.number(), flag, textList]);
const commonHook = {
  if: text.optional(), timeout: z.number().positive().optional(),
  statusMessage: text.optional(), once: flag.optional(),
};
const onFailure = z.enum(['continue', 'block']).optional();
const hook = z.discriminatedUnion('type', [
  z.object({ type: z.literal('command'), ...commonHook, command: text, args: textList.optional(),
    async: flag.optional(), asyncRewake: flag.optional(), shell: z.enum(['bash', 'powershell']).optional(), onFailure }).strict(),
  z.object({ type: z.literal('http'), ...commonHook, url: text, headers: textMap.optional(), allowedEnvVars: textList.optional(), onFailure }).strict(),
  z.object({ type: z.literal('mcp_tool'), ...commonHook, server: text, tool: text, input: z.record(z.unknown()).optional() }).strict(),
  z.object({ type: z.literal('prompt'), ...commonHook, prompt: text, model: text.optional(), continueOnBlock: flag.optional() }).strict(),
  z.object({ type: z.literal('agent'), ...commonHook, prompt: text, model: text.optional() }).strict(),
]);
const hookGroup = z.object({ matcher: text.optional(), hooks: z.array(hook) }).strict();
const hookEvents = [
  'SessionStart', 'Setup', 'UserPromptSubmit', 'UserPromptExpansion', 'PreToolUse',
  'PermissionRequest', 'PermissionDenied', 'PostToolUse', 'PostToolUseFailure', 'PostToolBatch',
  'Notification', 'MessageDisplay', 'SubagentStart', 'SubagentStop', 'TaskCreated', 'TaskCompleted',
  'Stop', 'StopFailure', 'TeammateIdle', 'InstructionsLoaded', 'ConfigChange', 'CwdChanged',
  'DirectoryAdded', 'FileChanged', 'WorktreeCreate', 'WorktreeRemove', 'PreCompact', 'PostCompact',
  'PreModelSwitch', 'PostModelSwitch', 'Elicitation', 'ElicitationResult', 'SessionEnd',
];
const pluginSource = z.discriminatedUnion('source', [
  z.object({ source: z.literal('github'), repo: text, ref: text.optional(), sha: text.optional() }).strict(),
  z.object({ source: z.literal('url'), url: text, ref: text.optional(), sha: text.optional() }).strict(),
  z.object({ source: z.literal('git-subdir'), url: text, path: text, ref: text.optional(), sha: text.optional() }).strict(),
  z.object({ source: z.literal('npm'), package: text, version: text.optional(), registry: text.optional() }).strict(),
  z.object({ source: z.literal('archive'), url: text, sha256: text.optional() }).strict(),
  z.object({ source: z.literal('command'), command: text, timeout: z.number().optional(), mode: z.enum(['copy', 'link']).optional() }).strict(),
]);
const inlinePlugin = z.object({
  name: text, source: pluginSource, description: text.optional(), version: text.optional(),
  strict: flag.optional(), headers: textMap.optional(), headersHelper: text.optional(),
}).strict();
const removedSkipLfs = z.never({ invalid_type_error: 'Removed: marketplace downloads always skip Git LFS; skipLfs has no effect.' }).optional();
const marketplaceSource = z.discriminatedUnion('source', [
  z.object({ source: z.literal('github'), repo: text, ref: text.optional(), path: text.optional(), sparsePaths: textList.optional(), skipLfs: removedSkipLfs }).strict(),
  z.object({ source: z.literal('git'), url: text, ref: text.optional(), path: text.optional(), sparsePaths: textList.optional(), skipLfs: removedSkipLfs }).strict(),
  z.object({ source: z.literal('url'), url: text, headers: textMap.optional(), headersHelper: text.optional() }).strict(),
  z.object({ source: z.literal('file'), path: text }).strict(),
  z.object({ source: z.literal('directory'), path: text }).strict(),
  z.object({ source: z.literal('settings'), name: text, plugins: z.array(inlinePlugin),
    owner: z.object({ name: text, email: text.optional(), url: text.optional() }).strict().optional() }).strict(),
]);
const maskFields = {
  mode: z.enum(['deny', 'mask']), extract: text.optional(), decode: z.literal('jwt').optional(),
  onExtractNoMatch: z.enum(['warn', 'deny', 'error']).optional(),
  maskClaims: textList.min(1).optional(), injectHosts: textList.optional(),
};
const credentialFile = z.object({ path: text, ...maskFields, maskDuplicates: flag.optional() }).strict();
const credentialEnv = z.object({ name: text.regex(/^[A-Za-z_][A-Za-z0-9_]*$/), ...maskFields }).strict();
const mcpMatcher = z.object({ serverName: text.optional(), serverCommand: textList.optional(), serverUrl: text.optional() })
  .strict().refine(value => Object.keys(value).length === 1, 'expected exactly one MCP matcher field');
const nestedSchemas: Record<string, z.ZodTypeAny> = {
  env: textMap,
  modelOverrides: textMap,
  vimInsertModeRemaps: z.record(z.literal('<Esc>')).superRefine((value, ctx) => {
    for (const name of Object.keys(value)) if (name.length !== 2 || name.split('').some(character => character.charCodeAt(0) < 0x20 || character.charCodeAt(0) === 0x7f))
      ctx.addIssue({ code: 'custom', path: [name], message: 'expected a two-character printable key mapped to <Esc>' });
  }),
  enabledPlugins: z.record(flag),
  skillOverrides: z.record(z.enum(['on', 'name-only', 'user-invocable-only', 'off'])),
  modelSettings: z.record(modelEntry),
  modelPicker: z.object({ options: z.array(z.object({ model: text, label: text.optional(), description: text.optional(), behavesAs: text.optional() }).strict()), replaceBuiltInOptions: flag.optional() }).strict(),
  pluginConfigs: z.record(z.object({ options: z.record(pluginOption).optional(), mcpServers: z.record(z.record(pluginOption)).optional() }).strict()),
  extraKnownMarketplaces: z.record(z.object({ source: marketplaceSource, autoUpdate: flag.optional() }).strict()).superRefine((value, ctx) => {
    for (const [name, entry] of Object.entries(value)) if (entry.source.source === 'settings' && entry.source.name !== name)
      ctx.addIssue({ code: 'custom', path: [name, 'source', 'name'], message: 'must match the marketplace map key' });
  }),
  hooks: z.object(Object.fromEntries(hookEvents.map(event => [event, z.array(hookGroup).optional()]))).strict(),
  fileSuggestion: commandLine,
  subagentStatusLine: commandLine,
  statusLine: commandLine.extend({ padding: z.number().optional(), refreshInterval: z.number().min(1).optional(), hideVimModeIndicator: flag.optional() }),
  voice: z.object({ enabled: flag.optional(), mode: z.enum(['hold', 'tap']).optional(), autoSubmit: flag.optional() }).strict(),
  spellcheck: z.object({ enabled: flag.optional(), checker: z.enum(['aspell', 'hunspell', 'ispell', 'auto']).optional(), language: text.optional(), color: text.optional() }).strict(),
  spinnerVerbs: z.object({ mode: z.enum(['append', 'replace']), verbs: textList }).strict(),
  spinnerTipsOverride: z.object({
    excludeDefault: flag.optional(), tipsFile: text.optional(), label: text.max(40).optional(),
    tips: z.array(z.union([text, z.object({ id: text.regex(/^[A-Za-z0-9._-]{1,64}$/), text: text.max(500), cooldownSessions: z.number().int().min(0).max(1000).optional(), priority: z.number().int().min(-10).max(10).optional() }).strict()])).max(200).optional(),
  }).strict(),
  footerLinksRegexes: z.array(z.object({ type: z.literal('regex'), pattern: text, url: text, label: text.optional() }).strict()),
  allowedMcpServers: z.array(mcpMatcher), deniedMcpServers: z.array(mcpMatcher),
  sshConfigs: z.array(z.object({ id: text, name: text, sshHost: text, sshPort: z.number().int().optional(), sshIdentityFile: text.optional(), startDirectory: text.optional() }).strict()),
  'sandbox.ignoreViolations': z.record(textList),
  'sandbox.ripgrep': z.object({ command: text, args: textList.optional() }).strict(),
  'sandbox.credentials.files': z.array(credentialFile),
  'sandbox.credentials.envVars': z.array(credentialEnv),
  'sandbox.credentials.awsPairs': z.array(z.object({ accessKeyIdVar: text, secretAccessKeyVar: text, sessionTokenVar: text.optional() }).strict()),
  'sandbox.credentials.sigv4': z.object({ streaming: z.enum(['deny', 'passthrough']).optional(), presigned: z.enum(['deny', 'passthrough']).optional(), sigv4a: z.enum(['deny', 'passthrough']).optional() }).strict(),
};

/** Build closed fixed objects from the shared field catalog; special maps/arrays above take precedence. */
function nestedSchema(path: string): z.ZodTypeAny {
  if (Object.hasOwn(nestedSchemas, path)) return nestedSchemas[path]!;
  const rule = CLAUDE_NATIVE_NESTED_SETTING_RULES[path];
  if (rule && rule.type !== 'object') {
    if (rule.values) return z.string().refine(value => rule.values!.includes(value), `expected ${rule.values.join(', ')}`);
    if (rule.type === 'array') return z.array(text);
    if (rule.type === 'boolean') return flag;
    if (rule.type === 'number') return z.number();
    return text;
  }
  const fields: Record<string, z.ZodTypeAny> = {};
  for (const child of Object.keys(CLAUDE_NATIVE_NESTED_SETTING_RULES)) {
    if (child.startsWith(`${path}.`) && !child.slice(path.length + 1).includes('.'))
      fields[child.slice(path.length + 1)] = nestedSchema(child).optional();
  }
  return z.object(fields).strict();
}

function validateNested(key: string, value: unknown): void {
  // Root primitive/array types are checked by the catalog; only complex arrays
  // and records need this second pass. No root object is allowed to fail open.
  if (!record(value) && !Object.hasOwn(nestedSchemas, key)) return;
  const result = nestedSchema(key).safeParse(value);
  if (!result.success) {
    // Union branches can otherwise hide the actual bad field at their parent.
    const expand = (issue: z.ZodIssue): z.ZodIssue[] => issue.code === 'invalid_union'
      ? issue.unionErrors.flatMap(error => error.issues.flatMap(expand)) : [issue];
    const issue = result.error.issues.flatMap(expand).sort((a, b) =>
      b.path.length - a.path.length || Number(b.code === 'unrecognized_keys') - Number(a.code === 'unrecognized_keys'))[0]!;
    const parts = [key, ...issue.path, ...(issue.code === 'unrecognized_keys' ? [issue.keys[0]!] : [])];
    const path = parts.map((part, index) => typeof part === 'string' && part.includes('.') ? `[${JSON.stringify(part)}]` : `${index ? '.' : ''}${part}`).join('');
    fail(path, issue.code === 'unrecognized_keys' ? 'unknown Claude Code setting' : issue.message);
  }
  if (key === 'hooks' && record(value)) {
    const llmEvents = new Set(['PermissionDenied', 'PostToolBatch', 'PostToolUse', 'PostToolUseFailure', 'PreToolUse', 'Stop', 'SubagentStop', 'TaskCompleted', 'TaskCreated', 'TeammateIdle', 'UserPromptExpansion', 'UserPromptSubmit']);
    const toolEvents = new Set(['PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PermissionRequest', 'PermissionDenied']);
    for (const [event, groups] of Object.entries(value)) {
      for (const [groupIndex, group] of (groups as { hooks: Record<string, unknown>[] }[]).entries()) {
        for (const [hookIndex, entry] of group.hooks.entries()) {
          const path = `hooks.${event}.${groupIndex}.hooks.${hookIndex}`;
          if ((entry.type === 'prompt' && !llmEvents.has(event) && event !== 'PermissionRequest') ||
              (entry.type === 'agent' && !llmEvents.has(event)) ||
              (entry.type === 'http' && ['SessionStart', 'Setup'].includes(event)))
            fail(`${path}.type`, `hook type ${entry.type} is not supported on ${event}`);
          if ('if' in entry && !toolEvents.has(event)) fail(`${path}.if`, 'if is only evaluated on tool events; this handler would never run');
        }
      }
    }
  }
}

function validateModelSettings(key: string, value: Record<string, unknown>): void {
  if (key === 'modelSettings') {
    for (const [model, settings] of Object.entries(value)) {
      assertType(settings, 'object', `${key}.${model}`);
      const entry = settings as Record<string, unknown>;
      const canonical = normalizeClaudeModelReference(model).replace(/\[1m\]$/i, '');
      const supported = Object.hasOwn(CLAUDE_MODEL_REASONING_EFFORTS, canonical) ? CLAUDE_MODEL_REASONING_EFFORTS[canonical]! : efforts;
      if ('effortLevel' in entry) {
        if (supported.length === 0) fail(`${key}.${model}.effortLevel`, 'this model does not support effort');
        choice(entry.effortLevel, supported, `${key}.${model}.effortLevel`);
      }
      if ('maxEffortLevel' in entry) {
        if (supported.length === 0) fail(`${key}.${model}.maxEffortLevel`, 'this model does not support effort');
        const sessions = Object.hasOwn(CLAUDE_MODEL_REASONING_EFFORTS, canonical) ? claudeSessionEfforts(canonical) : ['max'];
        choice(entry.maxEffortLevel, [...supported, ...sessions], `${key}.${model}.maxEffortLevel`);
      }
      if ('autoCompactWindow' in entry && entry.autoCompactWindow !== 'auto') range(entry.autoCompactWindow, 100_000, 1_000_000, `${key}.${model}.autoCompactWindow`);
    }
  }
}

/** Migrate model-bearing settings only; arbitrary strings and custom IDs stay intact. */
function migrateModelReferences(out: Record<string, unknown>): void {
  const migrate = (value: unknown): unknown => typeof value === 'string' ? normalizeClaudeModelReference(value) : value;
  if ('advisorModel' in out) out.advisorModel = migrate(out.advisorModel);
  for (const key of ['fallbackModel', 'availableModels']) {
    if (Array.isArray(out[key])) out[key] = [...new Set(out[key].map(migrate))];
  }
  for (const key of ['modelSettings', 'modelOverrides']) {
    const values = out[key];
    if (!record(values)) continue;
    const migrated: Record<string, unknown> = {};
    // Explicit current entries win independently of the original property order.
    const entries = Object.entries(values).sort(([a], [b]) => Number(normalizeClaudeModelReference(a) === a) - Number(normalizeClaudeModelReference(b) === b));
    for (const [model, value] of entries) {
      const target = normalizeClaudeModelReference(model);
      const next = key === 'modelOverrides' ? migrate(value) : value;
      migrated[target] = record(migrated[target]) && record(next) ? { ...migrated[target], ...next } : next;
    }
    out[key] = migrated;
  }
  if (record(out.modelPicker) && Array.isArray(out.modelPicker.options)) {
    for (const option of out.modelPicker.options) {
      if (!record(option)) continue;
      option.model = migrate(option.model);
      if ('behavesAs' in option) option.behavesAs = migrate(option.behavesAs);
    }
  }
  if (record(out.env)) {
    for (const key of CLAUDE_MODEL_ENV_KEYS) {
      if (key in out.env) out.env[key] = migrate(out.env[key]);
    }
  }
  if (record(out.hooks)) {
    for (const groups of Object.values(out.hooks)) {
      if (!Array.isArray(groups)) continue;
      for (const group of groups) {
        if (!record(group) || !Array.isArray(group.hooks)) continue;
        for (const hook of group.hooks) if (record(hook) && 'model' in hook) hook.model = migrate(hook.model);
      }
    }
  }
}

/** Preserve current user-scope keys; report settings that would be inert. */
export function normalizeClaudeNativeSettings(value: unknown): Record<string, unknown> {
  if (value === undefined || value === null) return {};
  if (!record(value)) fail('', 'expected an object');
  const out = jsonCopy(value, '') as Record<string, unknown>;
  for (const path of CLAUDE_MANAGED_ONLY_NESTED_SETTINGS) {
    if (valueAtPath(out, path) !== undefined) fail(path, 'requires native managed settings; user settings cannot apply it');
  }
  for (const [key, item] of Object.entries(out)) {
    if (Object.hasOwn(deprecated, key)) fail(key, deprecated[key]!);
    if (Object.hasOwn(reserved, key)) fail(key, reserved[key]!);
    if (CLAUDE_MANAGED_ONLY_SETTINGS.includes(key)) fail(key, 'requires native managed settings; user settings cannot apply it');
    if (CLAUDE_GLOBAL_ONLY_SETTINGS.includes(key)) fail(key, 'belongs in ~/.claude.json, not settings.json');
    const rule = Object.hasOwn(CLAUDE_NATIVE_SETTING_RULES, key) ? CLAUDE_NATIVE_SETTING_RULES[key] : undefined;
    if (!rule) fail(key, 'unknown Claude Code setting');
    assertType(item, rule.type, key);
    if (rule.values) choice(item, rule.values, key);
    if (rule.items === 'string') strings(item, key);
    if (key === 'forceLoginOrgUUID' && Array.isArray(item)) strings(item, key);
    if (key === 'autoCompactWindow') range(item, 100_000, 1_000_000, key);
    if (key === 'cleanupPeriodDays') range(item, 1, Number.MAX_SAFE_INTEGER, key);
    if (key === 'desktopSessionCleanupPeriodDays') range(item, 0, Number.MAX_SAFE_INTEGER, key);
    if (key === 'feedbackSurveyRate') range(item, 0, 1, key, false);
    if (key === 'skillListingBudgetFraction') {
      range(item, 0, 1, key, false);
      if (item === 0) fail(key, 'must be greater than zero');
    }
    if (key === 'skillListingMaxDescChars' || key === 'bashOutputMaxChars') range(item, 1, Number.MAX_SAFE_INTEGER, key);
    if (key === 'maxProseWidth') range(item, 40, Number.MAX_SAFE_INTEGER, key);
    validateNested(key, item);
    if (record(item)) validateModelSettings(key, item);
  }
  for (const [path, rule] of Object.entries(CLAUDE_NATIVE_NESTED_SETTING_RULES)) {
    const item = valueAtPath(out, path);
    if (item === undefined) continue;
    assertType(item, rule.type, path);
    if (rule.values) choice(item, rule.values, path);
    if (rule.items === 'string') strings(item, path);
  }
  migrateModelReferences(out);
  return out;
}

function valueAtPath(root: Record<string, unknown>, path: string): unknown {
  let current: unknown = root;
  for (const part of path.split('.')) {
    if (!record(current)) return undefined;
    current = current[part];
  }
  return current;
}

/** Arrays and explicit empty objects are values; populated objects own leaves. */
export function claudeNativeOwnedPaths(settings: Record<string, unknown>, prefix: string[] = []): string[] {
  return Object.entries(settings).flatMap(([key, value]) => {
    const parts = [...prefix, key];
    if (record(value) && Object.keys(value).length > 0) return claudeNativeOwnedPaths(value, parts);
    return [parts.some(part => part.includes('.')) ? `json:${JSON.stringify(parts)}` : parts.join('.')];
  });
}
