import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  expressionAt,
  firstArgument,
  matchingBracket,
  skipTypeArguments,
  sourceFiles,
  stripComments,
  STRING_LITERAL,
} from './registered-routes.js';

/**
 * The header comment of `admin/auth/index.ts` states the policy for the whole
 * `/admin` surface — the status probe, login, password request/reset and the
 * passkey login routes are public, every other route guards on
 * `app.requireAdmin` — and roughly 170 registrations honoured it by hand, with
 * nothing checking it. Several routes register
 * `preHandler: [adminSpa, app.requireAdmin]`, and `adminSpa` short-circuits
 * HTML navigations before the guard runs, so dropping `app.requireAdmin` from
 * such a list still serves the SPA shell to a browser while handing JSON to any
 * unauthenticated XHR caller — no suite goes red.
 *
 * This scan reads every `/admin` registration out of `api/src/routes` and fails
 * when its options never reach `app.requireAdmin`. The exceptions are parsed
 * out of that header comment rather than restated here, so the doc and the
 * allowlist cannot drift apart.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const API_ROUTES = resolve(HERE, '../../../src/routes');
/** The module whose header comment declares which `/admin` routes are public. */
const AUTH_MODULE = 'admin/auth/index.ts';

/**
 * The `METHOD /path` registrations that deliberately carry no guard, because
 * the caller is by definition not yet authenticated. Held below against the
 * public routes the `AUTH_MODULE` header comment names.
 */
const PUBLIC_ROUTES = [
  'GET /admin/auth/status',
  'POST /admin/auth/login',
  'POST /admin/auth/login/method',
  'POST /admin/auth/password/request',
  'POST /admin/auth/password/reset',
  'POST /admin/auth/passkey/login',
  'POST /admin/auth/passkey/login/options',
];

interface AdminRoute {
  /** `METHOD /path`, matching the `PUBLIC_ROUTES` entries. */
  text: string;
  /** Registered path, `:param` segments included. */
  path: string;
  /** Module, relative to `api/src/routes`. */
  file: string;
  line: number;
  /** True when the registration options reach `app.requireAdmin`. */
  guarded: boolean;
}

const GUARD = 'app.requireAdmin';
const SPA_PREHANDLER = 'adminSpaHtmlPreHandler';
const REGISTRAR = /\bapp\.(get|post|put|patch|delete|options)\b/g;
const ROUTE_OBJECT = /\bapp\.route\b/g;
const URL_PROPERTY = /\burl:\s*(['"`])([^'"`]*)\1/;
const METHOD_PROPERTY = /\bmethod:\s*(['"`])([^'"`]*)\1/;
const CONST_BINDING = /\bconst\s+([A-Za-z_$][\w$]*)\s*=/g;
const PREHANDLER_LIST = /\bpreHandler:\s*\[/g;

function lineAt(source: string, index: number): number {
  return source.slice(0, index).split('\n').length;
}

/** True when `options` names `identifier` (an identifier, so `\b` is enough). */
function references(options: string, identifier: string): boolean {
  return new RegExp(`\\b${identifier}\\b`).test(options);
}

/**
 * Local names bound to a preHandler that itself reaches `app.requireAdmin`:
 * `admin/users/index.ts` wraps the guard in `requireAdminOrBootstrap` so the
 * very first user can be created before any session exists.
 */
function guardAliases(source: string): string[] {
  const names: string[] = [];
  for (const match of source.matchAll(CONST_BINDING)) {
    const initializer = expressionAt(source, match.index + match[0].length);
    if (initializer.includes(GUARD)) names.push(match[1]!);
  }
  return names;
}

/** The local name bound to `adminSpaHtmlPreHandler(ctx)`, if the module uses it. */
function spaBinding(source: string): string | null {
  const binding = new RegExp(`\\bconst\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*${SPA_PREHANDLER}\\s*\\(`);
  return binding.exec(source)?.[1] ?? null;
}

/**
 * Options object of the call whose `(` sits at `open`, given the source text of
 * its first argument. Empty when the registration passes the handler directly
 * (`app.get('/admin/auth/status', async (req) => …)`), which carries no guard.
 */
function optionsObject(source: string, open: number, first: string): string {
  let i = open + 1 + first.length;
  if (source[i] === ',') i++;
  while (/\s/.test(source[i] ?? '')) i++;
  if (source[i] !== '{') return '';
  const close = matchingBracket(source, i);
  return close === -1 ? '' : source.slice(i, close + 1);
}

/** Every `/admin` registration, in both the `app.get(…)` and `app.route({…})` shapes. */
function collectAdminRoutes(): AdminRoute[] {
  const routes: AdminRoute[] = [];
  for (const file of sourceFiles(API_ROUTES, ['.ts'])) {
    const source = stripComments(readFileSync(join(API_ROUTES, file), 'utf8'));
    const aliases = guardAliases(source);
    const guarded = (options: string): boolean =>
      options.includes(GUARD) || aliases.some((alias) => references(options, alias));
    for (const match of source.matchAll(REGISTRAR)) {
      const open = skipTypeArguments(source, match.index + match[0].length);
      if (source[open] !== '(') continue;
      const first = firstArgument(source, open);
      const literal = first === null ? null : STRING_LITERAL.exec(first.trim());
      if (!literal || !literal[2]!.startsWith('/admin')) continue;
      const path = literal[2]!;
      routes.push({
        text: `${match[1]!.toUpperCase()} ${path}`,
        path,
        file,
        line: lineAt(source, match.index),
        guarded: guarded(optionsObject(source, open, first!)),
      });
    }
    for (const match of source.matchAll(ROUTE_OBJECT)) {
      const options = firstArgument(source, match.index + match[0].length);
      const url = options === null ? null : URL_PROPERTY.exec(options);
      const method = options === null ? null : METHOD_PROPERTY.exec(options);
      if (!url || !method || !url[2]!.startsWith('/admin')) continue;
      const path = url[2]!;
      routes.push({
        text: `${method[2]!.toUpperCase()} ${path}`,
        path,
        file,
        line: lineAt(source, match.index),
        guarded: guarded(options!),
      });
    }
  }
  return routes;
}

/** `preHandler: [...]` lists that pull in the SPA short-circuit, and whether they guard. */
function collectSpaPreHandlers(): { text: string; guarded: boolean }[] {
  const lists: { text: string; guarded: boolean }[] = [];
  for (const file of sourceFiles(API_ROUTES, ['.ts'])) {
    const source = stripComments(readFileSync(join(API_ROUTES, file), 'utf8'));
    const binding = spaBinding(source);
    if (binding === null) continue;
    for (const match of source.matchAll(PREHANDLER_LIST)) {
      const open = match.index + match[0].length - 1;
      const close = matchingBracket(source, open);
      const list = close === -1 ? '' : source.slice(open, close + 1);
      if (!references(list, binding)) continue;
      lists.push({ text: `${file}:${lineAt(source, match.index)}`, guarded: list.includes(GUARD) });
    }
  }
  return lists;
}

const AUTH_HEADER = /\/\*\*([\s\S]*?)\*\/\s*export async function registerAdminAuthRoutes\b/;

/** True when the name the comment writes covers registered `path`. */
function covers(documented: string, path: string): boolean {
  if (!documented.endsWith('/*')) return documented === path;
  const prefix = documented.slice(0, -2);
  return path === prefix || path.startsWith(`${prefix}/`);
}

/**
 * Paths the `AUTH_MODULE` header comment names as public. The comment writes
 * them as suffixes under `/admin/auth/` in prose (`login/method`,
 * `passkey/login/*`), so every prose token is tried against the enumerated
 * paths and only the ones that name a real route survive — "public" and "probe"
 * match nothing. Backticked spans (the module's own prefixes and the guard
 * itself) and the sentence stating the default are dropped first.
 */
function documentedPublicPaths(paths: string[]): string[] {
  const source = readFileSync(join(API_ROUTES, AUTH_MODULE), 'utf8');
  const prose = (AUTH_HEADER.exec(source)?.[1] ?? '')
    .replace(/^\s*\*+/gm, ' ')
    .replace(/`[^`]*`/g, ' ')
    .split(/\bEvery other route\b/)[0]!;
  const named = new Set<string>();
  for (const token of prose.matchAll(/[a-z][a-z\d]*(?:\/[a-z\d*]+)*/g)) {
    for (const path of paths) if (covers(`/admin/auth/${token[0]}`, path)) named.add(path);
  }
  return [...named].sort();
}

const routes = collectAdminRoutes();
const unguarded = routes.filter((route) => !route.guarded);
const spaPreHandlers = collectSpaPreHandlers();
const documented = documentedPublicPaths(routes.map((route) => route.path));

describe('/admin route requireAdmin guard', () => {
  it('enumerates the registrations it is meant to check', () => {
    // A scan that silently matches nothing would pass every other assertion.
    expect(routes.length).toBeGreaterThan(100);
    expect(new Set(routes.map((route) => route.file)).size).toBeGreaterThan(1);
    const registered = new Set(routes.map((route) => route.text));
    // The bare, the options-object and the `app.route({…})` registration shapes.
    expect(registered.has('GET /admin/auth/status')).toBe(true);
    expect(registered.has('GET /admin/overview')).toBe(true);
    expect(registered.has('POST /admin/hosts/register')).toBe(true);
    // Routes outside /admin are another suite's business.
    expect([...registered].every((text) => text.includes(' /admin'))).toBe(true);
  });

  it('guards every registered /admin route on app.requireAdmin', () => {
    const missing = unguarded
      .filter((route) => !PUBLIC_ROUTES.includes(route.text))
      .map((route) => `${route.file}:${route.line} registers ${route.text}`);
    expect(
      missing,
      'add app.requireAdmin to the route options, or — if the route is public — ' +
        'name it in the admin/auth/index.ts header comment and in PUBLIC_ROUTES here',
    ).toEqual([]);
  });

  it('allowlists exactly the public routes the header comment names', () => {
    const allowlisted = [...new Set(PUBLIC_ROUTES.map((text) => text.split(' ')[1]!))].sort();
    expect(allowlisted, `keep PUBLIC_ROUTES and the ${AUTH_MODULE} header comment in step`).toEqual(
      documented,
    );
  });

  it('keeps the allowlist free of stale entries', () => {
    const stale = PUBLIC_ROUTES.filter((text) => !unguarded.some((route) => route.text === text));
    expect(stale, 'the route is gone or now guarded — drop it from PUBLIC_ROUTES').toEqual([]);
  });

  it('never lets the SPA short-circuit stand in for the guard', () => {
    expect(spaPreHandlers.length).toBeGreaterThan(5);
    const unguardedLists = spaPreHandlers.filter((list) => !list.guarded).map((list) => list.text);
    expect(
      unguardedLists,
      'adminSpaHtmlPreHandler answers HTML navigations before the guard runs, so a ' +
        'preHandler list holding it must hold app.requireAdmin too',
    ).toEqual([]);
  });
});
