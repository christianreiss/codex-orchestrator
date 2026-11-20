import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectRegisteredRoutes } from './registered-routes.js';

/**
 * `public/admin/manual/articles/shortcuts-api.md` used to carry a hundred-odd
 * `` | METHOD | `/path` | source file | `` rows, a hand-kept second copy of the
 * route list that drifted from the app. It is now a short operator page that
 * points at `docs/API.md` (the route catalogue, pinned by
 * `docs-api-catalog.test.ts`) and `docs/interface-api.md` (the spec).
 *
 * This keeps it that way: no route tables creeping back in, the pointers
 * intact, and any `` `METHOD /path` `` span the page still names registered.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '../../../..');
const ARTICLE = resolve(REPO, 'public/admin/manual/articles/shortcuts-api.md');

const article = readFileSync(ARTICLE, 'utf8');

/** A table row whose first cell is an HTTP verb (or a `GET/POST` pair). */
const ROUTE_TABLE_ROW =
  /^\|\s*(?:GET|POST|PUT|PATCH|DELETE|OPTIONS)(?:\/(?:GET|POST|PUT|PATCH|DELETE|OPTIONS))*\s*\|/;
const CODE_SPAN = /`([^`\n]+)`/g;
const ENTRY = /^(GET|POST|PUT|PATCH|DELETE|OPTIONS)\s+(\/\S*)$/;
const PLACEHOLDER = /\{[^}]*\}|:[A-Za-z_][A-Za-z0-9_]*/g;

function normalize(path: string): string {
  const query = path.search(/[?[]/);
  return (query === -1 ? path : path.slice(0, query)).replace(PLACEHOLDER, ':param');
}

/** `{openai|claude|grok}` stands for three routes; expand it before checking. */
function expand(path: string): string[] {
  const alternation = /\{([A-Za-z-]+(?:\|[A-Za-z-]+)+)\}/.exec(path);
  if (!alternation) return [path];
  return alternation[1]!.split('|').flatMap((name) => expand(path.replace(alternation[0], name)));
}

describe('manual shortcuts-api article', () => {
  it('carries no route tables; the route reference lives in docs/API.md', () => {
    const rows = article
      .split('\n')
      .map((line, index) => ({ line, number: index + 1 }))
      .filter(({ line }) => ROUTE_TABLE_ROW.test(line))
      .map(({ number }) => `shortcuts-api.md:${number}`);
    expect(rows, 'link docs/API.md instead of copying route rows into the article').toEqual([]);
  });

  it('points operators at the catalogue and the spec, and both exist', () => {
    for (const doc of ['docs/API.md', 'docs/interface-api.md']) {
      expect(article).toContain(`\`${doc}\``);
      expect(existsSync(resolve(REPO, doc))).toBe(true);
    }
  });

  it('names only registered routes in its inline `METHOD /path` spans', () => {
    const registered = new Set(
      collectRegisteredRoutes().map((route) => `${route.method} ${normalize(route.path)}`),
    );
    const unknown: string[] = [];
    for (const span of article.matchAll(CODE_SPAN)) {
      const entry = ENTRY.exec(span[1]!.trim());
      if (!entry) continue;
      for (const path of expand(entry[2]!)) {
        if (!registered.has(`${entry[1]} ${normalize(path)}`)) unknown.push(`${entry[1]} ${path}`);
      }
    }
    expect(unknown).toEqual([]);
  });
});
