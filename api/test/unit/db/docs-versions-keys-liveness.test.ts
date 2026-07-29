import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * The `versions` bullet of `docs/interface-db.md` is the only catalog of what
 * the key/value store holds, and nothing pinned it. `docs-table-coverage`
 * compares table names, `docs-interface-db-column-liveness` skips this bullet
 * outright ("`versions` is a key/value store and its bullet enumerates the keys
 * its rows hold, not columns"), and `versions-doc-keys` pins the `GET /versions`
 * response fields in a different doc. So the bullet accumulated settings nobody
 * reads or writes — `daily_preflight`, `admin_ws_connections`, `runner_boot_id`,
 * `cdx_model` and six more survived the PHP rewrite in the doc alone.
 *
 * A key is live if its name occurs literally somewhere under `api/src`. That is
 * deliberately loose: the engine-scoped families are built as
 * `` `runner_state${suffix}` ``, so only the base name is ever written out, and
 * demanding a whole-key literal would reject names the code does use. It is a
 * one-way check — a key the code uses but the doc omits is out of scope, since
 * no regex over the source can tell a `versions` key from any other string.
 */

const DOC = resolve(import.meta.dirname, '../../../../docs/interface-db.md');
const SRC = resolve(import.meta.dirname, '../../../src');

/** The doc opens the bullet with the table name in bold, as every table does. */
const BULLET = '- **versions** —';
/** The sentence that carries the catalog; no key contains a `.`, so it ends at the first one. */
const KEYS_MARKER = 'Keys used in code:';
/**
 * A backticked key name. Underscores and hyphens are in (`log_retention_enabled`,
 * `github_release_codex-cli`); the `versions` DDL that precedes the marker is
 * never scanned, so its `updated_at` column cannot be read as a key.
 */
const KEY = /`([a-z][a-z0-9_-]*)`/g;

/**
 * Keys the bullet names on purpose that no longer appear in the source. Each
 * entry needs the reason it is still worth documenting; the answer to a failure
 * below is normally to delete the key from the doc, not to list it here.
 */
const NOT_IN_SOURCE = new Set<string>([]);

const documentedKeys = (): string[] => {
  const bullets = readFileSync(DOC, 'utf8')
    .split('\n')
    .filter((line) => line.startsWith(BULLET));
  expect(bullets).toHaveLength(1);
  const bullet = bullets[0]!;
  const marker = bullet.indexOf(KEYS_MARKER);
  if (marker < 0) throw new Error(`the versions bullet has no "${KEYS_MARKER}" key list`);
  const sentence = bullet.slice(marker + KEYS_MARKER.length);
  return [...sentence.slice(0, sentence.indexOf('.')).matchAll(KEY)].map((key) => key[1]!);
};

/** Every file under `api/src`, read as text — `.ts`, and the `.sql`/`.md` beside them. */
const sourceText = (): string => {
  const read = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const path = resolve(dir, entry.name);
      return entry.isDirectory() ? read(path) : [readFileSync(path, 'utf8')];
    });
  return read(SRC).join('\n');
};

describe('docs/interface-db.md versions keys', () => {
  it('names no key that occurs nowhere under api/src', () => {
    const source = sourceText();

    // Each entry is a setting the doc advertises that no code reads or writes.
    const dead = documentedKeys().filter(
      (key) => !source.includes(key) && !NOT_IN_SOURCE.has(key),
    );
    expect(dead).toEqual([]);
  });

  // Pins the extraction itself, so a regex that quietly stops matching cannot
  // turn the check above into a comparison of two empty lists.
  it('reads the key list out of the bullet and the source out of api/src', () => {
    const keys = documentedKeys();

    // A plain key, a hyphenated one, and a family whose members are suffixed.
    expect(keys).toContain('api_disabled');
    expect(keys).toContain('github_release_codex-cli');
    expect(keys).toContain('runner_state');
    expect(keys.length).toBeGreaterThan(20);
    // The bullet's own DDL sits before the marker and contributes no key.
    expect(keys).not.toContain('updated_at');

    // A key the source really does spell out, and one it never has.
    const source = sourceText();
    expect(source).toContain('projects_module_enabled');
    expect(source).not.toContain('admin_ws_connections');
  });
});
