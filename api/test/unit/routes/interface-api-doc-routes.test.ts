import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectRegisteredRoutes } from './registered-routes.js';

/**
 * `docs/interface-api.md` is headed "API Interface (Source of Truth)", but
 * unlike `docs/API.md` — held against the app from both sides by
 * `docs-api-catalog.test.ts` and `docs-api-coverage.test.ts` — nothing checked
 * it, so whole route families drifted out of it while the heading kept
 * claiming authority: the `/cli/auth/*` device-login flow, the `/mcp`
 * transport itself, `/healthz` / `/readyz`, and the `/admin/theme`,
 * `/admin/scaling`, `/admin/auto-update` and `/admin/log-retention` settings
 * were all absent.
 *
 * This scan closes both directions at once. A documented `` `METHOD /path` ``
 * bullet that resolves to no registered route fails with its doc line, and a
 * registered route no bullet covers fails unless it is allowlisted below.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const INTERFACE_DOC = resolve(HERE, '../../../../docs/interface-api.md');

/**
 * Documented `METHOD /path` entries the app deliberately does not register,
 * and what serves them instead.
 */
const UNREGISTERED_PATHS: Record<string, string> = {
  'GET /admin/login':
    'admin SPA page — served by the /admin/ static mount and its HTML fallback, not a route',
  'GET /admin/password/reset?token=...':
    'admin SPA page — served by the /admin/ static mount and its HTML fallback, not a route',
  'GET /admin/hosts/{id}':
    'admin SPA host-detail page — the JSON payload it loads is GET /admin/hosts/{id}/detail',
  'GET /admin/skills/new':
    'admin SPA page — /admin/skills/{slug} is the registered route, and `new` is a client-side path',
  'GET /admin/account/password':
    'admin SPA page — served by the /admin/ static mount and its HTML fallback, not a route',
  'GET /admin/account/passkeys': 'admin SPA page — the passkey data comes from GET /admin/passkeys',
};

/**
 * Registered `METHOD /path` entries this document deliberately omits, and why.
 */
const UNDOCUMENTED_ROUTES: Record<string, string> = {
  'GET /admin/manual/manifest':
    'in-app admin manual served from STATIC_ROOT — UI asset plumbing, not part of the API contract',
  'GET /admin/manual/search':
    'in-app admin manual served from STATIC_ROOT — UI asset plumbing, not part of the API contract',
  'GET /admin/manual/article/:slug':
    'in-app admin manual served from STATIC_ROOT — UI asset plumbing, not part of the API contract',
};

/** A documented `{param}`/`:param` segment; must land on a registered `:param`. */
const PARAM = ':param';

interface DocEntry {
  /** Line in `docs/interface-api.md`. */
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
 * (`/admin/logs?limit=`) and optional-parameter brackets
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
  for (const [index, line] of readFileSync(INTERFACE_DOC, 'utf8').split('\n').entries()) {
    // Fenced blocks hold config/request samples, not endpoint bullets.
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

const routes = [
  ...new Map(collectRegisteredRoutes().map((route) => [`${route.method} ${route.path}`, route])).values(),
].sort((a, b) => `${a.method} ${a.path}`.localeCompare(`${b.method} ${b.path}`));
const entries = collectDocEntries();

function documents(route: { method: string; path: string }): boolean {
  return entries.some((entry) => entry.method === route.method && servedBy(entry.path, route.path));
}

describe('docs/interface-api.md endpoint inventory', () => {
  it('extracts the entries and routes it is meant to check', () => {
    // A scan that silently matches nothing would pass the assertions below.
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

  it('registers a route for every documented endpoint', () => {
    const missing = entries
      .filter(
        (entry) =>
          !(entry.text in UNREGISTERED_PATHS) &&
          !routes.some((route) => route.method === entry.method && servedBy(entry.path, route.path)),
      )
      .map((entry) => `docs/interface-api.md:${entry.line} documents ${entry.text}`);
    expect(
      missing,
      'register the route under api/src/routes, fix docs/interface-api.md, ' +
        'or record it in UNREGISTERED_PATHS here with a reason',
    ).toEqual([]);
  });

  it('documents every registered route', () => {
    const missing = routes
      .map((route) => `${route.method} ${route.path}`)
      .filter((route, index) => !documents(routes[index]!) && !(route in UNDOCUMENTED_ROUTES));
    expect(
      missing,
      'document the route in docs/interface-api.md as a `METHOD /path` code span, ' +
        'or record it in UNDOCUMENTED_ROUTES here with a reason',
    ).toEqual([]);
  });

  it('keeps the allowlists free of stale entries', () => {
    const staleUnregistered = Object.keys(UNREGISTERED_PATHS).filter(
      (text) =>
        !entries.some((entry) => entry.text === text) ||
        entries.some(
          (entry) =>
            entry.text === text &&
            routes.some((route) => route.method === entry.method && servedBy(entry.path, route.path)),
        ),
    );
    expect(staleUnregistered).toEqual([]);

    const staleUndocumented = Object.keys(UNDOCUMENTED_ROUTES).filter(
      (text) =>
        !routes.some((route) => `${route.method} ${route.path}` === text) ||
        documents(routes.find((route) => `${route.method} ${route.path}` === text)!),
    );
    expect(staleUndocumented).toEqual([]);

    for (const reason of [...Object.values(UNREGISTERED_PATHS), ...Object.values(UNDOCUMENTED_ROUTES)]) {
      expect(reason.trim()).not.toBe('');
      expect(reason).not.toContain('\n');
    }
  });
});
