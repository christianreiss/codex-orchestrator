/** Codex 0.166 MITM declaration/use constraints, without resolving any secret.
 * Sources: config/src/permissions_toml.rs and network-proxy/src/mitm_hook.rs
 * plus aws_sigv4.rs/secret_substitution.rs at rust-v0.166.0. globset 0.4.18 defines pattern syntax. */
import { Ajv } from 'ajv';
import { posix, win32 } from 'node:path';
import schema from './codex-config-schema.json' with { type: 'json' };
import { ValidationError } from '../http/errors.js';

const validateShape = new Ajv({ strict: false, allErrors: true, validateFormats: false })
  .compile({ definitions: schema.definitions, $ref: '#/definitions/NetworkMitmToml' });
const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
  ? value as Record<string, unknown> : {};
const fail = (path: string, message: string): never => { throw new ValidationError(`${path}: ${message}`, { param: path }); };
const headerName = (value: string, path: string) => {
  if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(value)) fail(path, 'expected a valid HTTP header name');
};
const headerValue = (value: string, path: string) => {
  // Native HeaderValue accepts opaque UTF-8 bytes, unlike Node's Latin-1 API.
  if ([...value].some(char => (char.codePointAt(0)! < 32 && char !== '\t') || char === '\u007f')) fail(path, 'expected a valid HTTP header value');
};

/** Validate globset's fallible syntax, not JavaScript/minimatch semantics. */
function validateGlob(pattern: string, path: string): void {
  const chars = [...pattern];
  let groups = 0;
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i]!;
    if (c === '\\') {
      if (++i === chars.length) fail(path, 'glob pattern has a dangling escape');
    } else if (c === '{') groups++;
    else if (c === '}') {
      if (groups-- === 0) fail(path, 'glob pattern has an unopened alternate');
    } else if (c === '[') {
      if (chars[i + 1] === '!' || chars[i + 1] === '^') i++;
      let first = true, inRange = false, last = '';
      for (;;) {
        const item = chars[++i];
        if (item === undefined) return fail(path, 'glob pattern has an unclosed character class');
        if (item === ']' && !first) break;
        if (item === '-') {
          if (first) last = item;
          else if (inRange) {
            if (item.codePointAt(0)! < last.codePointAt(0)!) fail(path, 'glob pattern has a reversed character range');
            inRange = false;
          } else inRange = true;
        } else {
          if (inRange && item.codePointAt(0)! < last.codePointAt(0)!) fail(path, 'glob pattern has a reversed character range');
          if (!inRange) last = item;
          inRange = false;
        }
        first = false;
      }
    }
  }
  if (groups !== 0) fail(path, 'glob pattern has an unclosed alternate');
}
function matcher(value: string, path: string, isPath = false): void {
  if (value.startsWith('pattern:')) {
    const pattern = value.slice(8);
    if (!pattern) fail(path, 'glob pattern must not be empty');
    validateGlob(pattern, path);
  } else if (isPath && (value.startsWith('literal:') ? value.slice(8) : value) === '') {
    fail(path, 'path prefix must not be empty');
  }
}
function normalizedHost(value: string): string {
  let host = value.trim();
  if (host.startsWith('[') && host.includes(']')) host = host.slice(1, host.indexOf(']'));
  else if ((host.match(/:/g) ?? []).length === 1) host = host.split(':')[0]!;
  return host.replace(/\.+$/, '');
}

function absoluteHostPath(source: string): boolean {
  return posix.isAbsolute(source) || (win32.isAbsolute(source) && win32.parse(source).root.length > 1);
}
function proxySecret(raw: unknown, path: string): void {
  const source = record(raw);
  if (Object.hasOwn(source, 'env_var') && (String(source.env_var) === '' || /[=\0]/.test(String(source.env_var)))) {
    fail(`${path}.env_var`, 'expected a nonempty environment name without equals or NUL');
  }
  if (Object.hasOwn(source, 'file') && !absoluteHostPath(String(source.file))) fail(`${path}.file`, 'expected an absolute path on the native host');
}
function boundedBody(operation: Record<string, unknown>, path: string): void {
  if (operation.port === 0) fail(`${path}.port`, 'expected a nonzero port');
  if (typeof operation.max_body_bytes === 'number' && operation.max_body_bytes > 16 * 1024 * 1024) {
    fail(`${path}.max_body_bytes`, 'must not exceed 16 MiB');
  }
}
function signingOperation(operation: Record<string, unknown>, path: string): void {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(String(operation.placeholder_access_key_id))) {
    fail(`${path}.placeholder_access_key_id`, 'expected 1 through 128 ASCII letters, digits, underscores or hyphens');
  }
  for (const key of ['region', 'service']) if (!/^[A-Za-z0-9-]+$/.test(String(operation[key]))) {
    fail(`${path}.${key}`, 'expected nonempty ASCII letters, digits or hyphens');
  }
  boundedBody(operation, path);
  for (const key of ['access_key_id', 'secret_access_key', 'session_token']) {
    if (Object.hasOwn(operation, key)) proxySecret(operation[key], `${path}.${key}`);
  }
}
function bodyOperation(operation: Record<string, unknown>, path: string): void {
  boundedBody(operation, path);
  const replacements = operation.replacements as Record<string, unknown>[];
  if (!replacements.length || replacements.length > 32) fail(`${path}.replacements`, 'expected 1 through 32 body bindings');
  for (const [i, binding] of replacements.entries()) {
    const placeholder = String(binding.placeholder), field = `${path}.replacements[${i}]`;
    if (placeholder.length < 16 || placeholder.length > 256 || [...placeholder].some(c => c.charCodeAt(0) > 127)) {
      fail(`${field}.placeholder`, 'expected an ASCII marker of 16 through 256 bytes');
    }
    proxySecret(binding.secret, `${field}.secret`);
    if (replacements.slice(0, i).some(previous => String(previous.placeholder).includes(placeholder) || placeholder.includes(String(previous.placeholder)))) {
      fail(`${field}.placeholder`, 'body substitution bindings must not overlap');
    }
  }
}

/** Schema plus native config-expressible constraints. Never opens files or env. */
export function validateCodexMitmSettings(raw: unknown, path: string): void {
  if (!validateShape(raw)) {
    const error = validateShape.errors?.[0];
    const location = error?.instancePath.replaceAll('/', '.') ?? '';
    const property = error?.keyword === 'additionalProperties' ? `.${String(error.params.additionalProperty)}` : '';
    fail(`${path}${location}${property}`, error?.message ?? 'invalid MITM configuration');
  }
  const mitm = record(raw), actions = record(mitm.actions);
  const usedActions = new Set(Object.values(record(mitm.hooks)).flatMap(hook => record(hook).action as string[]));
  for (const [name, value] of Object.entries(actions)) {
    const action = record(value), field = `${path}.actions.${name}`;
    const stripped = (action.strip_request_headers ?? []) as string[];
    const injected = (action.inject_request_headers ?? []) as Record<string, unknown>[];
    const signing = Object.hasOwn(action, 'aws_sigv4'), body = Object.hasOwn(action, 'body_secret_substitution');
    if (!stripped.length && !injected.length && !signing && !body) fail(field, 'must define at least one operation');
    if (mitm.version !== 2 && (signing || body || injected.some(header => Object.hasOwn(header, 'placeholder')))) fail(path, 'scoped actions and credential placeholders require version=2');
    // Native declaration checks apply to every action, but header and secret
    // constraints apply only when a hook references the action at runtime.
    if (!usedActions.has(name)) continue;
    if (signing) signingOperation(record(action.aws_sigv4), `${field}.aws_sigv4`);
    if (body) bodyOperation(record(action.body_secret_substitution), `${field}.body_secret_substitution`);
    for (const [i, header] of stripped.entries()) headerName(header, `${field}.strip_request_headers[${i}]`);
    for (const [i, header] of injected.entries()) {
      const at = `${field}.inject_request_headers[${i}]`, headerKey = typeof header.name === 'string' ? header.name : '';
      headerName(headerKey, `${at}.name`);
      if (headerKey.toLowerCase() === 'user-agent') fail(`${at}.name`, 'proxy secrets cannot be injected into User-Agent');
      if (Object.hasOwn(header, 'placeholder')) {
        if (mitm.version !== 2) fail(path, 'credential placeholders require version=2');
        if (header.placeholder === '' || ['host', 'content-length', 'transfer-encoding', 'connection', 'trailer', 'upgrade'].includes(headerKey.toLowerCase())) {
          fail(`${at}.placeholder`, 'invalid secret substitution header or placeholder');
        }
        headerValue(String(header.placeholder), `${at}.placeholder`);
      }
      const env = Object.hasOwn(header, 'secret_env_var'), file = Object.hasOwn(header, 'secret_file');
      if (env === file) fail(at, 'expected exactly one of secret_env_var or secret_file');
      if (env && String(header.secret_env_var).trim() === '') fail(`${at}.secret_env_var`, 'must not be empty');
      if (file) {
        const source = String(header.secret_file);
        if (!source.trim() || (!posix.isAbsolute(source) && !(win32.isAbsolute(source) && win32.parse(source).root.length > 1))) fail(`${at}.secret_file`, 'expected a nonempty absolute path on the native host');
      }
      if (typeof header.prefix === 'string') headerValue(header.prefix, `${at}.prefix`);
    }
  }
  for (const [name, value] of Object.entries(record(mitm.hooks))) {
    const hook = record(value), field = `${path}.hooks.${name}`;
    for (const [operation, description] of [['aws_sigv4', 'AWS signing'], ['body_secret_substitution', 'body substitution']] as const) {
      if ((hook.action as string[]).filter(action => Object.hasOwn(record(actions[action]), operation)).length > 1) {
        fail(`${field}.action`, `must select at most one ${description} action`);
      }
    }
    const host = normalizedHost(String(hook.host));
    if (!host || host.includes('*')) fail(`${field}.host`, 'expected a nonempty exact host without wildcards');
    const schemes = (hook.schemes ?? []) as string[], ports = (hook.ports ?? []) as number[];
    if (schemes.some(scheme => !['http', 'https'].includes(scheme.toLowerCase()))) fail(`${field}.schemes`, 'expected HTTP or HTTPS schemes');
    if (ports.some(port => port < 1 || port > 65535)) fail(`${field}.ports`, 'expected nonzero ports from 1 through 65535');
    if (mitm.version !== 2 && (ports.length || schemes.length)) fail(path, 'scoped ports and schemes require version=2');
    if (!(hook.methods as string[]).length || (hook.methods as string[]).some(method => !method.trim())) fail(`${field}.methods`, 'expected at least one nonempty method');
    const paths = hook.path_prefixes as string[];
    if (!paths.length) fail(`${field}.path_prefixes`, 'expected at least one path prefix');
    paths.forEach((value, i) => matcher(value, `${field}.path_prefixes[${i}]`, true));
    if (Object.hasOwn(hook, 'body')) fail(`${field}.body`, 'reserved for a future native release');
    for (const [key, values] of Object.entries(record(hook.query))) {
      const at = `${field}.query.${key}`;
      if (!key || !(values as string[]).length) fail(at, 'expected a nonempty query key and at least one allowed value');
      (values as string[]).forEach((value, i) => matcher(value, `${at}[${i}]`));
    }
    for (const [key, values] of Object.entries(record(hook.headers))) {
      const at = `${field}.headers.${key}`;
      headerName(key, at);
      (values as string[]).forEach((value, i) => matcher(value, `${at}[${i}]`));
    }
    if (!(hook.action as string[]).length) fail(`${field}.action`, 'must not be empty');
  }
}
