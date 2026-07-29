import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  collectRegisteredRoutes,
  matchingBracket,
  type RegisteredRoute,
  sourceFiles,
  stripComments,
} from '../routes/registered-routes.js';

/**
 * cdx and clx reach the host API through paths hardcoded as Go string literals
 * (`c.JSON(ctx, http.MethodPost, "/sync/bootstrap", …)`), and `api/src/routes`
 * registers absolute Fastify paths with no `register` prefixes — so the two
 * sides can be compared as text, the same way `frontend-path-coverage.test.ts`
 * holds the admin UI against the route tree.
 *
 * Nothing did: each wrapper's own tests assert its literal against an httptest
 * stub, which pins the wrapper to itself and not to the server. Renaming or
 * dropping one of these endpoints left `api.test`, `wrappers.*.test` and
 * `wrappers.parity` green while every deployed wrapper 404s on its next launch.
 *
 * This scan reads the orchestrator client calls and the direct
 * `http.NewRequestWithContext(…, cfg.Orchestrator.BaseURL+"/path", …)` sites out
 * of the non-`_test.go` sources, strips the query string (`/skills?engine=codex`
 * is a call to `/skills`) and fails when no registered route can serve the verb
 * and path. `_test.go` files are skipped: the paths a Go test hands its stub are
 * fixtures, not calls a wrapper makes.
 */

const ROOT = resolve(import.meta.dirname, '../../../..');
/** Wrapper trees that talk to the host API, relative to the repository root. */
const WRAPPER_ROOTS = ['wrappers/cxx'];

/**
 * Called endpoints — `METHOD /path` — that deliberately reach no Fastify route,
 * and why. Empty today: every path both wrappers request is served.
 */
const NON_ROUTE_ENDPOINTS: Record<string, string> = {};

/**
 * Call sites whose path is not a literal, keyed `file:line`, and what feeds the
 * path. Empty today — every scanned site names its endpoint in place.
 */
const RUNTIME_PATH_CALLS: Record<string, string> = {};

/** Marks an operand the scan could not resolve to a string. */
const UNKNOWN = '\u0000';

interface CallSite {
  /** Path relative to the repository root. */
  file: string;
  line: number;
  /** Uppercase HTTP method the call issues. */
  method: string;
  /** The path requested, or null when it is not statically known. */
  path: string | null;
}

/** The `METHOD /path` key a call site is reported and allowlisted under. */
function endpointOf(method: string, path: string): string {
  return `${method} ${path}`;
}

/** Interpreted (`"…"`) and raw (`` `…` ``) Go string literals. */
const GO_LITERAL = /^(?:"((?:\\.|[^"\\])*)"|`([^`]*)`)$/;
const IDENTIFIER = /^[A-Za-z_]\w*$/;
/** `cfg.Orchestrator.BaseURL` and friends — the host root the path hangs off. */
const BASE_URL = /(?:^|\.)BaseURL(?:\s*,|\)|$)/;
const NILADIC_CALL = /^([A-Za-z_]\w*)\(\)$/;

/** Source text of the argument starting at `start`, up to its `,` or `)`. */
function argumentAt(source: string, start: number): string {
  let depth = 0;
  let quote: string | null = null;
  for (let i = start; i < source.length; i++) {
    const c = source[i]!;
    if (quote) {
      if (c === '\\' && quote !== '`') i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') quote = c;
    else if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' && depth === 0) return source.slice(start, i);
    else if (c === ')' || c === ']' || c === '}') depth--;
    else if (c === ',' && depth === 0) return source.slice(start, i);
  }
  return source.slice(start);
}

/** Top-level `+` operands of a Go expression, in source order. */
function operands(expression: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let start = 0;
  for (let i = 0; i < expression.length; i++) {
    const c = expression[i]!;
    if (quote) {
      if (c === '\\' && quote !== '`') i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') quote = c;
    else if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    else if (c === '+' && depth === 0) {
      parts.push(expression.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(expression.slice(start));
  return parts.map((part) => part.trim());
}

/** The string a Go literal denotes, or null when the text is not one. */
function literalValue(text: string): string | null {
  const literal = GO_LITERAL.exec(text);
  return literal ? (literal[1] ?? literal[2]!) : null;
}

/**
 * The literal a file-local `func <name>() string` returns, or null. cdx builds
 * its uninstall delete path that way (`authDeletePath()`); a helper with more
 * than one `return` is not a single path and stays unresolved.
 */
function returnedLiteral(name: string, source: string): string | null {
  const declaration = new RegExp(`\\bfunc\\s+${name}\\(\\)\\s+string\\s*\\{`).exec(source);
  if (!declaration) return null;
  const open = declaration.index + declaration[0].length - 1;
  const body = source.slice(open, matchingBracket(source, open));
  const returns = [...body.matchAll(/\breturn\s+([^\n]+)/g)];
  return returns.length === 1 ? literalValue(returns[0]![1]!.trim()) : null;
}

/** The string an operand evaluates to, or `UNKNOWN`. */
function valueOf(operand: string, source: string): string {
  const literal = literalValue(operand);
  if (literal !== null) return literal;
  if (BASE_URL.test(operand)) return '';
  const call = NILADIC_CALL.exec(operand);
  return (call && returnedLiteral(call[1]!, source)) ?? UNKNOWN;
}

/** Drop the query string; a path with an unresolved operand left in it is unknown. */
function normalizePath(raw: string): string | null {
  const query = raw.indexOf('?');
  const path = query === -1 ? raw : raw.slice(0, query);
  return path.startsWith('/') && !path.includes(UNKNOWN) ? path : null;
}

/**
 * True when the argument is a parameter of the enclosing function: the client's
 * own `Get` forwards the path its caller passed, and that caller is the site
 * naming the endpoint.
 */
function forwardsParameter(source: string, at: number, argument: string): boolean {
  if (!IDENTIFIER.test(argument)) return false;
  const start = source.lastIndexOf('\nfunc ', at);
  const body = start === -1 ? -1 : source.indexOf('{', start);
  return body !== -1 && new RegExp(`\\b${argument}\\b`).test(source.slice(start, body));
}

/** `c.JSON(ctx, http.MethodPost, …)` — the orchestrator client's request helper. */
const CLIENT_CALL = /\.JSON\(\s*\w+\s*,\s*http\.Method(\w+)\s*,/g;
/** `http.NewRequestWithContext(ctx, http.MethodGet, …)` — requests built by hand. */
const DIRECT_CALL = /\bhttp\.NewRequestWithContext\(\s*\w+\s*,\s*http\.Method(\w+)\s*,/g;
/** `url.Parse(cfg.Orchestrator.BaseURL + "/path")` before a hand-built GET. */
const PARSED_GET = /\burl\.Parse\(/g;
/** A hand-built request is a host-API call only when it hangs off the base URL. */
const ORCHESTRATOR_URL = /\bOrchestrator\.BaseURL\b/;

function collectCallSites(): CallSite[] {
  const sites: CallSite[] = [];
  for (const root of WRAPPER_ROOTS) {
    for (const file of sourceFiles(join(ROOT, root), ['.go'])) {
      // A Go test's httptest stub is not a call site.
      if (file.endsWith('_test.go')) continue;
      const source = stripComments(readFileSync(join(ROOT, root, file), 'utf8'));
      for (const pattern of [CLIENT_CALL, DIRECT_CALL]) {
        for (const match of source.matchAll(pattern)) {
          const at = match.index;
          const argument = argumentAt(source, at + match[0].length).trim();
          if (pattern === DIRECT_CALL && !ORCHESTRATOR_URL.test(argument)) continue;
          if (forwardsParameter(source, at, argument)) continue;
          const raw = operands(argument)
            .map((operand) => valueOf(operand, source))
            .join('');
          sites.push({
            file: `${root}/${file}`,
            line: source.slice(0, at).split('\n').length,
            method: match[1]!.toUpperCase(),
            path: normalizePath(raw),
          });
        }
      }
      for (const match of source.matchAll(PARSED_GET)) {
        const at = match.index;
        const argument = argumentAt(source, at + match[0].length).trim();
        if (!ORCHESTRATOR_URL.test(argument)) continue;
        const raw = operands(argument)
          .map((operand) => valueOf(operand, source))
          .join('');
        const path = normalizePath(raw);
        if (path === null) continue;
        sites.push({
          file: `${root}/${file}`,
          line: source.slice(0, at).split('\n').length,
          method: 'GET',
          path,
        });
      }
    }
  }
  return sites;
}

/**
 * True when `route` can serve a `method` call to `called`: the verbs must agree
 * and a `:param` segment matches any called segment.
 */
function servedBy(method: string, called: string, route: RegisteredRoute): boolean {
  if (method !== route.method) return false;
  const call = called.split('/');
  const registered = route.path.split('/');
  if (call.length !== registered.length) return false;
  return call.every(
    (segment, index) => registered[index]!.startsWith(':') || segment === registered[index],
  );
}

const sites = collectCallSites();
const routes = collectRegisteredRoutes();
const calledEndpoints = new Set(
  sites.flatMap((site) => (site.path === null ? [] : [endpointOf(site.method, site.path)])),
);

describe('wrapper host-API path coverage', () => {
  it('extracts the calls it is meant to compare', () => {
    // A scan that silently matches nothing would pass every other assertion.
    expect(sites.length).toBeGreaterThanOrEqual(20);
    expect(calledEndpoints.has('POST /auth')).toBe(true);
    expect(calledEndpoints.has('GET /host/lane')).toBe(true);
    expect(calledEndpoints.has('POST /sync/bootstrap')).toBe(true);
    // Read off a hand-built request, past its query string.
    expect(calledEndpoints.has('GET /wrapper/v2/config')).toBe(true);
  });

  it('registers a route for every method and path the wrappers call', () => {
    const missing = sites
      .filter(
        (site) =>
          site.path !== null &&
          !(endpointOf(site.method, site.path) in NON_ROUTE_ENDPOINTS) &&
          !routes.some((route) => servedBy(site.method, site.path!, route)),
      )
      .map((site) => `${site.file}:${site.line} calls ${endpointOf(site.method, site.path!)}`);
    expect(
      missing,
      'register the method and path under api/src/routes, fix the wrapper, ' +
        'or record it in NON_ROUTE_ENDPOINTS here with a reason',
    ).toEqual([]);
  });

  it('accounts for every call whose path is not a literal', () => {
    const unexplained = sites
      .filter((site) => site.path === null)
      .map((site) => `${site.file}:${site.line}`)
      .filter((location) => !(location in RUNTIME_PATH_CALLS));
    expect(
      unexplained,
      'call a literal path, or record the site in RUNTIME_PATH_CALLS with a reason',
    ).toEqual([]);
  });

  it('keeps both allowlists free of stale entries', () => {
    const stale = [
      ...Object.keys(NON_ROUTE_ENDPOINTS).filter((endpoint) => {
        const space = endpoint.indexOf(' ');
        const [method, path] = [endpoint.slice(0, space), endpoint.slice(space + 1)];
        return (
          !calledEndpoints.has(endpoint) || routes.some((route) => servedBy(method, path, route))
        );
      }),
      ...Object.keys(RUNTIME_PATH_CALLS).filter(
        (location) =>
          !sites.some(
            (site) => site.path === null && `${site.file}:${site.line}` === location,
          ),
      ),
    ];
    expect(stale).toEqual([]);
    for (const reason of [...Object.values(NON_ROUTE_ENDPOINTS), ...Object.values(RUNTIME_PATH_CALLS)]) {
      expect(reason.trim()).not.toBe('');
      expect(reason).not.toContain('\n');
    }
  });
});
