import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectRegisteredRoutes } from './registered-routes.js';

/**
 * `public/admin/manual/articles/shortcuts-api.md` is the in-app API reference
 * the admin manual serves to operators: a hundred-odd
 * `` | METHOD | `/path` | source file | `` rows covering the admin, host-facing
 * and compat surfaces. Its frontmatter claims a verified date and nothing
 * enforced it, so routes added, renamed and moved since then left the shipped
 * article describing an app that no longer exists.
 *
 * This scan reads the tables' method/path cells and fails when an advertised
 * route has no registration in `api/src/routes`, the same way
 * `docs-api-catalog.test.ts` holds `docs/API.md` to the app.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const ARTICLE = resolve(HERE, '../../../../public/admin/manual/articles/shortcuts-api.md');

/** Article rows whose route `api/src/routes` deliberately does not register. */
const UNREGISTERED_PATHS: Record<string, string> = {
  'GET /admin/ws': 'websocket upgrade — registered by api/src/ws/server.ts, outside api/src/routes',
};

/** A documented `{param}`/`:param` segment; must land on a registered `:param`. */
const PARAM = ':param';

interface TableRow {
  /** Line in the article. */
  line: number;
  /** `METHOD /path` as written, for the failure message. */
  text: string;
  method: string;
  /** Path with query string dropped and params normalized to `:param`. */
  path: string;
}

/** A row's method cell: one verb, or the `GET/POST` pairs the article uses. */
const METHODS = /^(?:GET|POST|PUT|PATCH|DELETE|OPTIONS)(?:\/(?:GET|POST|PUT|PATCH|DELETE|OPTIONS))*$/;
/** The route cell's leading code span — trailing prose (`(alias of …)`) is not path. */
const ROUTE_SPAN = /^`(\/[^`\n]*)`/;

/**
 * Drop everything from the first `?`/`[` — documented query strings and
 * optional-parameter brackets (`/wrapper/v2/config[?sig=1]`) are not path
 * segments — and turn `{param}` / `:param` segments into `PARAM`.
 */
function normalizeDocPath(documented: string): string {
  const query = documented.search(/[?[]/);
  const path = query === -1 ? documented : documented.slice(0, query);
  return path
    .split('/')
    .map((segment) => (/^(?:\{.*\}|:.+)$/.test(segment) ? PARAM : segment))
    .join('/');
}

function collectTableRows(): TableRow[] {
  const rows: TableRow[] = [];
  for (const [index, line] of readFileSync(ARTICLE, 'utf8').split('\n').entries()) {
    if (!line.startsWith('|')) continue;
    const cells = line.split('|').slice(1, -1);
    if (cells.length < 2) continue;
    const methods = cells[0]!.trim();
    const route = ROUTE_SPAN.exec(cells[1]!.trim());
    if (!METHODS.test(methods) || !route) continue;
    for (const method of methods.split('/')) {
      rows.push({
        line: index + 1,
        text: `${method} ${route[1]}`,
        method,
        path: normalizeDocPath(route[1]!),
      });
    }
  }
  return rows;
}

const routes = collectRegisteredRoutes();
const rows = collectTableRows();

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

function registered(row: TableRow): boolean {
  return routes.some((route) => route.method === row.method && servedBy(row.path, route.path));
}

describe('manual shortcuts-api article route tables', () => {
  it('extracts the table rows it is meant to check', () => {
    // A scan that silently matches nothing would pass the assertion below.
    expect(rows.length).toBeGreaterThan(150);
    expect(routes.length).toBeGreaterThan(150);
    const documented = new Set(rows.map((row) => `${row.method} ${row.path}`));
    expect(documented.has('GET /admin/auth/status')).toBe(true);
    // `GET/POST` cells count as both verbs.
    expect(documented.has('GET /admin/theme')).toBe(true);
    expect(documented.has('POST /admin/theme')).toBe(true);
    // Params, optional-parameter brackets and trailing prose normalize away.
    expect(documented.has('DELETE /admin/passkeys/:param')).toBe(true);
    expect(documented.has('GET /wrapper/v2/config')).toBe(true);
    expect(documented.has('GET /wrapper')).toBe(true);
    // The keyboard-shortcut and prefix tables are not route tables.
    expect(documented.has('OpenAI-compat (Codex) sk-cdx-')).toBe(false);
  });

  it('registers a route for every row', () => {
    const missing = rows
      .filter((row) => !(row.text in UNREGISTERED_PATHS) && !registered(row))
      .map((row) => `shortcuts-api.md:${row.line} lists ${row.text}`);
    expect(
      missing,
      'register the route under api/src/routes, fix the article table, ' +
        'or record it in UNREGISTERED_PATHS here with a reason',
    ).toEqual([]);
  });

  it('keeps the allowlist free of stale entries', () => {
    const stale = Object.keys(UNREGISTERED_PATHS).filter(
      (text) =>
        !rows.some((row) => row.text === text) || rows.some((row) => row.text === text && registered(row)),
    );
    expect(stale).toEqual([]);
    for (const reason of Object.values(UNREGISTERED_PATHS)) {
      expect(reason.trim()).not.toBe('');
      expect(reason).not.toContain('\n');
    }
  });
});
