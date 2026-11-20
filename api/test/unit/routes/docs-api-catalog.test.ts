import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectRegisteredRoutes } from './registered-routes.js';

/**
 * `docs/API.md` is the fleet's route catalogue: one `` `METHOD /path` `` code
 * span per registered route, grouped by surface, with auth, capability and a
 * link into `docs/interface-api.md` (which owns behaviour and wire contract).
 *
 * One scan, both directions:
 *  - doc to route: a documented route with no registration in `api/src/routes`
 *    fails (PHP-era survivors and rename leftovers cannot sit in the doc);
 *  - route to doc: a registered route no code span documents fails (a new
 *    endpoint cannot ship without its catalogue line).
 *
 * `interface-api-doc-routes.test.ts` runs the same pins against the spec.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const API_DOC = resolve(HERE, '../../../../docs/API.md');

/**
 * Documented `METHOD /path` entries the app deliberately does not register,
 * and what serves them instead.
 */
const UNREGISTERED_PATHS: Record<string, string> = {
  'GET /admin/ws': 'websocket upgrade, registered by api/src/ws/server.ts outside api/src/routes',
  'GET /admin/*': 'static SPA bundle and manual assets, served by the static mount rather than a route',
};

/** Registered `METHOD /path` entries the catalogue deliberately leaves out, and why. */
const ALLOWED_UNDOCUMENTED: Record<string, string> = {};

/** A `{param}` / `:param` placeholder, on either side of the comparison. */
const PARAM = ':param';
const PLACEHOLDER = /\{[^}]*\}|:[A-Za-z_][A-Za-z0-9_]*/g;

const CODE_SPAN = /`([^`\n]+)`/g;
const ENTRY = /^(GET|POST|PUT|PATCH|DELETE|OPTIONS)\s+(\/\S*)$/;

interface DocEntry {
  /** Line in `docs/API.md`. */
  line: number;
  /** `METHOD /path` as written, for the failure message. */
  text: string;
  method: string;
  /** Path with query string dropped and every placeholder reduced to `:param`. */
  path: string;
}

/**
 * Drop everything from the first `?`/`[` (documented query strings and
 * optional-parameter brackets are not path segments) and reduce every
 * placeholder to `PARAM`, so `{version}` and `:version` compare equal even in a
 * segment that also carries literal text (`/v{version}` / `/v:version`).
 * A trailing `*` survives: the CORS preflight routes serve a whole subtree.
 */
function normalizePath(path: string): string {
  const query = path.search(/[?[]/);
  return (query === -1 ? path : path.slice(0, query)).replace(PLACEHOLDER, PARAM);
}

function collectDocEntries(): DocEntry[] {
  const entries: DocEntry[] = [];
  let fenced = false;
  for (const [index, line] of readFileSync(API_DOC, 'utf8').split('\n').entries()) {
    // Fenced blocks hold request/response samples, not catalogue entries.
    if (line.trimStart().startsWith('```')) fenced = !fenced;
    if (fenced) continue;
    for (const span of line.matchAll(CODE_SPAN)) {
      const entry = ENTRY.exec(span[1]!.trim());
      if (!entry) continue;
      entries.push({
        line: index + 1,
        text: `${entry[1]} ${entry[2]}`,
        method: entry[1]!,
        path: normalizePath(entry[2]!),
      });
    }
  }
  return entries;
}

const routes = collectRegisteredRoutes();
const entries = collectDocEntries();
const documented = new Set(entries.map((entry) => `${entry.method} ${entry.path}`));
const registered = [...new Set(routes.map((route) => `${route.method} ${normalizePath(route.path)}`))].sort();

/**
 * True when `route` (already normalized) serves `documentedPath`: placeholders
 * compare equal on both sides, and a registered trailing `*` (the CORS
 * preflight routes) serves everything below it.
 */
function servedBy(documentedPath: string, route: string): boolean {
  if (route.endsWith('*')) return documentedPath.startsWith(route.slice(0, -1));
  return documentedPath === route;
}

const isRegistered = (entry: DocEntry): boolean =>
  routes.some((route) => route.method === entry.method && servedBy(entry.path, normalizePath(route.path)));

describe('docs/API.md route catalogue', () => {
  it('extracts the entries and routes it is meant to compare', () => {
    // A scan that silently matches nothing would pass every assertion below.
    expect(entries.length).toBeGreaterThan(500);
    expect(registered.length).toBeGreaterThan(500);
    for (const route of [
      'POST /auth',
      'GET /admin/overview',
      // Params normalize identically on both sides, mid-segment ones included.
      'POST /admin/projects/:param/board/cards/:param/move',
      'GET /wrapper/v2/bin/:param/:param/v:param/:param',
      // The verb travels with the path, so a documented GET cannot cover a DELETE.
      'DELETE /auth',
      // Wildcard preflight routes stay wildcards.
      'OPTIONS /anthropic/v1/*',
    ]) {
      expect(registered).toContain(route);
      expect(documented.has(route)).toBe(true);
    }
  });

  it('registers a route for every documented entry', () => {
    const missing = entries
      .filter((entry) => !(entry.text in UNREGISTERED_PATHS) && !isRegistered(entry))
      .map((entry) => `docs/API.md:${entry.line} documents ${entry.text}`);
    expect(
      missing,
      'register the route under api/src/routes, fix docs/API.md, ' +
        'or record it in UNREGISTERED_PATHS here with a reason',
    ).toEqual([]);
  });

  it('documents every registered route', () => {
    const missing = registered.filter((route) => !documented.has(route) && !(route in ALLOWED_UNDOCUMENTED));
    expect(
      missing,
      'document the route in docs/API.md as a `METHOD /path` code span, ' +
        'or record it in ALLOWED_UNDOCUMENTED here with a reason',
    ).toEqual([]);
  });

  it('keeps both allowlists free of stale entries', () => {
    const staleUnregistered = Object.keys(UNREGISTERED_PATHS).filter((text) => {
      const matching = entries.filter((entry) => entry.text === text);
      return matching.length === 0 || matching.some(isRegistered);
    });
    const staleUndocumented = Object.keys(ALLOWED_UNDOCUMENTED).filter(
      (route) => !registered.includes(route) || documented.has(route),
    );
    expect(staleUnregistered).toEqual([]);
    expect(staleUndocumented).toEqual([]);
    for (const reason of [...Object.values(UNREGISTERED_PATHS), ...Object.values(ALLOWED_UNDOCUMENTED)]) {
      expect(reason.trim()).not.toBe('');
      expect(reason).not.toContain('\n');
    }
  });

  it('keeps one line per route, each stating its auth tag', () => {
    const lines = readFileSync(API_DOC, 'utf8')
      .split('\n')
      .filter((line) => /^- `(?:GET|POST|PUT|PATCH|DELETE|OPTIONS) \//.test(line));
    const keys = lines.map((line) => {
      const entry = ENTRY.exec(/^- `([^`]+)`/.exec(line)![1]!);
      return `${entry![1]} ${normalizePath(entry![2]!)}`;
    });
    expect(keys.length).toBe(new Set(keys).size);
    expect(new Set(keys)).toEqual(new Set([...registered, ...Object.keys(UNREGISTERED_PATHS)]));
    const noAuth = lines.filter(
      (line) =>
        !/ — (?:public|host key|bridge token|relay token|admin session|public until the first owner exists|device bearer|pairing token|gateway key|external client key|connector token|path token|rescue media bearer)\b/.test(
          line,
        ),
    );
    expect(noAuth).toEqual([]);
  });
});
