import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectRegisteredRoutes } from './registered-routes.js';

/**
 * `docs/API.md` is the fleet's route catalog: roughly two hundred
 * `` `METHOD /path` `` code spans across the host, admin, MCP, projects and
 * OpenAI/Anthropic compat surfaces, and it is what wrapper and integrator work
 * is written against. Nothing checked that any of them exist, so PHP-era
 * survivors and entries left behind by a rename sat in the doc indefinitely.
 *
 * This scan reads the catalog's code spans and fails when a documented route
 * has no registration in `api/src/routes`.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const API_DOC = resolve(HERE, '../../../../docs/API.md');

/**
 * Documented `METHOD /path` entries the app deliberately does not register,
 * and what serves them instead.
 */
const UNREGISTERED_PATHS: Record<string, string> = {
  'GET /admin/login':
    'admin SPA page — served by the /admin/ static mount and its HTML fallback, not a route',
};

/** A documented `{param}`/`:param` segment; must land on a registered `:param`. */
const PARAM = ':param';

interface DocEntry {
  /** Line in `docs/API.md`. */
  line: number;
  /** `METHOD /path` as written, for the failure message. */
  text: string;
  method: string;
  /** Path with query string dropped and params normalized to `:param`. */
  path: string;
}

const CODE_SPAN = /`([^`\n]+)`/g;
const ENTRY = /^(GET|POST|PUT|PATCH|DELETE|OPTIONS)\s+(\/\S*)$/;

/**
 * Drop everything from the first `?`/`[` — documented query strings
 * (`/admin/logs?limit=50`) and optional-parameter brackets
 * (`/admin/chatgpt/usage[?force=1]`) are not path segments — and turn
 * `{param}` / `:param` segments into `PARAM`.
 */
function normalizeDocPath(documented: string): string {
  const query = documented.search(/[?[]/);
  const path = query === -1 ? documented : documented.slice(0, query);
  return path
    .split('/')
    .map((segment) => (/^(?:\{.*\}|:.+)$/.test(segment) ? PARAM : segment))
    .join('/');
}

function collectDocEntries(): DocEntry[] {
  const entries: DocEntry[] = [];
  let fenced = false;
  for (const [index, line] of readFileSync(API_DOC, 'utf8').split('\n').entries()) {
    // Fenced blocks hold request/response samples, not catalog entries.
    if (line.trimStart().startsWith('```')) fenced = !fenced;
    if (fenced) continue;
    for (const span of line.matchAll(CODE_SPAN)) {
      const entry = ENTRY.exec(span[1]!.trim());
      if (!entry) continue;
      entries.push({
        line: index + 1,
        text: `${entry[1]} ${entry[2]}`,
        method: entry[1]!,
        path: normalizeDocPath(entry[2]!),
      });
    }
  }
  return entries;
}

const routes = collectRegisteredRoutes();
const entries = collectDocEntries();

/**
 * True when `route` serves `documented`: a documented param segment has to be
 * a registered param segment, and a registered trailing `*` (the CORS
 * preflight routes) serves everything below it.
 */
function servedBy(documented: string, route: string): boolean {
  if (route.endsWith('*')) return documented.startsWith(route.slice(0, -1));
  const path = documented.split('/');
  const registered = route.split('/');
  if (path.length !== registered.length) return false;
  return path.every((segment, index) =>
    segment === PARAM ? registered[index]!.startsWith(':') : segment === registered[index],
  );
}

describe('docs/API.md route catalog', () => {
  it('extracts the documented entries it is meant to check', () => {
    // A scan that silently matches nothing would pass the assertion below.
    expect(entries.length).toBeGreaterThan(150);
    expect(routes.length).toBeGreaterThan(150);
    const documented = new Set(entries.map((entry) => `${entry.method} ${entry.path}`));
    expect(documented.has('POST /auth')).toBe(true);
    expect(documented.has('GET /admin/overview')).toBe(true);
    // Params, query strings and optional-parameter brackets normalize away.
    expect(documented.has('POST /projects/:param/todos/:param/done')).toBe(true);
    expect(documented.has('GET /admin/logs')).toBe(true);
    expect(documented.has('GET /admin/chatgpt/usage')).toBe(true);
    // Method + path, so a documented verb the app never registers is caught.
    expect(documented.has('DELETE /auth')).toBe(true);
    expect(documented.has('OPTIONS /anthropic/v1/messages')).toBe(true);
  });

  it('registers a route for every documented entry', () => {
    const missing = entries
      .filter(
        (entry) =>
          !(entry.text in UNREGISTERED_PATHS) &&
          !routes.some(
            (route) => route.method === entry.method && servedBy(entry.path, route.path),
          ),
      )
      .map((entry) => `docs/API.md:${entry.line} documents ${entry.text}`);
    expect(
      missing,
      'register the route under api/src/routes, fix docs/API.md, ' +
        'or record it in UNREGISTERED_PATHS here with a reason',
    ).toEqual([]);
  });

  it('keeps the allowlist free of stale entries', () => {
    const stale = Object.keys(UNREGISTERED_PATHS).filter(
      (text) =>
        !entries.some((entry) => entry.text === text) ||
        entries.some(
          (entry) =>
            entry.text === text &&
            routes.some(
              (route) => route.method === entry.method && servedBy(entry.path, route.path),
            ),
        ),
    );
    expect(stale).toEqual([]);
    for (const reason of Object.values(UNREGISTERED_PATHS)) {
      expect(reason.trim()).not.toBe('');
      expect(reason).not.toContain('\n');
    }
  });
});
