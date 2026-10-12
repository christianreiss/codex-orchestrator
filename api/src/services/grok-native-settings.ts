import { ValidationError } from '../http/errors.js';
import { GROK_NATIVE_FIELDS } from './grok-native-fields.js';

type RecordValue = Record<string, unknown>;
const unsafeKeys = new Set(['__proto__', 'prototype', 'constructor']);
const deprecated: Record<string, string> = {
  'model.*.reasoning_effort': 'reasoning_efforts',
  'model.*.supports_reasoning_effort': 'reasoning_efforts',
  'ui.approval_mode': 'ui.permission_mode',
  'ui.ui_theme': 'ui.theme',
  'ui.show_timestamps': 'ui.timestamps',
};

export function grokRecord(value: unknown): RecordValue {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : {};
}

function fail(path: string[], reason: string): never {
  const name = `native_settings${path.length ? '.' + path.join('.') : ''}`;
  throw new ValidationError(`${name}: ${reason}`, { param: `settings.${name}` });
}

function isRecord(value: unknown): value is RecordValue {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function isControl(character: string): boolean {
  const code = character.charCodeAt(0);
  return code < 32 || code === 127;
}

function clone(value: unknown, path: string[], depth = 0): unknown {
  if (depth > 32) fail(path, 'configuration is nested too deeply');
  if (typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map((item, i) => clone(item, [...path, String(i)], depth + 1));
  if (!isRecord(value)) fail(path, 'expected a TOML-compatible value (null is not supported)');
  const result: RecordValue = {};
  for (const [key, item] of Object.entries(value)) {
    if (!key || unsafeKeys.has(key) || [...key].some(isControl)) fail([...path, key], 'invalid key');
    result[key] = clone(item, [...path, key], depth + 1);
  }
  return result;
}

function matches(value: unknown, type: string): boolean {
  if (type.startsWith('=')) return value === type.slice(1);
  if (type === 'table') return isRecord(value);
  if (type === 'integer') return typeof value === 'number' && Number.isSafeInteger(value);
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value);
  if (type.endsWith('[]')) return Array.isArray(value) && value.every(item => matches(item, type.slice(0, -2)));
  if (type === 'map<string,string>') return isRecord(value) && Object.values(value).every(item => typeof item === 'string');
  if (type === 'map<string,string[]>') return isRecord(value) && Object.values(value).every(item => matches(item, 'string[]'));
  return typeof value === type;
}

const fields = Object.entries(GROK_NATIVE_FIELDS).map(([key, types]) => ({
  key,
  parts: key.replaceAll('[]', '.[]').split('.'),
  types,
}));
function patternMatches(pattern: string[], path: string[]): boolean {
  return path.every((part, i) => pattern[i] === '*' || pattern[i] === part);
}

function validate(value: unknown, path: string[], candidates = fields): void {
  const matching = candidates.filter(field => field.parts.length >= path.length && patternMatches(field.parts, path));
  const exact = matching.find(field => field.parts.length === path.length);
  if (!matching.length) fail(path, 'unknown Grok setting');
  if (exact && deprecated[exact.key]) fail(path, `deprecated; use ${deprecated[exact.key]}`);
  if (exact && !exact.types.some(type => matches(value, type))) fail(path, `expected ${exact.types.join(' or ')}`);
  const children = matching.filter(field => field.parts.length > path.length);
  if (children.length) {
    if (Array.isArray(value)) {
      if (!children.some(field => field.parts[path.length] === '[]')) fail(path, 'expected a table');
      for (const item of value) validate(item, [...path, '[]'], children);
    } else {
      if (!isRecord(value)) fail(path, 'expected a table');
      for (const [key, item] of Object.entries(value)) validate(item, [...path, key], children);
    }
  }
}

/** Validate before storage; never silently discard unknown or deprecated native fields. */
export function normalizeGrokNativeSettings(raw: unknown, nestedOverride = false): RecordValue | undefined {
  if (raw === undefined) return undefined;
  if (!isRecord(raw)) fail([], 'expected an object');
  const value = clone(raw, []) as RecordValue;
  for (const [key, item] of Object.entries(value)) validate(item, [key]);
  for (const [key, control] of [['default', 'model'], ['default_reasoning_effort', 'reasoning_effort']]) {
    if (key! in grokRecord(value.models)) fail(['models', key!], `use settings.${control}; the fleet model controls own this setting`);
  }
  if (value.version_overrides !== undefined) {
    if (nestedOverride) fail(['version_overrides'], 'nested version overrides are not supported');
    for (const [index, entry] of (value.version_overrides as RecordValue[]).entries()) {
      const { minimum_version, maximum_version, ...patch } = entry;
      for (const [key, version] of Object.entries({ minimum_version, maximum_version })) {
        if (version !== undefined && (typeof version !== 'string' || !/^\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?$/.test(version))) {
          fail(['version_overrides', String(index), key], 'expected a semantic version');
        }
      }
      normalizeGrokNativeSettings(patch, true);
      // Conditional native layers run after the plain config and must not
      // bypass the structured controls, posture or managed MCP injection.
      for (const [root, key] of [['models', 'default'], ['models', 'default_reasoning_effort'], ['ui', 'permission_mode']]) {
        if (key! in grokRecord(patch[root!])) fail(['version_overrides', String(index), root!, key!], 'use the fleet model and posture controls');
      }
      if ('mcp_servers' in patch || 'model' in patch) fail(['version_overrides', String(index)], 'model and MCP overrides belong in the unconditional native settings');
    }
  }
  for (const root of ['auth', 'grok_com_config', 'announcements', 'campaigns']) {
    if (root in value) fail([root], 'owned by the managed subscription runtime');
  }
  const cli = grokRecord(value.cli);
  if (cli.auto_update === true) fail(['cli', 'auto_update'], 'updates are owned by the fleet version policy');
  if (cli.use_leader === false) fail(['cli', 'use_leader'], 'the managed receiver requires its private leader');
  const endpoints = grokRecord(value.endpoints);
  for (const key of ['models_base_url', 'models_list_url', 'cli_chat_proxy_base_url']) {
    if (key in endpoints) fail(['endpoints', key], 'owned by the managed subscription runtime');
  }
  const compat = grokRecord(value.compat);
  for (const vendor of ['claude', 'cursor']) {
    if (grokRecord(compat[vendor]).mcps === true) fail(['compat', vendor, 'mcps'], 'managed sessions disable implicit cross-engine MCP imports');
  }
  // Native range/type constraints that otherwise silently clamp or drop input.
  const ranges: Array<[string[], number, number]> = [
    [['session', 'auto_compact_threshold_percent'], 0, 100],
    [['ui', 'scroll_speed'], 1, 100], [['ui', 'scroll_lines'], 1, 10],
    [['ui', 'max_thoughts_width'], 40, 500],
    [['subagents', 'max_concurrent'], 1, Number.MAX_SAFE_INTEGER],
    [['subagents', 'max_depth'], 1, Number.MAX_SAFE_INTEGER],
    [['ui', 'status_line', 'padding'], 0, 16],
    [['ui', 'status_line', 'refresh_interval'], 1, 86400],
  ];
  for (const [path, min, max] of ranges) {
    const item = path.reduce<unknown>((v, key) => grokRecord(v)[key], value);
    if (item !== undefined && (typeof item !== 'number' || item < min || item > max)) fail(path, `expected ${min}–${max}`);
  }
  for (const [name, rawServer] of Object.entries(grokRecord(value.mcp_servers))) {
    const server = grokRecord(rawServer);
    if ((typeof server.command === 'string') === (typeof server.url === 'string')) fail(['mcp_servers', name], 'set exactly one of command or url');
    for (const field of ['env', 'headers']) {
      if (server[field] !== undefined && !matches(server[field], 'map<string,string>')) fail(['mcp_servers', name, field], 'expected a string map');
    }
    const timeouts = grokRecord(server.tool_timeouts);
    for (const field of ['startup_timeout_sec', 'tool_timeout_sec']) {
      if (server[field] !== undefined && (!Number.isSafeInteger(server[field]) || (server[field] as number) < 0)) fail(['mcp_servers', name, field], 'expected nonnegative integer seconds');
    }
    for (const [tool, timeout] of Object.entries(timeouts)) {
      if (!Number.isSafeInteger(timeout) || (timeout as number) < 0) fail(['mcp_servers', name, 'tool_timeouts', tool], 'expected nonnegative integer seconds');
    }
  }
  for (const [event, groups] of Object.entries(grokRecord(value.hooks))) {
    for (const [index, group] of (groups as RecordValue[]).entries()) {
      if (!Array.isArray(group.hooks)) fail(['hooks', event, String(index)], 'hooks array is required');
      for (const handler of group.hooks as RecordValue[]) {
        if (handler.type === 'command' && typeof handler.command !== 'string') fail(['hooks', event], 'command hooks require command');
        if (handler.type === 'http' && typeof handler.url !== 'string') fail(['hooks', event], 'HTTP hooks require url');
        if (!['command', 'http'].includes(String(handler.type))) fail(['hooks', event], 'hook type is required');
      }
    }
  }
  return value;
}

function key(value: string): string {
  return /^[A-Za-z0-9_-]+$/.test(value) ? value : quoted(value);
}
function quoted(value: string): string {
  return '"' + Array.from(value, character => {
    if (character === '"' || character === '\\') return '\\' + character;
    return isControl(character) ? '\\u' + character.charCodeAt(0).toString(16).padStart(4, '0') : character;
  }).join('') + '"';
}
function literal(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(literal).join(', ')}]`;
  if (isRecord(value)) return `{ ${Object.entries(value).map(([name, item]) => `${key(name)} = ${literal(item)}`).join(', ')} }`;
  return typeof value === 'string' ? quoted(value) : String(value);
}

/** Stable native TOML, including arrays of tables represented as inline-table arrays. */
export function renderGrokNativeToml(value: RecordValue): string {
  const lines: string[] = [];
  function table(body: RecordValue, path: string[]): void {
    if (path.length) lines.push('', `[${path.map(key).join('.')}]`);
    for (const [name, item] of Object.entries(body)) if (!isRecord(item)) lines.push(`${key(name)} = ${literal(item)}`);
    for (const [name, item] of Object.entries(body)) if (isRecord(item)) table(item, [...path, name]);
  }
  table(value, []);
  return lines.join('\n').trimStart() + '\n';
}

/** A path is encoded only when the old dotted representation would be ambiguous. */
function ownedPath(path: string[]): string {
  if (path[0] === 'mcp_servers' && path.length === 2) return path.join('.');
  if (path[0] === 'model' && path.length === 3 && !path[2]!.includes('.')) return path.join('.');
  return path[0] === 'model' || path.some(part => part.includes('.')) ? `json:${JSON.stringify(path)}` : path.join('.');
}

export function grokNativeOwnedPaths(value: RecordValue): string[] {
  const paths: string[] = [];
  function walk(item: unknown, path: string[]): void {
    if (isRecord(item) && !(path[0] === 'mcp_servers' && path.length === 2)) {
      for (const [name, child] of Object.entries(item)) walk(child, [...path, name]);
    } else if (path.length) paths.push(ownedPath(path));
  }
  walk(value, []);
  return paths;
}
