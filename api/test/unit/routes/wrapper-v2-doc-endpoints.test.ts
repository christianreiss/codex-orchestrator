import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectRegisteredRoutes } from './registered-routes.js';

/**
 * The Endpoints table in `docs/wrapper-v2-architecture.md` is what an operator
 * debugging a stalled rollout reads, and it drifted: it named
 * `/wrapper/v2/download` as the transition-launcher path that `/wrapper/download`
 * actually serves. The `docs/API.md` catalog scan does not read this doc, so
 * nothing caught it.
 *
 * This scan reads the table's `METHOD | path` rows and fails when a documented
 * row has no matching registration in `api/src/routes`.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const DOC = resolve(HERE, '../../../../docs/wrapper-v2-architecture.md');

/**
 * Stands in for a documented `{param}`/`:param` placeholder, including one that
 * is only part of a segment (`v{ver}`, `{os}-{arch}`). Registered literals never
 * contain braces, so a placeholder can only ever resolve against a `:param`.
 */
const PARAM = '{}';

interface DocRow {
  /** Line in `docs/wrapper-v2-architecture.md`. */
  line: number;
  /** `METHOD /path` as written, for the failure message. */
  text: string;
  method: string;
  /** Path with any optional-parameter tail dropped and placeholders as `PARAM`. */
  path: string;
}

const ROW = /^\|\s*(GET|POST|PUT|PATCH|DELETE|OPTIONS)\s*\|\s*`([^`\n]+)`\s*\|/;

/**
 * Drop everything from the first `?`/`[` — a documented query string or
 * optional-parameter bracket (`/wrapper/v2/config[?sig=1]`) is not a path
 * segment — and turn `{param}` / `:param` placeholders into `PARAM`.
 */
function normalizeDocPath(documented: string): string {
  const tail = documented.search(/[?[]/);
  const path = tail === -1 ? documented : documented.slice(0, tail);
  return path.replace(/\{[^}]*\}|:\w+/g, PARAM);
}

function collectDocRows(): DocRow[] {
  const rows: DocRow[] = [];
  let endpoints = false;
  for (const [index, line] of readFileSync(DOC, 'utf8').split('\n').entries()) {
    // Only the Endpoints table; the other tables in the doc are prose.
    if (line.startsWith('## ')) endpoints = line.trim() === '## Endpoints';
    if (!endpoints) continue;
    const row = ROW.exec(line);
    if (!row) continue;
    rows.push({
      line: index + 1,
      text: `${row[1]} ${row[2]}`,
      method: row[1]!,
      path: normalizeDocPath(row[2]!),
    });
  }
  return rows;
}

/** `route` as a matcher: a `:param` takes one segment, a trailing `*` the rest. */
function matcher(route: string): RegExp {
  const pattern = route
    .split('/')
    .map((segment) =>
      segment === '*'
        ? '.*'
        : segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/:\w+/g, '[^/]+'),
    )
    .join('/');
  return new RegExp(`^${pattern}$`);
}

const registered = collectRegisteredRoutes().map((route) => ({
  method: route.method,
  matcher: matcher(route.path),
}));
const rows = collectDocRows();

function resolves(row: DocRow): boolean {
  return registered.some((route) => route.method === row.method && route.matcher.test(row.path));
}

describe('docs/wrapper-v2-architecture.md endpoint table', () => {
  it('parses and resolves the rows it is meant to check', () => {
    // A scan that silently matched nothing would pass the assertion below.
    expect(rows.length).toBeGreaterThanOrEqual(8);
    for (const text of ['GET /wrapper/v2/download', `POST /seed/v2/auth/${PARAM}`]) {
      const row = rows.find((candidate) => `${candidate.method} ${candidate.path}` === text);
      expect(row, `${text} is not parsed out of the Endpoints table`).toBeDefined();
      expect(resolves(row!), `${text} is parsed but resolves to no route`).toBe(true);
    }
  });

  it('registers a route for every documented row', () => {
    const missing = rows
      .filter((row) => !resolves(row))
      .map((row) => `docs/wrapper-v2-architecture.md:${row.line} documents ${row.text}`);
    expect(
      missing,
      'register the route under api/src/routes or fix the Endpoints table',
    ).toEqual([]);
  });
});
