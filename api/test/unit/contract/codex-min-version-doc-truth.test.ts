import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { CODEX_MIN_CLIENT_VERSION } from '../../../src/services/client-versions.js';

/**
 * `CODEX_MIN_CLIENT_VERSION` is the only Codex CLI floor the server enforces —
 * `coerceCodexVersionToMinimum` raises fleet pins, host overrides and stale
 * release lookups to it. Three operator-facing docs quote that number as prose,
 * hand-copied, with nothing tying the copies to the constant. The floor has
 * already been raised once (0.114.0 -> 0.125.0), and the next bump would leave
 * the docs telling operators about a floor the server no longer applies.
 *
 * So every sentence that states the floor is read back out of the docs and
 * compared to the constant, reported as `file:line`. Zero matches in a doc is a
 * failure too: a reworded claim must fail the suite rather than quietly leave
 * the doc unguarded.
 */

const ROOT = resolve(import.meta.dirname, '../../../..');

/** Sentence shapes that state the floor, each capturing the quoted version. */
const CLAIMS = [
  /internal minimum floor of `([^`]+)`/g, // "an internal minimum floor of `x`"
  /internal minimum `([^`]+)`/g, // "below the internal minimum `x`"
  /coerced upward to `([^`]+)`/g, // "... are coerced upward to `x`"
  /hosts need Codex `([^`]+)\+`/g, // docs/CONFIG_BUILDER.md's `memories` bullet
];

/** Each doc and the number of floor claims it makes today; a dropped one fails. */
const DOCS = [
  { path: 'docs/interface-api.md', claims: 6 },
  { path: 'docs/OVERVIEW.md', claims: 1 },
  { path: 'docs/CONFIG_BUILDER.md', claims: 1 },
] as const;

/** The constant, guarded: a rename or a reshaped value must fail loudly here. */
const enforcedFloor = (): string => {
  if (!/^\d+\.\d+\.\d+$/.test(CODEX_MIN_CLIENT_VERSION)) {
    throw new Error(`CODEX_MIN_CLIENT_VERSION is not a version: ${CODEX_MIN_CLIENT_VERSION}`);
  }
  return CODEX_MIN_CLIENT_VERSION;
};

/** Every version a doc quotes as the Codex floor, in document order. */
const quotedFloors = (path: string): { version: string; where: string }[] => {
  const source = readFileSync(resolve(ROOT, path), 'utf8');
  const found = CLAIMS.flatMap((pattern) =>
    [...source.matchAll(pattern)].map((claim) => ({
      version: claim[1]!,
      at: claim.index,
      where: `${path}:${source.slice(0, claim.index).split('\n').length}`,
    })),
  );
  if (found.length === 0) throw new Error(`${path} states no Codex minimum version`);
  return found.sort((a, b) => a.at - b.at).map(({ version, where }) => ({ version, where }));
};

describe('documented Codex minimum client version', () => {
  for (const doc of DOCS) {
    it(`${doc.path} quotes the enforced floor`, () => {
      const floors = quotedFloors(doc.path);
      // A claim the patterns above no longer match is a claim nothing compares,
      // so the count the doc makes today is the floor for the extraction itself.
      expect(floors.length).toBeGreaterThanOrEqual(doc.claims);

      const stale = floors
        .filter((floor) => floor.version !== enforcedFloor())
        .map((floor) => `${floor.where} says ${floor.version}`);

      // Each entry is prose promising a floor `coerceCodexVersionToMinimum` does
      // not enforce: update the doc to CODEX_MIN_CLIENT_VERSION.
      expect(stale).toEqual([]);
    });
  }
});
