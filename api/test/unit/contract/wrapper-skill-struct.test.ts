import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Both wrappers decode `GET /skills` into a hand-written `Skill` struct, while
 * the server side of that payload is two object literals (`decorate` for stored
 * rows, `decorateManaged` for the code-derived ones). Nothing paired the two,
 * and clx's struct drifted: it declared `name`, `version` and `body` tags the
 * API never emits, so those fields always decoded empty — and the empty
 * `version` was folded into the skills change fingerprint. Go compiles, vets
 * and tests green either way; only a scan catches it.
 *
 * This reads the json tags of `Skill` out of both wrappers as text and fails
 * when a tag names nothing either decorator emits. Sibling of
 * wrapper-auth-structs.test.ts, which guards `HostInfo`/`VersionSummary`.
 */

const HOST_SKILLS = resolve(import.meta.dirname, '../../../src/services/host-skills.ts');
const CDX_SKILLS = resolve(import.meta.dirname, '../../../../wrappers/cdx/internal/orchestrator/skills.go');
const CLX_SKILLS = resolve(import.meta.dirname, '../../../../wrappers/clx/internal/orchestrator/skills.go');

/**
 * Tags a wrapper decodes on purpose without a matching server key, keyed
 * `<wrapper> Skill.<tag>` with the reason. Empty today — every tag of both
 * structs is a key the server emits. An entry belongs here only when a wrapper
 * has to keep reading a key the API no longer sends, e.g. while older servers
 * are still in the fleet.
 */
const ALLOWED: Record<string, string> = {};

/** Body of the brace-delimited block whose opening `{` is at `open`. */
const block = (source: string, open: number): string => {
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}' && (depth -= 1) === 0) return source.slice(open + 1, i);
  }
  throw new Error(`unbalanced braces at offset ${open}`);
};

/** Opening `{` of the declaration `header` matches, which must be the last one. */
const declarationBody = (source: string, file: string, header: RegExp): string => {
  const declaration = header.exec(source);
  if (!declaration) throw new Error(`${header.source} not found in ${file}`);
  return block(source, declaration.index + declaration[0].length - 1);
};

const GO_TAG = /`[^`]*\bjson:"([^",]+)/g;

/** json tags of the fields of a Go struct, in declaration order. */
const goTags = (file: string, struct: string): string[] => {
  const header = new RegExp(`\\btype ${struct} struct \\{`);
  const body = declarationBody(readFileSync(file, 'utf8'), file, header);
  return [...body.matchAll(GO_TAG)].map((tag) => tag[1]!);
};

const KEY = /^\s*([A-Za-z_$][\w$]*)\s*:/;

/**
 * Property names at depth 0 of an object-literal body. Brackets are counted
 * without regard for quotes, which is enough: no value in the payload carries a
 * bracket inside a string literal.
 */
const literalKeys = (body: string): string[] => {
  const keys: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i <= body.length; i++) {
    const c = body[i];
    if (c === '{' || c === '(' || c === '[') depth += 1;
    else if (c === '}' || c === ')' || c === ']') depth -= 1;
    if (depth !== 0 || (c !== ',' && i !== body.length)) continue;
    const key = KEY.exec(body.slice(start, i));
    if (key) keys.push(key[1]!);
    start = i + 1;
  }
  return keys;
};

const source = readFileSync(HOST_SKILLS, 'utf8');
const decoratorKeys = (name: string): string[] =>
  literalKeys(
    declarationBody(source, HOST_SKILLS, new RegExp(`private ${name}\\([^)]*\\)[^{]*\\{\\s*return\\s*\\{`)),
  );

const storedKeys = decoratorKeys('decorate');
const managedKeys = decoratorKeys('decorateManaged');
const serverKeys = [...new Set([...storedKeys, ...managedKeys])];

const WRAPPERS = [
  { wrapper: 'cdx', file: CDX_SKILLS },
  { wrapper: 'clx', file: CLX_SKILLS },
];

describe('wrapper skill struct', () => {
  it('extracts the tags and server keys it is meant to compare', () => {
    // A scan that read nothing would pass the comparison below on both sides.
    expect(storedKeys).toContain('canonical_uri');
    expect(managedKeys).toContain('canonical_uri');
    expect(storedKeys.length).toBeGreaterThan(8);
    expect(managedKeys.length).toBeGreaterThan(8);
    for (const { file } of WRAPPERS) {
      expect(goTags(file, 'Skill')).toContain('slug');
      expect(goTags(file, 'Skill')).toContain('sha256');
      expect(goTags(file, 'Skill')).toContain('display_name');
    }
  });

  it('decodes only keys the server emits', () => {
    const unmatched = WRAPPERS.flatMap(({ wrapper, file }) =>
      goTags(file, 'Skill')
        .filter((tag) => !serverKeys.includes(tag) && !(`${wrapper} Skill.${tag}` in ALLOWED))
        .map((tag) => `${wrapper} Skill.${tag} is not emitted by decorate()/decorateManaged()`),
    );
    expect(
      unmatched,
      'rename the json tag to match the server, or allowlist it with a reason',
    ).toEqual([]);
  });

  it('keeps the allowlist to deltas that still exist', () => {
    const stale = Object.keys(ALLOWED).filter((entry) => {
      const check = WRAPPERS.find(({ wrapper }) => entry.startsWith(`${wrapper} Skill.`));
      if (!check) return true;
      const tag = entry.slice(entry.indexOf('.') + 1);
      return serverKeys.includes(tag) || !goTags(check.file, 'Skill').includes(tag);
    });
    expect(stale, 'drop the allowlist entry: the tag is gone or the server emits it again').toEqual(
      [],
    );
  });
});
