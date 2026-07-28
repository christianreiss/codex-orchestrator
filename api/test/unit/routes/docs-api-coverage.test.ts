import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectRegisteredRoutes } from './registered-routes.js';

/**
 * The other direction of `docs-api-catalog.test.ts`: that scan fails when the
 * catalog documents a route the app never registers, this one fails when the
 * app registers a route the catalog never documents. Undocumented endpoints
 * are how the admin/host surface silently outgrows its published contract —
 * the shared-memory, wrapper-v2 and admin-memory surfaces all shipped without
 * a catalog entry.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const API_DOC = resolve(HERE, '../../../../docs/API.md');

/**
 * Registered `METHOD /path` entries the catalog deliberately omits, and why.
 */
const UNDOCUMENTED_ROUTES: Record<string, string> = {
  'GET /cli/auth/verify':
    'browser HTML approval page read from STATIC_ROOT — the JSON CLI-login routes around it are documented',
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
 * placeholder to `PARAM`, so `{version}` and `:version` compare equal even
 * inside a segment that also carries literal text (`/v{version}` / `/v:version`).
 */
function normalizePath(path: string): string {
  const query = path.search(/[?[]/);
  return (query === -1 ? path : path.slice(0, query)).replace(PLACEHOLDER, PARAM);
}

function collectDocumented(): Set<string> {
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
const documented = collectDocumented();

describe('docs/API.md route coverage', () => {
  it('extracts the registered routes it is meant to check', () => {
    // A scan that silently matches nothing would pass the assertion below.
    expect(registered.length).toBeGreaterThan(150);
    expect(documented.size).toBeGreaterThan(150);
    expect(registered).toContain('POST /auth');
    expect(registered).toContain('GET /admin/overview');
    // Params normalize the same way on both sides.
    expect(registered).toContain('POST /projects/:param/todos/:param/done');
    expect(registered).toContain('GET /wrapper/v2/bin/:param/:param/v:param/:param');
    expect(documented.has('GET /wrapper/v2/bin/:param/:param/v:param/:param')).toBe(true);
  });

  it('documents every registered route', () => {
    const missing = registered.filter(
      (route) => !documented.has(route) && !(route in UNDOCUMENTED_ROUTES),
    );
    expect(
      missing,
      'document the route in docs/API.md as a `METHOD /path` code span, ' +
        'or record it in UNDOCUMENTED_ROUTES here with a reason',
    ).toEqual([]);
  });

  it('keeps the allowlist free of stale entries', () => {
    const stale = Object.keys(UNDOCUMENTED_ROUTES).filter(
      (route) => !registered.includes(route) || documented.has(route),
    );
    expect(stale).toEqual([]);
    for (const reason of Object.values(UNDOCUMENTED_ROUTES)) {
      expect(reason.trim()).not.toBe('');
      expect(reason).not.toContain('\n');
    }
  });
});
