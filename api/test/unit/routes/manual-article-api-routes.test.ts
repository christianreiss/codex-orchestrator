import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectRegisteredRoutes } from './registered-routes.js';

/**
 * `manual-shortcuts-api-routes.test.ts` holds the manual's API reference to the
 * app, but the reference article is not the only place the manual names
 * endpoints: the other articles carry the same claims inline as
 * `` `METHOD /path` `` code spans — `settings.md` alone names some forty of
 * them — and a route rename left those spans describing an app that no longer
 * exists, with nothing to catch it.
 *
 * This scan reads the inline spans out of every shipped article and fails when
 * an advertised route has no registration in `api/src/routes`. Fenced code
 * blocks carry the same claims as bare `METHOD /path` lines — `clx.md` shipped
 * a binary-download path keyed by the binary name instead of the engine token,
 * which the route 404s — so those lines are read too.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const ARTICLES = resolve(HERE, '../../../../public/admin/manual/articles');

/**
 * The shipped articles, minus `shortcuts-api.md` — its tables are the API
 * reference and `manual-shortcuts-api-routes.test.ts` already checks them —
 * and minus `mcp.md`, which documents MCP tools rather than HTTP routes.
 */
const ARTICLE_FILES = [
  'admin-login.md',
  'architecture.md',
  'auth-pipeline.md',
  'clx.md',
  'dashboard.md',
  'hosts.md',
  'install.md',
  'logs.md',
  'passkeys.md',
  'projects.md',
  'roles.md',
  'settings.md',
  'welcome.md',
  'wrappers.md',
];

/** Article spans whose endpoint `api/src/routes` deliberately does not serve. */
const UNREGISTERED_PATHS: Record<string, string> = {
  'POST /verify': 'runner sidecar endpoint — served by runner/app.py, not the API',
  'POST /verify-claude': 'runner sidecar endpoint — served by runner/app.py, not the API',
  'POST /projects/assist': 'runner sidecar endpoint — served by runner/app.py, not the API',
};

/** A documented `{param}`/`:param`/`<param>` segment; must land on a registered `:param`. */
const PARAM = ':param';

interface Span {
  /** Article file the span was read from. */
  file: string;
  /** Line in the article. */
  line: number;
  /** `METHOD /path` as written, for the failure message. */
  text: string;
  method: string;
  /** Path with query string dropped and params normalized to `:param`. */
  path: string;
}

/** An inline `` `METHOD /path` `` span: one verb, or a `GET/POST` pair. */
const ROUTE_SPAN =
  /`((?:GET|POST|PUT|PATCH|DELETE|OPTIONS)(?:\/(?:GET|POST|PUT|PATCH|DELETE|OPTIONS))*) (\/[^`\n]*)`/g;

/** A `METHOD /path` line inside a fenced code block; trailing prose is ignored. */
const FENCED_SPAN = /^(GET|POST|PUT|PATCH|DELETE|OPTIONS) (\/\S*)/;

/**
 * A documented param segment: `{param}`, `:param`, or one carrying a `<...>`
 * placeholder (`<os>-<arch>`, `v<version>`).
 */
const DOC_PARAM = /^(?:\{.*\}|:.+)$|<[^>]*>/;

/**
 * Drop everything from the first `?`/`[` — documented query strings and
 * optional-parameter brackets (`/wrapper/v2/config[?sig=1]`) are not path
 * segments — and turn param segments into `PARAM`.
 */
function normalizeDocPath(documented: string): string {
  const query = documented.search(/[?[]/);
  const path = query === -1 ? documented : documented.slice(0, query);
  return path
    .split('/')
    .map((segment) => (DOC_PARAM.test(segment) ? PARAM : segment))
    .join('/');
}

function collectSpans(file: string, article: string): Span[] {
  const spans: Span[] = [];
  for (const [index, line] of article.split('\n').entries()) {
    for (const span of line.matchAll(ROUTE_SPAN)) {
      for (const method of span[1]!.split('/')) {
        spans.push({
          file,
          line: index + 1,
          text: `${method} ${span[2]}`,
          method,
          path: normalizeDocPath(span[2]!),
        });
      }
    }
  }
  return spans;
}

/** Bare `METHOD /path` lines inside the article's ```-fenced blocks. */
function collectFencedSpans(file: string, article: string): Span[] {
  const spans: Span[] = [];
  let fenced = false;
  for (const [index, line] of article.split('\n').entries()) {
    if (line.trimStart().startsWith('```')) {
      fenced = !fenced;
      continue;
    }
    const span = fenced ? FENCED_SPAN.exec(line.trim()) : null;
    if (!span) continue;
    spans.push({
      file,
      line: index + 1,
      text: `${span[1]} ${span[2]}`,
      method: span[1]!,
      path: normalizeDocPath(span[2]!),
    });
  }
  return spans;
}

const routes = collectRegisteredRoutes();
const articles = ARTICLE_FILES.map((file) => ({
  file,
  text: readFileSync(resolve(ARTICLES, file), 'utf8'),
}));
const fencedSpans = articles.flatMap(({ file, text }) => collectFencedSpans(file, text));
const spans = [...articles.flatMap(({ file, text }) => collectSpans(file, text)), ...fencedSpans];

/**
 * True when `route` serves `documented`: a parameterized registered segment
 * (`:engine`, or a partial one like `v:version`) serves any documented
 * segment, a documented param segment needs one of those rather than a
 * literal, and a registered trailing `*` (the binary and CORS preflight
 * routes) serves everything below it.
 */
function servedBy(documented: string, route: string): boolean {
  if (route.endsWith('*')) return documented.startsWith(route.slice(0, -1));
  const path = documented.split('/');
  const registered = route.split('/');
  if (path.length !== registered.length) return false;
  return path.every(
    (segment, index) => registered[index]!.includes(':') || segment === registered[index],
  );
}

function registered(span: Span): boolean {
  return routes.some((route) => route.method === span.method && servedBy(span.path, route.path));
}

describe('manual article endpoint spans', () => {
  it('extracts the spans it is meant to check', () => {
    // A scan that silently matched nothing would pass the assertion below.
    expect(spans.length).toBeGreaterThan(200);
    expect(routes.length).toBeGreaterThan(150);
    const documented = new Set(spans.map((span) => `${span.method} ${span.path}`));
    expect(documented.has('GET /admin/api/state')).toBe(true);
    expect(documented.has('DELETE /admin/hosts/:param')).toBe(true);
    // Params, query strings and optional-parameter brackets normalize away.
    expect(documented.has('GET /admin/projects/:param/notes')).toBe(true);
    expect(documented.has('GET /admin/logs')).toBe(true);
    expect(documented.has('GET /wrapper/v2/config')).toBe(true);
    // Every listed article contributes; a renamed file cannot silently drop out.
    for (const file of ARTICLE_FILES) {
      expect(spans.some((span) => span.file === file), `${file} has no endpoint spans`).toBe(true);
    }
    // A `GET/POST` cell counts as both verbs.
    const pair = collectSpans('pair.md', 'reads `GET/POST /admin/theme` today');
    expect(pair.map((span) => span.text)).toEqual(['GET /admin/theme', 'POST /admin/theme']);
  });

  it('extracts the fenced spans too', () => {
    // A fence scan that silently matched nothing would be free to pass.
    expect(fencedSpans.length).toBeGreaterThan(0);
    // clx.md's download path is keyed by the engine token, not by `clx`.
    expect(fencedSpans.map((span) => `${span.method} ${span.path}`)).toContain(
      'GET /wrapper/v2/bin/claude/:param/:param/clx',
    );
    // Only fenced lines count, and the `METHOD /path` has to open the line.
    const fenced = collectFencedSpans(
      'fence.md',
      '```\nGET /admin/theme\nsee POST /admin/theme\n```\nGET /admin/logs\n',
    );
    expect(fenced.map((span) => `${span.file}:${span.line} ${span.text}`)).toEqual([
      'fence.md:2 GET /admin/theme',
    ]);
  });

  it('registers a route for every span', () => {
    const missing = spans
      .filter((span) => !(span.text in UNREGISTERED_PATHS) && !registered(span))
      .map((span) => `${span.file}:${span.line} names ${span.text}`);
    expect(
      missing,
      'register the route under api/src/routes, fix the article, ' +
        'or record it in UNREGISTERED_PATHS here with a reason',
    ).toEqual([]);
  });

  it('keeps the allowlist free of stale entries', () => {
    const stale = Object.keys(UNREGISTERED_PATHS).filter(
      (text) =>
        !spans.some((span) => span.text === text) ||
        spans.some((span) => span.text === text && registered(span)),
    );
    expect(stale).toEqual([]);
    for (const reason of Object.values(UNREGISTERED_PATHS)) {
      expect(reason.trim()).not.toBe('');
      expect(reason).not.toContain('\n');
    }
  });
});
