import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The admin UI reaches the backend through literal path strings in
 * `frontend/src/lib` (`api.get("/admin/runner")`, `` api.post(`/admin/hosts/${id}`) ``),
 * and `api/src/routes` registers absolute Fastify paths with no `register`
 * prefixes — so the two sides can be compared as text. Nothing did:
 * `frontend.check` only typechecks, `api.test` never looked at the frontend,
 * and renaming or dropping an admin endpoint left the dashboard 404ing with a
 * fully green gate.
 *
 * This scan resolves each call's path argument (module-local `const` paths and
 * path builders included), turns `${…}` segments into `:param`, and fails when
 * no registered route can serve the result.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const API_ROUTES = resolve(HERE, '../../../src/routes');
const FRONTEND_LIB = resolve(HERE, '../../../../frontend/src/lib');

/**
 * Called paths that deliberately reach no Fastify route, and why — static
 * assets and the like. Empty today: `/admin/manual/*` looks like a static file
 * tree but is served by `registerAdminManualRoutes`.
 */
const NON_ROUTE_PATHS: Record<string, string> = {};

/** Files that call a path built at runtime, and what feeds that path. */
const RUNTIME_PATH_CALLERS: Record<string, string> = {
  'api/client.ts': 'the client itself — every wrapper forwards the path its caller passed',
  'api/memories.ts':
    'recordPath() builds /admin/memories/:scope and /admin/memories/:scope/:recordId from its arguments',
  'api/settings.ts':
    'makeToggle() posts to the path its caller passes — each one is also read by a literal api.get here',
};

/** Marks a `${…}` the scan could not resolve to a string. */
const UNKNOWN = '\u0000';
/** A path segment that is a resolved `${…}` — it matches any route segment. */
const PARAM = ':param';

interface CallSite {
  /** Path relative to the repository root. */
  file: string;
  line: number;
  /** Every path the call can request, or null when it is not statically known. */
  paths: string[] | null;
}

/** Index of the `}`/`)`/`]` closing the bracket at `open`, or -1. */
function matchingBracket(source: string, open: number): number {
  let depth = 0;
  let quote: string | null = null;
  for (let i = open; i < source.length; i++) {
    const c = source[i]!;
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') quote = c;
    else if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Source text of the first call argument, given the index of the `(`. */
function firstArgument(source: string, open: number): string | null {
  let depth = 0;
  let quote: string | null = null;
  for (let i = open; i < source.length; i++) {
    const c = source[i]!;
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') quote = c;
    else if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') {
      depth--;
      if (depth === 0) return source.slice(open + 1, i);
    } else if (c === ',' && depth === 1) return source.slice(open + 1, i);
  }
  return null;
}

/** Expression text starting at `start`, up to the `;`/newline that ends it. */
function expressionAt(source: string, start: number): string {
  let depth = 0;
  let quote: string | null = null;
  for (let i = start; i < source.length; i++) {
    const c = source[i]!;
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') quote = c;
    else if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    else if (depth === 0 && (c === ';' || c === '\n')) return source.slice(start, i);
  }
  return source.slice(start);
}

/** Index just past the `<…>` type arguments at `index`, if any. */
function skipTypeArguments(source: string, index: number): number {
  let i = index;
  while (/\s/.test(source[i] ?? '')) i++;
  if (source[i] !== '<') return i;
  let depth = 0;
  for (; i < source.length; i++) {
    const c = source[i]!;
    if (c === '<') depth++;
    else if (c === '>' && --depth === 0) {
      i++;
      break;
    }
  }
  while (/\s/.test(source[i] ?? '')) i++;
  return i;
}

/** True when the line holding `index` is a comment. */
function inComment(source: string, index: number): boolean {
  const start = source.lastIndexOf('\n', index) + 1;
  const trimmed = source.slice(start, index).trimStart();
  return trimmed.startsWith('*') || trimmed.startsWith('//') || trimmed.startsWith('/*');
}

const STRING_LITERAL = /^(['"])((?:\\.|(?!\1).)*)\1$/;
const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;
const ARROW_BODY = /^(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*(?::[^=]*)?=>/;

/** Text of the module-local `const <name> = …` initializer, or null. */
function declarationOf(name: string, source: string): string | null {
  const declaration = new RegExp(`\\b(?:const|let)\\s+${name}\\b[^=\\n]*=`).exec(source);
  if (!declaration) return null;
  const text = expressionAt(source, declaration.index + declaration[0].length).trim();
  return text.replace(/\s+as\s+const$/, '');
}

/** Top-level `key: value` pairs of an object literal, in source order. */
function objectEntries(objectText: string): { key: string; value: string }[] {
  const close = matchingBracket(objectText, 0);
  if (!objectText.startsWith('{') || close === -1) return [];
  const body = objectText.slice(1, close);
  const entries: { key: string; value: string }[] = [];
  let depth = 0;
  let quote: string | null = null;
  for (let i = 0; i < body.length; i++) {
    const c = body[i]!;
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') quote = c;
    else if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    else if (depth === 0 && /[A-Za-z_$]/.test(c) && (i === 0 || /[,\s]/.test(body[i - 1]!))) {
      const name = /^[\w$]+/.exec(body.slice(i))![0];
      let after = i + name.length;
      while (/\s/.test(body[after] ?? '')) after++;
      if (body[after] === ':') {
        entries.push({ key: name, value: expressionAt(body, after + 1).replace(/,\s*$/, '').trim() });
      }
      i = after;
    }
  }
  return entries;
}

/** Every string an expression can evaluate to, or null when it is dynamic. */
function valuesOf(expression: string, source: string, depth = 0): string[] | null {
  const text = expression.trim();
  if (depth > 6 || !text) return null;

  const literal = STRING_LITERAL.exec(text);
  if (literal) return [literal[2]!];

  if (text.length > 1 && text.startsWith('`') && text.endsWith('`')) {
    return expandTemplate(text.slice(1, -1), source, depth);
  }

  if (ARROW_BODY.test(text)) {
    return valuesOf(text.slice(text.indexOf('=>') + 2), source, depth + 1);
  }

  if (IDENTIFIER.test(text)) {
    const declaration = declarationOf(text, source);
    return declaration === null ? null : valuesOf(declaration, source, depth + 1);
  }

  // `OBJ.prop`, `OBJ[expr]` and `OBJ.prop(args)` — object literals of paths and
  // path builders (`manualEndpoints.article(slug)`, `PREFIX[engine]`).
  const member = /^([A-Za-z_$][\w$]*)(?:\.([A-Za-z_$][\w$]*)|\[[^\]]*\])/.exec(text);
  if (member) {
    const object = declarationOf(member[1]!, source);
    if (object === null) return null;
    const entries = objectEntries(object);
    const selected = member[2] ? entries.filter((e) => e.key === member[2]) : entries;
    if (!selected.length) return null;
    const values = selected.map((entry) => valuesOf(entry.value, source, depth + 1));
    return values.some((v) => v === null) ? null : values.flatMap((v) => v!);
  }

  return null;
}

/** Every string a template literal body can produce; `${…}` it cannot resolve become `UNKNOWN`. */
function expandTemplate(body: string, source: string, depth: number): string[] {
  let produced = [''];
  let literal = '';
  for (let i = 0; i < body.length; i++) {
    if (body[i] === '$' && body[i + 1] === '{') {
      const end = matchingBracket(body, i + 1);
      const substituted = (end === -1 ? null : valuesOf(body.slice(i + 2, end), source, depth + 1)) ?? [
        UNKNOWN,
      ];
      const prefix = literal;
      produced = produced.flatMap((head) => substituted.map((value) => head + prefix + value));
      literal = '';
      i = end === -1 ? body.length : end;
      continue;
    }
    literal += body[i];
  }
  const suffix = literal;
  return produced.map((head) => head + suffix);
}

/**
 * Turn a resolved path into route shape: drop the query string, and replace
 * whole `${…}` segments with `:param`. A trailing unresolved `${…}` is a query
 * builder (`` `/admin/logs${qs}` ``); anywhere else it makes the path unknown.
 */
function normalizePath(raw: string): string | null {
  const query = raw.indexOf('?');
  const path = query === -1 ? raw : raw.slice(0, query);
  if (!path.startsWith('/')) return null;
  const segments = path.split('/');
  const normalized: string[] = [];
  for (const [index, segment] of segments.entries()) {
    if (!segment.includes(UNKNOWN)) normalized.push(segment);
    else if (segment === UNKNOWN) normalized.push(PARAM);
    else if (index === segments.length - 1 && segment.endsWith(UNKNOWN)) {
      normalized.push(segment.slice(0, -UNKNOWN.length));
    } else return null;
  }
  return normalized.join('/');
}

function sourceFiles(root: string, extensions: string[]): string[] {
  return readdirSync(root, { recursive: true, encoding: 'utf8' })
    .filter((file) => extensions.some((extension) => file.endsWith(extension)))
    .sort();
}

const CALLER = /\b(?:api\.(?:get|post|put|patch|delete)|apiFetch)\b/g;

function collectCallSites(): CallSite[] {
  const sites: CallSite[] = [];
  for (const file of sourceFiles(FRONTEND_LIB, ['.ts', '.svelte'])) {
    const source = readFileSync(join(FRONTEND_LIB, file), 'utf8');
    for (const match of source.matchAll(CALLER)) {
      const at = match.index;
      // `export async function apiFetch<T>(path, …)` declares the client.
      if (source.slice(0, at).trimEnd().endsWith('function') || inComment(source, at)) continue;
      const open = skipTypeArguments(source, at + match[0].length);
      if (source[open] !== '(') continue;
      const argument = firstArgument(source, open);
      const resolved = argument === null ? null : valuesOf(argument, source);
      const normalized = resolved?.map(normalizePath) ?? null;
      sites.push({
        file: `frontend/src/lib/${file}`,
        line: source.slice(0, at).split('\n').length,
        paths: normalized?.some((path) => path === null) ? null : (normalized as string[] | null),
      });
    }
  }
  return sites;
}

const REGISTRAR = /\bapp\.(?:get|post|put|patch|delete)\b/g;
const ROUTE_OBJECT = /\bapp\.route\b/g;
const URL_PROPERTY = /\burl:\s*(['"`])([^'"`]*)\1/;

function collectRoutePaths(): string[] {
  const paths: string[] = [];
  for (const file of sourceFiles(API_ROUTES, ['.ts'])) {
    const source = readFileSync(join(API_ROUTES, file), 'utf8');
    for (const match of source.matchAll(REGISTRAR)) {
      if (inComment(source, match.index)) continue;
      const open = skipTypeArguments(source, match.index + match[0].length);
      if (source[open] !== '(') continue;
      const literal = STRING_LITERAL.exec((firstArgument(source, open) ?? '').trim());
      if (literal) paths.push(literal[2]!);
    }
    for (const match of source.matchAll(ROUTE_OBJECT)) {
      if (inComment(source, match.index)) continue;
      const options = firstArgument(source, match.index + match[0].length);
      const url = options === null ? null : URL_PROPERTY.exec(options);
      if (url) paths.push(url[2]!);
    }
  }
  return paths;
}

/** True when `route` can serve `called`; `:param` on either side matches any segment. */
function servedBy(called: string, route: string): boolean {
  const call = called.split('/');
  const registered = route.split('/');
  if (call.length !== registered.length) return false;
  return call.every(
    (segment, index) =>
      segment === PARAM || registered[index]!.startsWith(':') || segment === registered[index],
  );
}

const sites = collectCallSites();
const routePaths = collectRoutePaths();
const calledPaths = new Set(sites.flatMap((site) => site.paths ?? []));

describe('frontend API path coverage', () => {
  it('extracts the calls and routes it is meant to compare', () => {
    // A scan that silently matches nothing would pass every other assertion.
    expect(sites.length).toBeGreaterThan(140);
    expect(routePaths.length).toBeGreaterThan(150);
    expect(routePaths).toContain('/admin/runner/run');
    expect(calledPaths.has('/admin/runner/run')).toBe(true);
    // Resolved through a module-local const, an object literal and a builder.
    expect(calledPaths.has('/admin/projects/:param/todos/:param')).toBe(true);
    expect(calledPaths.has('/admin/openai/keys')).toBe(true);
    expect(calledPaths.has('/admin/claude/keys')).toBe(true);
    expect(calledPaths.has('/admin/manual/article/:param')).toBe(true);
    // Query strings are not path segments.
    expect(calledPaths.has('/admin/memories/audit')).toBe(true);
  });

  it('registers a route for every path the admin UI calls', () => {
    const missing = sites.flatMap((site) =>
      (site.paths ?? [])
        .filter(
          (path) =>
            !(path in NON_ROUTE_PATHS) && !routePaths.some((route) => servedBy(path, route)),
        )
        .map((path) => `${site.file}:${site.line} calls ${path}`),
    );
    expect(
      missing,
      'register the path under api/src/routes, fix the call, ' +
        'or record it in NON_ROUTE_PATHS here with a reason',
    ).toEqual([]);
  });

  it('accounts for every call whose path is built at runtime', () => {
    const unexplained = sites
      .filter(
        (site) =>
          site.paths === null &&
          !(site.file.slice('frontend/src/lib/'.length) in RUNTIME_PATH_CALLERS),
      )
      .map((site) => `${site.file}:${site.line}`);
    expect(
      unexplained,
      'call a literal path, or record the file in RUNTIME_PATH_CALLERS with a reason',
    ).toEqual([]);
  });

  it('keeps both allowlists free of stale entries', () => {
    const stale = [
      ...Object.keys(NON_ROUTE_PATHS).filter(
        (path) => !calledPaths.has(path) || routePaths.some((route) => servedBy(path, route)),
      ),
      ...Object.keys(RUNTIME_PATH_CALLERS).filter(
        (file) => !sites.some((site) => site.file === `frontend/src/lib/${file}` && site.paths === null),
      ),
    ];
    expect(stale).toEqual([]);
    for (const reason of [...Object.values(NON_ROUTE_PATHS), ...Object.values(RUNTIME_PATH_CALLERS)]) {
      expect(reason.trim()).not.toBe('');
      expect(reason).not.toContain('\n');
    }
  });
});
