import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * The `/admin/overview` handler returns one `ok({...})` literal, and both docs
 * plus the dashboard's `OverviewResponse` describe it by hand. All three drifted
 * onto keys the literal never produced (`has_canonical_auth`, `seed_required`,
 * `seed_reasons`, `tokens_day`/`tokens_week`/`tokens_month`), so the client type
 * invited reads that are always `undefined`. The route's path is covered
 * elsewhere; only the key list is checked here.
 *
 * All sides are read as text so a renamed or dropped payload key fails the API
 * suite instead of aging silently in a doc bullet or a client interface.
 */

const ROUTE = resolve(import.meta.dirname, '../../../src/routes/admin/overview/index.ts');
const CLIENT = resolve(import.meta.dirname, '../../../../frontend/src/lib/api/overview.ts');
const DOCS: Record<string, string> = {
  'docs/interface-api.md': resolve(import.meta.dirname, '../../../../docs/interface-api.md'),
  'docs/API.md': resolve(import.meta.dirname, '../../../../docs/API.md'),
};

/** Names a doc bullet or `OverviewResponse` may carry even though the literal cannot produce them. */
const ALLOWED: readonly string[] = [];

const ROUTE_ANCHOR = "app.get('/admin/overview'";
const BULLET = '- `GET /admin/overview`';
const INTERFACE = 'export interface OverviewResponse {';

/**
 * Top-level properties of the `ok({...})` literal the handler returns. Characters
 * nested deeper than the literal are dropped (newlines are kept) so that keys like
 * `versions.claude_version` never read as top-level ones.
 */
const emittedKeys = (): string[] => {
  const source = readFileSync(ROUTE, 'utf8');
  const anchor = source.indexOf(ROUTE_ANCHOR);
  if (anchor < 0) throw new Error(`${ROUTE_ANCHOR} not found in admin/overview/index.ts`);
  const open = source.indexOf('{', source.indexOf('return ok(', anchor));
  let depth = 0;
  let top = '';
  for (let i = open; i < source.length; i++) {
    const char = source[i]!;
    if (char === '{') depth++;
    else if (char === '}') {
      depth--;
      if (depth === 0) break;
    } else if (depth === 1 || char === '\n') top += char;
  }
  return [...top.matchAll(/^\s+([A-Za-z0-9_]+)\s*:/gm)].map((property) => property[1]!);
};

/** Backticked names in the `/admin/overview` bullet of a doc. */
const documentedKeys = (path: string): string[] => {
  const bullets = readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.startsWith(BULLET));
  expect(bullets).toHaveLength(1);
  const sentence = bullets[0]!.slice(BULLET.length);
  return [...sentence.matchAll(/`([A-Za-z0-9_]+)`/g)].map((key) => key[1]!);
};

/** Declared fields of `OverviewResponse`; the `[key: string]` index signature never matches. */
const clientKeys = (): string[] => {
  const source = readFileSync(CLIENT, 'utf8');
  const start = source.indexOf(INTERFACE);
  if (start < 0) throw new Error(`${INTERFACE} not found in frontend overview.ts`);
  const body = source.slice(start + INTERFACE.length, source.indexOf('\n}', start));
  return [...body.matchAll(/^\s+([A-Za-z0-9_]+)\??:/gm)].map((property) => property[1]!);
};

const emitted = emittedKeys();
const unproducible = (keys: string[]): string[] =>
  keys.filter((key) => !emitted.includes(key) && !ALLOWED.includes(key));

describe('/admin/overview payload keys', () => {
  it('reads the top-level keys of the handler literal', () => {
    expect(emitted).toContain('totals');
    expect(emitted).toContain('versions');
    expect(emitted).not.toContain('claude_version');
  });

  for (const [label, path] of Object.entries(DOCS)) {
    it(`${label} names only keys the handler emits`, () => {
      expect(unproducible(documentedKeys(path))).toEqual([]);
    });
  }

  it('OverviewResponse declares only keys the handler emits', () => {
    expect(unproducible(clientKeys())).toEqual([]);
  });
});
