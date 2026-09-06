import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  RESPONSE_VERBOSITY_OUTPUT_STYLE_NAMES,
  RESPONSE_VERBOSITY_OUTPUT_STYLE_SLUGS,
} from '../../../src/services/agent-response-style.js';

/**
 * `outputStyle` in settings.json is matched against Claude Code's output-style
 * registry, and that registry is keyed by each artifact's frontmatter `name`,
 * not by its slug. From the claude-cli 2.1.263 loader:
 *
 *   let D = ass(d).replace(/\.md$/, ""),                     // filename slug
 *       N = (f.name != null ? String(f.name) : void 0) || D  // frontmatter name wins
 *   ... d[D.name] = { ... }                                  // registry keyed by N
 *
 * and the lookup is an exact, unnormalised index:
 *
 *   let d = Sn()?.outputStyle || cw; return e[d] ?? null
 *
 * The key is a free-form string upstream, so writing the slug produced no error
 * anywhere — it simply resolved to null and applied no style. Nothing in the
 * repo tied the emitted value to the seeded artifacts, which is how it drifted.
 *
 * So the names are read back out of migration 0023 (the seed that creates these
 * artifacts) and compared. A migration that renames a style, or a level added to
 * one map and not the other, fails here instead of shipping a dead setting.
 */

const MIGRATION = 'api/src/db/migrations/0023_seed_response_verbosity_output_styles.sql';
const sql = readFileSync(resolve(import.meta.dirname, '../../../..', MIGRATION), 'utf8');

/** Frontmatter `name:` values declared in the seed, in file order. */
const seededNames = (): string[] => [
  ...new Set([...sql.matchAll(/^name:\s*(.+)$/gm)].map((m) => m[1]!.trim())),
];

describe('response-verbosity outputStyle parity', () => {
  it('reads the seed it is meant to compare against', () => {
    // A renamed/moved migration would otherwise pass every assertion vacuously.
    expect(seededNames().length).toBeGreaterThanOrEqual(4);
    expect(seededNames()).toContain('Verbosity Minimal');
  });

  it('emits frontmatter names, never slugs', () => {
    const names = Object.values(RESPONSE_VERBOSITY_OUTPUT_STYLE_NAMES);
    const slugs = Object.values(RESPONSE_VERBOSITY_OUTPUT_STYLE_SLUGS);
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) {
      expect(
        slugs,
        `outputStyle "${name}" is a slug; Claude Code resolves the frontmatter name`,
      ).not.toContain(name);
    }
  });

  it('emits exactly the names migration 0023 seeds', () => {
    const seeded = seededNames().sort();
    const emitted = Object.values(RESPONSE_VERBOSITY_OUTPUT_STYLE_NAMES).sort();
    expect(
      emitted.filter((n) => !seeded.includes(n)),
      `these outputStyle values match no seeded artifact name, so they resolve to null on every host`,
    ).toEqual([]);
  });

  it('keeps one name per slug, on the same levels', () => {
    expect(Object.keys(RESPONSE_VERBOSITY_OUTPUT_STYLE_NAMES).sort()).toEqual(
      Object.keys(RESPONSE_VERBOSITY_OUTPUT_STYLE_SLUGS).sort(),
    );
  });
});
