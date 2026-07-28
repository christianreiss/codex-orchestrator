import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectRegisteredRoutes } from './registered-routes.js';

/**
 * `docs/LOGIN.md` presents three bullet lists — Admin API endpoints, Passkey
 * management endpoints, User management endpoints — as the whole admin login
 * surface, and an operator reads them as one. Nothing enforced that: the doc
 * never mentioned `POST /admin/auth/password/change`, so the reset-token flow
 * looked like the only way to change a password.
 *
 * This scan reads those lists both ways: every `METHOD /path` they claim has to
 * be registered under `api/src/routes`, and every registered route on the login
 * surface has to appear in one of them.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const DOC = resolve(HERE, '../../../../docs/LOGIN.md');

/** Path prefixes the three lists claim to cover in full. */
const LOGIN_SURFACE = ['/admin/auth/', '/admin/passkeys', '/admin/users'];

/**
 * Routes on those prefixes the lists deliberately omit, and why. These are the
 * canonical-auth routes: they sit under `/admin/auth/` but belong to the
 * auth-upload surface, not the login surface `docs/LOGIN.md` describes.
 */
const NOT_LOGIN_SURFACE: Record<string, string> = {
  'POST /admin/auth/seed-command':
    'canonical-auth seeding — registered by api/src/routes/admin/overview/index.ts, documented in docs/ADMIN.md',
  'POST /admin/auth/upload':
    'canonical-auth upload — registered by api/src/routes/admin/overview/index.ts, documented in docs/ADMIN.md',
};

/** A documented `{param}`/`:param` segment; must land on a registered `:param`. */
const PARAM = ':param';

interface DocEntry {
  /** Line in `docs/LOGIN.md`. */
  line: number;
  /** `METHOD /path` as written, for the failure message. */
  text: string;
  /** `METHOD /path` with params normalized, for the comparison. */
  key: string;
}

/** The parent bullet of an endpoint list. */
const LIST_INTRO = /^- .*\bendpoints\b.*:$/;
/** A list item's leading code span; trailing prose is the description. */
const ENTRY = /^\s+- `(GET|POST|PUT|PATCH|DELETE|OPTIONS) (\/\S*)`/;

const DOC_LINES = readFileSync(DOC, 'utf8').split('\n');

/** Turn `{param}` / `:param` segments into `PARAM`. */
function normalizePath(documented: string): string {
  return documented
    .split('/')
    .map((segment) => (/^(?:\{.*\}|:.+)$/.test(segment) ? PARAM : segment))
    .join('/');
}

function collectDocEntries(): DocEntry[] {
  const entries: DocEntry[] = [];
  let listed = false;
  for (const [index, line] of DOC_LINES.entries()) {
    if (LIST_INTRO.test(line)) {
      listed = true;
      continue;
    }
    if (!listed) continue;
    const entry = ENTRY.exec(line);
    // A list runs to the first line that is not one of its items; the endpoint
    // spans in the prose around it are references, not inventory claims.
    if (!entry) {
      listed = false;
      continue;
    }
    entries.push({
      line: index + 1,
      text: `${entry[1]} ${entry[2]}`,
      key: `${entry[1]} ${normalizePath(entry[2]!)}`,
    });
  }
  return entries;
}

/** Login-surface routes, keyed the way a doc entry is, valued as registered. */
function collectSurfaceRoutes(): Map<string, string> {
  const surface = new Map<string, string>();
  for (const route of collectRegisteredRoutes()) {
    if (!LOGIN_SURFACE.some((prefix) => route.path.startsWith(prefix))) continue;
    surface.set(`${route.method} ${normalizePath(route.path)}`, `${route.method} ${route.path}`);
  }
  return surface;
}

const entries = collectDocEntries();
const surface = collectSurfaceRoutes();
const claimed = new Set(entries.map((entry) => entry.key));

describe('docs/LOGIN.md admin-auth endpoint lists', () => {
  it('extracts the endpoint claims it is meant to check', () => {
    // A scan that silently matched nothing would pass the assertions below.
    expect(DOC_LINES.filter((line) => LIST_INTRO.test(line))).toHaveLength(3);
    expect(entries.length).toBeGreaterThanOrEqual(15);
    expect(surface.size).toBeGreaterThanOrEqual(15);
    expect(claimed.has('GET /admin/auth/status')).toBe(true);
    expect(claimed.has('POST /admin/auth/password/change')).toBe(true);
    // `{id}` segments normalize onto the registered `:id`.
    expect(claimed.has('DELETE /admin/passkeys/:param')).toBe(true);
    expect(claimed.has('POST /admin/users/:param')).toBe(true);
    // Only the lists count: the bootstrap and role-gate bullets name
    // `POST /admin/users` too, and those spans are not inventory.
    expect(entries.filter((entry) => entry.key === 'POST /admin/users')).toHaveLength(1);
  });

  it('registers a route for every listed endpoint', () => {
    const missing = entries
      .filter((entry) => !surface.has(entry.key))
      .map((entry) => `docs/LOGIN.md:${entry.line} lists ${entry.text}`);
    expect(
      missing,
      'register the route under api/src/routes or fix the endpoint lists in docs/LOGIN.md',
    ).toEqual([]);
  });

  it('lists every registered route on the login surface', () => {
    const undocumented = [...surface]
      .filter(([key]) => !claimed.has(key) && !(key in NOT_LOGIN_SURFACE))
      .map(([, text]) => `api/src/routes registers ${text}, and docs/LOGIN.md lists no such endpoint`);
    expect(
      undocumented,
      'add it to an endpoint list in docs/LOGIN.md, ' +
        'or record it in NOT_LOGIN_SURFACE here with a reason',
    ).toEqual([]);
  });

  it('keeps the allowlist free of stale entries', () => {
    const stale = Object.keys(NOT_LOGIN_SURFACE).filter((key) => !surface.has(key) || claimed.has(key));
    expect(stale, 'the route is gone, or docs/LOGIN.md now lists it and the entry is dead').toEqual([]);
    for (const reason of Object.values(NOT_LOGIN_SURFACE)) {
      expect(reason.trim()).not.toBe('');
      expect(reason).not.toContain('\n');
    }
  });
});
