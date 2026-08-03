import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { collectRegisteredRoutes } from '../routes/registered-routes.js';
import { INSTALL_TOKEN_TTL_SECONDS_DEFAULT } from '../../../src/services/host-management.js';

/**
 * `docs/USAGE.md` is the day-2 operator guide: it hands out the installer
 * commands, the admin-API calls behind them, and the endpoints `cdx` uses at
 * runtime. Nothing checked any of it, and the wrapper-update section drifted —
 * it credited self-update to `/wrapper/download`, which serves the legacy
 * transition launcher, long after `docs/wrapper-v2-architecture.md` had that
 * corrected.
 *
 * This scan reads every backticked path in the doc — inline code spans and the
 * fenced command blocks, since the installer/admin examples only appear as
 * shell commands — and fails when one has no registration in `api/src/routes`.
 * It also pins the two hard claims the prose makes about the API: which route
 * the wrapper self-updates from, and the installer-token TTL.
 */

const ROOT = resolve(import.meta.dirname, '../../../..');
const USAGE_DOC = resolve(ROOT, 'docs/USAGE.md');

/** A documented `{id}` / `<token>` / `$HOST_ID` segment. */
const PARAM = ':param';

/**
 * Paths the doc names on purpose that no Fastify route serves, and what serves
 * them instead. The stale check below drops the excuse once the doc does.
 */
const UNREGISTERED_PATHS: Record<string, string> = {
  '/admin': 'admin SPA — served by the /admin/ static mount and its HTML fallback, not a route',
  // `/admin*` used to be here for the caddy profile's client-certificate rule.
  // That rule is gone — the proxy now has one handler for every path — so the
  // doc no longer names the pattern and the exemption went with it.
  '/usr/local/bin': "the installer's default BIN_DIR on the host, not an HTTP path",
};

interface DocPath {
  /** Line in `docs/USAGE.md`. */
  line: number;
  /** The path as written, for the failure message. */
  text: string;
  /** `GET`…`DELETE` when the doc spells one out right before the path. */
  method: string | null;
  /** Path with query string dropped and params normalized to `PARAM`. */
  path: string;
}

const CODE_SPAN = /`([^`\n]+)`/g;
const METHOD = /^(GET|POST|PUT|PATCH|DELETE|OPTIONS)$/;

/**
 * The origins the examples put in front of a path: a real URL, the `$BASE_URL`
 * the admin-API snippets export, or the elided host in `curl …/install/…`.
 */
const ORIGIN = /^(?:[a-z][a-z0-9+.-]*:\/\/[^/\s]*|\$BASE_URL|…)/;

/** `{id}`, `<token>` and `$HOST_ID`, anywhere in a segment (`v{version}`). */
const DOC_PARAM = /\{[^}]*\}|<[^>]*>|\$[A-Za-z_][A-Za-z0-9_]*/g;
/** `:id`, likewise anywhere in a registered segment (`v:version`). */
const ROUTE_PARAM = /:[A-Za-z0-9_]+/g;

/**
 * The path a shell/prose word points at, or null when it is not one. Anything
 * that does not start with `/` once an origin is stripped is a host file
 * (`${CODEX_HOME:-~/.codex}/auth.json`, `$HOME/.local/bin`) or a non-HTTP URI
 * (`skill://{slug}`), and the doc has plenty of both.
 */
function candidatePath(word: string): string | null {
  const bare = word.replace(/^["'`(]+/, '').replace(/["'`).,;:|\\]+$/, '');
  const path = bare.replace(ORIGIN, '');
  if (!path.startsWith('/')) return null;
  const withoutQuery = path.split('?')[0]!;
  const trimmed = withoutQuery.replace(/(.)\/$/, '$1');
  return trimmed
    .split('/')
    .map((segment) => segment.replace(DOC_PARAM, PARAM))
    .join('/');
}

function collectDocPaths(): DocPath[] {
  const paths: DocPath[] = [];
  let fenced = false;
  for (const [index, line] of readFileSync(USAGE_DOC, 'utf8').split('\n').entries()) {
    if (line.trimStart().startsWith('```')) {
      fenced = !fenced;
      continue;
    }
    // Inside a fence the whole line is code; outside it, only the code spans.
    const code = fenced ? [line] : [...line.matchAll(CODE_SPAN)].map((span) => span[1]!);
    for (const text of code) {
      const words = text.split(/\s+/);
      for (const [position, word] of words.entries()) {
        const path = candidatePath(word);
        if (path === null) continue;
        const previous = words[position - 1] ?? '';
        paths.push({
          line: index + 1,
          text: word,
          method: METHOD.test(previous) ? previous : null,
          path,
        });
      }
    }
  }
  return paths;
}

const routes = collectRegisteredRoutes();
const documented = collectDocPaths();
const usage = readFileSync(USAGE_DOC, 'utf8');

/**
 * True when `route` serves `path`: a registered `:param` segment takes any
 * documented segment, a documented `PARAM` needs a registered param in the
 * same place, and a registered trailing `*` serves everything below it.
 */
function servedBy(path: string, route: string): boolean {
  if (route.endsWith('*')) return path.startsWith(route.slice(0, -1));
  const segments = path.split('/');
  const registered = route.split('/');
  if (segments.length !== registered.length) return false;
  return segments.every((segment, index) => {
    const known = registered[index]!.replace(ROUTE_PARAM, PARAM);
    return known === PARAM || known === segment;
  });
}

function isServed(entry: DocPath): boolean {
  return routes.some(
    (route) =>
      (entry.method === null || route.method === entry.method) && servedBy(entry.path, route.path),
  );
}

describe('docs/USAGE.md endpoint reference', () => {
  it('extracts the paths it is meant to check', () => {
    // A scan that silently matches nothing would pass the assertions below.
    expect(routes.length).toBeGreaterThan(150);
    const paths = new Set(documented.map((entry) => entry.path));
    expect(paths.size).toBeGreaterThan(10);
    for (const path of [
      '/auth',
      '/sync/status',
      '/sync/bootstrap',
      '/config/retrieve',
      '/agents/retrieve',
      '/wrapper/v2/config',
      '/wrapper/v2/download',
      '/admin/hosts/register',
      '/admin/api/state',
      '/cli/auth/verify',
    ]) {
      expect(paths, `docs/USAGE.md should still name ${path}`).toContain(path);
    }
    // Params, shell variables and query strings normalize away.
    expect(paths).toContain('/install/:param'); // `…/install/<token>`
    expect(paths).toContain('/admin/hosts/:param/installer'); // `$BASE_URL/…/$HOST_ID/…`
    expect(paths).toContain('/wrapper/v2/bin/:param/:param/v:param/:param');
    expect(documented.some((entry) => entry.method === 'DELETE' && entry.path === '/auth')).toBe(
      true,
    ); // `DELETE /auth?force=1&engine=codex`
    // Host files and non-HTTP URIs are not paths this check can resolve.
    expect(paths).not.toContain('/auth.json');
    expect(paths).not.toContain('/skills');
  });

  it('registers a route for every documented path', () => {
    const missing = documented
      .filter((entry) => !(entry.path in UNREGISTERED_PATHS) && !isServed(entry))
      .map((entry) => `docs/USAGE.md:${entry.line} names ${entry.text}`);
    expect(
      missing,
      'register the route under api/src/routes, fix docs/USAGE.md, ' +
        'or record it in UNREGISTERED_PATHS here with a reason',
    ).toEqual([]);
  });

  it('keeps the allowlist free of stale entries', () => {
    const stale = Object.keys(UNREGISTERED_PATHS).filter((path) =>
      documented.every((entry) => entry.path !== path || isServed(entry)),
    );
    expect(stale).toEqual([]);
    for (const reason of Object.values(UNREGISTERED_PATHS)) {
      expect(reason.trim()).not.toBe('');
      expect(reason).not.toContain('\n');
    }
  });

  it('credits wrapper self-update to the v2 binary, not the legacy launcher', () => {
    const paragraphs = usage.split(/\n\s*\n/);
    const update = paragraphs.filter((paragraph) => paragraph.includes('`/wrapper/v2/download`'));
    expect(update.length).toBeGreaterThan(0);
    expect(update.some((paragraph) => paragraph.includes('auto-updates'))).toBe(true);

    // `/wrapper/download` serves the transition launcher date-versioned shell
    // wrappers update through; the Go wrappers never self-update from it.
    for (const paragraph of paragraphs.filter((p) => /`\/wrapper\/download`/.test(p))) {
      expect(paragraph, 'name /wrapper/download only as the legacy launcher').toMatch(/legacy/);
    }
  });

  it('states the installer-token TTL the API enforces', () => {
    const claim = /TTL fixed at (\d+) seconds/.exec(usage);
    expect(claim, 'docs/USAGE.md should state the installer-token TTL').not.toBeNull();
    expect(Number(claim![1])).toBe(INSTALL_TOKEN_TTL_SECONDS_DEFAULT);
  });
});
