import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectRegisteredRoutes } from './registered-routes.js';

/**
 * `docs-api-catalog.test.ts` walks the catalog and fails when `docs/API.md`
 * documents a `` `METHOD /path` `` the app never registers. This scan walks the
 * other way: it fails when `api/src/routes` registers a route no code span in
 * the catalog documents.
 *
 * Without it a newly registered route is public API that nothing obliges anyone
 * to write down — the endpoint ships, wrappers and integrators discover it by
 * reading source, and the fleet's published contract falls quietly behind the
 * app it is supposed to describe.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const API_DOC = resolve(HERE, '../../../../docs/API.md');

/**
 * Registered `METHOD /path` entries the catalog deliberately leaves out, and why.
 */
const ALLOWED_UNDOCUMENTED: Record<string, string> = {
  'GET /cli/auth/verify':
    'browser redirect to the HTML device-approval page, reached through the start response\'s verify_url — the JSON /cli/auth/* routes around it are documented',
};

/** A `{param}` / `:param` placeholder, on either side of the comparison. */
const PARAM = ':param';
const PLACEHOLDER = /\{[^}]*\}|:[A-Za-z_][A-Za-z0-9_]*/g;

const CODE_SPAN = /`([^`\n]+)`/g;
const ENTRY = /^(GET|POST|PUT|PATCH|DELETE|OPTIONS)\s+(\/\S*)$/;

/**
 * Drop everything from the first `?`/`[` — documented query strings
 * (`/admin/logs?limit=50`) and optional-parameter brackets
 * (`/admin/chatgpt/usage[?force=1]`) are not path segments — and reduce every
 * placeholder to `PARAM`, so `{version}` and `:version` compare equal even in a
 * segment that also carries literal text (`/v{version}` / `/v:version`).
 *
 * A trailing `*` survives: the CORS preflight routes (`OPTIONS /v1/*`) serve a
 * whole subtree, and documenting one path below the wildcard does not document
 * the wildcard.
 */
function normalizePath(path: string): string {
  const query = path.search(/[?[]/);
  return (query === -1 ? path : path.slice(0, query)).replace(PLACEHOLDER, PARAM);
}

function collectDocumentedEntries(): Set<string> {
  const documented = new Set<string>();
  let fenced = false;
  for (const line of readFileSync(API_DOC, 'utf8').split('\n')) {
    // Fenced blocks hold request/response samples, not catalog entries.
    if (line.trimStart().startsWith('```')) fenced = !fenced;
    if (fenced) continue;
    for (const span of line.matchAll(CODE_SPAN)) {
      const entry = ENTRY.exec(span[1]!.trim());
      if (entry) documented.add(`${entry[1]} ${normalizePath(entry[2]!)}`);
    }
  }
  return documented;
}

const registered = [
  ...new Set(
    collectRegisteredRoutes().map((route) => `${route.method} ${normalizePath(route.path)}`),
  ),
].sort();
const documented = collectDocumentedEntries();

describe('docs/API.md coverage of registered routes', () => {
  it('extracts the routes and catalog entries it is meant to compare', () => {
    // A scan that silently matched nothing would pass every assertion below.
    expect(registered.length).toBeGreaterThan(150);
    expect(documented.size).toBeGreaterThan(150);
    expect(registered).toContain('POST /auth');
    expect(registered).toContain('GET /admin/overview');
    expect(documented.has('POST /auth')).toBe(true);
    expect(documented.has('GET /admin/overview')).toBe(true);
    // Params normalize identically on both sides, mid-segment ones included.
    expect(registered).toContain('POST /projects/:param/todos/:param/done');
    expect(registered).toContain('GET /wrapper/v2/bin/:param/:param/v:param/:param');
    expect(documented.has('GET /wrapper/v2/bin/:param/:param/v:param/:param')).toBe(true);
    // The verb travels with the path, so a documented GET cannot cover a DELETE.
    expect(registered).toContain('DELETE /auth');
    // Wildcard preflight routes stay wildcards.
    expect(registered).toContain('OPTIONS /anthropic/v1/*');
    expect(documented.has('OPTIONS /anthropic/v1/*')).toBe(true);
  });

  it('documents every registered route', () => {
    const missing = registered.filter(
      (route) => !documented.has(route) && !(route in ALLOWED_UNDOCUMENTED),
    );
    expect(
      missing,
      'document the route in docs/API.md as a `METHOD /path` code span, ' +
        'or record it in ALLOWED_UNDOCUMENTED here with a reason',
    ).toEqual([]);
  });

  it('keeps the allowlist free of stale entries', () => {
    const stale = Object.keys(ALLOWED_UNDOCUMENTED).filter(
      (route) => !registered.includes(route) || documented.has(route),
    );
    expect(
      stale,
      'the route is gone or now documented — drop it from ALLOWED_UNDOCUMENTED',
    ).toEqual([]);
    for (const reason of Object.values(ALLOWED_UNDOCUMENTED)) {
      expect(reason.trim()).not.toBe('');
      expect(reason).not.toContain('\n');
    }
  });
});
