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

function validateObject(key: string, value: Record<string, unknown>): void {
  if (key === 'env' || key === 'modelOverrides' || key === 'vimInsertModeRemaps') {
    for (const [name, item] of Object.entries(value)) {
      assertType(item, 'string', `${key}.${name}`);
      if (key === 'vimInsertModeRemaps' && (name.length !== 2 || item !== '<Esc>')) fail(`${key}.${name}`, 'expected a two-character key mapped to <Esc>');
    }
  }
  if (key === 'enabledPlugins') {
    for (const [name, item] of Object.entries(value)) assertType(item, 'boolean', `${key}.${name}`);
  }
  if (key === 'modelPicker') {
    assertType(value.options, 'array', `${key}.options`);
    if ('replaceBuiltInOptions' in value) assertType(value.replaceBuiltInOptions, 'boolean', `${key}.replaceBuiltInOptions`);
    for (const item of value.options as unknown[]) {
      assertType(item, 'object', `${key}.options`);
      const option = item as Record<string, unknown>;
      assertType(option.model, 'string', `${key}.options.model`);
      for (const field of ['label', 'description', 'behavesAs']) if (field in option) assertType(option[field], 'string', `${key}.options.${field}`);
    }
  }
  if (key === 'pluginConfigs') {
    const options = (input: unknown, path: string) => {
      assertType(input, 'object', path);
      for (const [name, item] of Object.entries(input as Record<string, unknown>)) {
        if (Array.isArray(item)) strings(item, `${path}.${name}`);
        else assertType(item, ['string', 'number', 'boolean'], `${path}.${name}`);
      }
    };
    for (const [plugin, input] of Object.entries(value)) {
      assertType(input, 'object', `${key}.${plugin}`);
      const entry = input as Record<string, unknown>;
      if ('options' in entry) options(entry.options, `${key}.${plugin}.options`);
      if ('mcpServers' in entry) {
        assertType(entry.mcpServers, 'object', `${key}.${plugin}.mcpServers`);
        for (const [server, config] of Object.entries(entry.mcpServers as Record<string, unknown>)) options(config, `${key}.${plugin}.mcpServers.${server}`);
      }
    }
  }
  if (key === 'modelSettings') {
    for (const [model, settings] of Object.entries(value)) {
      assertType(settings, 'object', `${key}.${model}`);
      const entry = settings as Record<string, unknown>;
      if ('effortLevel' in entry) choice(entry.effortLevel, efforts, `${key}.${model}.effortLevel`);
      if ('maxEffortLevel' in entry) choice(entry.maxEffortLevel, [...efforts, 'max'], `${key}.${model}.maxEffortLevel`);
      if ('autoCompactWindow' in entry && entry.autoCompactWindow !== 'auto') range(entry.autoCompactWindow, 100_000, 1_000_000, `${key}.${model}.autoCompactWindow`);
    }
  }
  if (['statusLine', 'fileSuggestion', 'subagentStatusLine'].includes(key)) {
    choice(value.type, ['command'], `${key}.type`);
    assertType(value.command, 'string', `${key}.command`);
    if ('padding' in value) assertType(value.padding, 'number', `${key}.padding`);
    if ('refreshInterval' in value) range(value.refreshInterval, 1, Number.MAX_VALUE, `${key}.refreshInterval`, false);
    if ('hideVimModeIndicator' in value) assertType(value.hideVimModeIndicator, 'boolean', `${key}.hideVimModeIndicator`);
  }
  if (key === 'permissions') {
    for (const field of ['allow', 'ask', 'deny', 'additionalDirectories']) if (field in value) strings(value[field], `${key}.${field}`);
    if ('defaultMode' in value) choice(value.defaultMode, ['default', 'manual', 'acceptEdits', 'plan', 'auto', 'dontAsk', 'bypassPermissions'], `${key}.defaultMode`);
    if ('blockReadsOutsideWorkingDirectories' in value) assertType(value.blockReadsOutsideWorkingDirectories, 'boolean', `${key}.blockReadsOutsideWorkingDirectories`);
    for (const field of ['disableBypassPermissionsMode', 'disableAutoMode']) if (field in value) choice(value[field], ['disable'], `${key}.${field}`);
  }
  if (key === 'attribution') {
    for (const field of ['commit', 'pr']) if (field in value) assertType(value[field], 'string', `${key}.${field}`);
    if ('sessionUrl' in value) assertType(value.sessionUrl, 'boolean', `${key}.sessionUrl`);
  }
  if (key === 'voice') {
    for (const field of ['enabled', 'autoSubmit']) if (field in value) assertType(value[field], 'boolean', `${key}.${field}`);
    if ('mode' in value) choice(value.mode, ['hold', 'tap'], `${key}.mode`);
  }
  if (key === 'worktree') {
    for (const field of ['symlinkDirectories', 'sparsePaths']) if (field in value) strings(value[field], `${key}.${field}`);
    for (const field of ['baseRef', 'location']) if (field in value) assertType(value[field], 'string', `${key}.${field}`);
    if ('bgIsolation' in value) choice(value.bgIsolation, ['worktree', 'none'], `${key}.bgIsolation`);
  }
  if (key === 'hooks') {
    for (const [event, groups] of Object.entries(value)) {
      assertType(groups, 'array', `${key}.${event}`);
      for (const group of groups as unknown[]) {
        assertType(group, 'object', `${key}.${event}`);
        const item = group as Record<string, unknown>;
        if ('matcher' in item) assertType(item.matcher, 'string', `${key}.${event}.matcher`);
        assertType(item.hooks, 'array', `${key}.${event}.hooks`);
        for (const hook of item.hooks as unknown[]) {
          assertType(hook, 'object', `${key}.${event}.hooks`);
          const entry = hook as Record<string, unknown>;
          choice(entry.type, ['command', 'prompt', 'agent', 'http', 'mcp_tool'], `${key}.${event}.hooks.type`);
          const required = entry.type === 'command' ? 'command' : entry.type === 'http' ? 'url' : entry.type === 'mcp_tool' ? 'server' : 'prompt';
          assertType(entry[required], 'string', `${key}.${event}.hooks.${required}`);
          if (entry.type === 'mcp_tool') assertType(entry.tool, 'string', `${key}.${event}.hooks.tool`);
        }
      }
    }
  }
}

/** Preserve current user-scope keys; report settings that would be inert. */
export function normalizeClaudeNativeSettings(value: unknown): Record<string, unknown> {
  if (value === undefined || value === null) return {};
  if (!record(value)) fail('', 'expected an object');
  const out = jsonCopy(value, '') as Record<string, unknown>;
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
    if (record(item)) validateObject(key, item);
  }
  for (const path of CLAUDE_MANAGED_ONLY_NESTED_SETTINGS) {
    if (valueAtPath(out, path) !== undefined) fail(path, 'requires native managed settings; user settings cannot apply it');
  }
  for (const [path, rule] of Object.entries(CLAUDE_NATIVE_NESTED_SETTING_RULES)) {
    const item = valueAtPath(out, path);
    if (item === undefined) continue;
    assertType(item, rule.type, path);
    if (rule.values) choice(item, rule.values, path);
    if (rule.items === 'string') strings(item, path);
  }
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
