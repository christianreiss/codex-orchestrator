import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Index of the Fastify routes `api/src/routes` registers, read out of the
 * source text: every route is an `app.get('/literal', …)`-style call or an
 * `app.route({ method: 'GET', url: '/literal', … })` object, and no module
 * registers under a `register` prefix — so the paths in the source are the
 * paths the app serves.
 *
 * Shared by the checks that hold a second source of truth against the app:
 * the admin UI call sites (`frontend-path-coverage.test.ts`), the route
 * catalog in `docs/API.md` (`docs-api-catalog.test.ts`) and the in-app API
 * reference the admin manual ships
 * (`manual-shortcuts-api-routes.test.ts`).
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const API_ROUTES = resolve(HERE, '../../../src/routes');

export const STRING_LITERAL = /^(['"])((?:\\.|(?!\1).)*)\1$/;

export interface RegisteredRoute {
  /** Uppercase HTTP method. */
  method: string;
  /** Registered path, `:param` segments and trailing `*` included. */
  path: string;
}

/** Index of the `}`/`)`/`]` closing the bracket at `open`, or -1. */
export function matchingBracket(source: string, open: number): number {
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
export function firstArgument(source: string, open: number): string | null {
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
export function expressionAt(source: string, start: number): string {
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
export function skipTypeArguments(source: string, index: number): number {
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

/**
 * Blank out comments, leaving every other character at the same offset. An
 * apostrophe in prose (`preserve an existing host's values`) otherwise reads
 * as an unterminated string literal and swallows the rest of the block, which
 * silently dropped `POST /admin/hosts/register` from this index.
 */
function stripComments(source: string): string {
  const out = source.split('');
  let quote: string | null = null;
  let i = 0;
  while (i < source.length) {
    const c = source[i]!;
    if (quote) {
      if (c === '\\') i += 2;
      else {
        if (c === quote) quote = null;
        i++;
      }
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      quote = c;
      i++;
      continue;
    }
    if (c === '/' && (source[i + 1] === '/' || source[i + 1] === '*')) {
      const terminator = source[i + 1] === '/' ? '\n' : '*/';
      const end = source.indexOf(terminator, i + 2);
      const stop = end === -1 ? source.length : end + terminator.length;
      for (; i < stop; i++) if (source[i] !== '\n') out[i] = ' ';
      continue;
    }
    i++;
  }
  return out.join('');
}

/** True when the line holding `index` is a comment. */
export function inComment(source: string, index: number): boolean {
  const start = source.lastIndexOf('\n', index) + 1;
  const trimmed = source.slice(start, index).trimStart();
  return trimmed.startsWith('*') || trimmed.startsWith('//') || trimmed.startsWith('/*');
}

export function sourceFiles(root: string, extensions: string[]): string[] {
  return readdirSync(root, { recursive: true, encoding: 'utf8' })
    .filter((file) => extensions.some((extension) => file.endsWith(extension)))
    .sort();
}

const REGISTRAR = /\bapp\.(get|post|put|patch|delete|options)\b/g;
const ROUTE_OBJECT = /\bapp\.route\b/g;
const URL_PROPERTY = /\burl:\s*(['"`])([^'"`]*)\1/;
const METHOD_PROPERTY = /\bmethod:\s*(['"`])([^'"`]*)\1/;

export function collectRegisteredRoutes(): RegisteredRoute[] {
  const routes: RegisteredRoute[] = [];
  for (const file of sourceFiles(API_ROUTES, ['.ts'])) {
    const source = stripComments(readFileSync(join(API_ROUTES, file), 'utf8'));
    for (const match of source.matchAll(REGISTRAR)) {
      const open = skipTypeArguments(source, match.index + match[0].length);
      if (source[open] !== '(') continue;
      const literal = STRING_LITERAL.exec((firstArgument(source, open) ?? '').trim());
      if (literal) routes.push({ method: match[1]!.toUpperCase(), path: literal[2]! });
    }
    for (const match of source.matchAll(ROUTE_OBJECT)) {
      const options = firstArgument(source, match.index + match[0].length);
      const url = options === null ? null : URL_PROPERTY.exec(options);
      const method = options === null ? null : METHOD_PROPERTY.exec(options);
      if (url && method) routes.push({ method: method[2]!.toUpperCase(), path: url[2]! });
    }
  }
  return routes;
}
