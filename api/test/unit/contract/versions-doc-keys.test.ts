import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * `GET /versions` returns `VersionSnapshot` verbatim, and `docs/interface-api.md`
 * calls itself the source of truth for it — but the key list there is a hand-kept
 * copy with no link to the interface. It drifted a whole rewrite behind: the doc
 * still listed the PHP-era keys (`client_version_source`, `quota_*`, `admin_theme`,
 * `runner_last_*`) that `version-snapshot.ts` never declares.
 *
 * Both sides are read as text so a renamed, added or dropped field fails the API
 * suite instead of aging silently in the doc.
 */

const DOC = resolve(import.meta.dirname, '../../../../docs/interface-api.md');
const SERVICE = resolve(import.meta.dirname, '../../../src/services/version-snapshot.ts');

const INTERFACE = 'export interface VersionSnapshot {';
/** The doc sentence that carries the key list; no key contains a `.`, so it ends at the first one. */
const KEYS_MARKER = 'Keys:';

/** Properties of the interface body, which ends at the first `}` in column 0. */
const interfaceKeys = (): string[] => {
  const source = readFileSync(SERVICE, 'utf8');
  const start = source.indexOf(INTERFACE);
  if (start < 0) throw new Error(`${INTERFACE} not found in version-snapshot.ts`);
  const body = source.slice(start + INTERFACE.length, source.indexOf('\n}', start));
  return [...body.matchAll(/^\s+([A-Za-z0-9_]+)\??:/gm)].map((property) => property[1]!);
};

/** Backticked names in the `Keys:` sentence of the `GET /versions` bullet. */
const documentedKeys = (): string[] => {
  const bullets = readFileSync(DOC, 'utf8')
    .split('\n')
    .filter((line) => line.startsWith('- `GET /versions`'));
  expect(bullets).toHaveLength(1);
  const bullet = bullets[0]!;
  const marker = bullet.indexOf(KEYS_MARKER);
  if (marker < 0) throw new Error(`the GET /versions bullet has no "${KEYS_MARKER}" key list`);
  const sentence = bullet.slice(marker + KEYS_MARKER.length);
  return [...sentence.slice(0, sentence.indexOf('.')).matchAll(/`([A-Za-z0-9_]+)`/g)].map((key) => key[1]!);
};

describe('docs/interface-api.md GET /versions', () => {
  it('lists exactly the VersionSnapshot keys the API serves', () => {
    const keys = interfaceKeys();
    expect(keys).toContain('client_version');
    expect(documentedKeys()).toEqual(keys);
  });
});
