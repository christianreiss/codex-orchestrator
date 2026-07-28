import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * cdx and clx decode the /auth response into hand-written Go structs, while the
 * server side of the same payload is one object literal (`buildHostPayload`)
 * and one interface (`VersionSnapshot`). Nothing paired the two: renaming a key
 * on either side compiles, vets and tests green in both languages, and the
 * wrapper quietly decodes a zero value instead — the failure class that already
 * shipped once when the wrapper client structs decoded the wrong keys.
 *
 * This reads the json tags of both structs out of both wrappers as text and
 * fails when a tag names nothing the server emits. `HostInfo` is compared with
 * `buildHostPayload` and `VersionSummary` with `VersionSnapshot`, so a rename
 * that happens to collide with a key of the other payload still fails.
 */

const AUTH_ROUTE = resolve(import.meta.dirname, '../../../src/routes/auth/index.ts');
const VERSION_SNAPSHOT = resolve(import.meta.dirname, '../../../src/services/version-snapshot.ts');
const CDX_AUTH = resolve(import.meta.dirname, '../../../../wrappers/cdx/internal/orchestrator/auth.go');
const CLX_AUTH = resolve(import.meta.dirname, '../../../../wrappers/clx/internal/orchestrator/auth.go');

/**
 * Tags a wrapper decodes on purpose without a matching server key, keyed
 * `<wrapper> <struct>.<tag>` with the reason. Empty today — every tag of both
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

const HOST_PAYLOAD = /function buildHostPayload\([^)]*\)[^{]*\{\s*return\s*\{/;
const SNAPSHOT = /export interface VersionSnapshot \{/;
/** One member per line, so a line-anchored name is all a property is. */
const MEMBER = /^\s*([A-Za-z_$][\w$]*)\??\s*:/gm;

const hostKeys = literalKeys(
  declarationBody(readFileSync(AUTH_ROUTE, 'utf8'), AUTH_ROUTE, HOST_PAYLOAD),
);
const versionKeys = [
  ...declarationBody(readFileSync(VERSION_SNAPSHOT, 'utf8'), VERSION_SNAPSHOT, SNAPSHOT).matchAll(
    MEMBER,
  ),
].map((member) => member[1]!);

const CHECKS = [
  { wrapper: 'cdx', file: CDX_AUTH, struct: 'HostInfo', server: 'buildHostPayload', keys: hostKeys },
  { wrapper: 'cdx', file: CDX_AUTH, struct: 'VersionSummary', server: 'VersionSnapshot', keys: versionKeys },
  { wrapper: 'clx', file: CLX_AUTH, struct: 'HostInfo', server: 'buildHostPayload', keys: hostKeys },
  { wrapper: 'clx', file: CLX_AUTH, struct: 'VersionSummary', server: 'VersionSnapshot', keys: versionKeys },
];

describe('wrapper auth structs', () => {
  it('extracts the tags and server keys it is meant to compare', () => {
    // A scan that read nothing would pass the comparison below on both sides.
    expect(hostKeys).toContain('claude_reasoning_effort_override');
    expect(hostKeys).toContain('engines_list');
    expect(hostKeys.length).toBeGreaterThan(25);
    expect(versionKeys).toContain('client_version_enforce_exact');
    expect(versionKeys.length).toBeGreaterThan(10);
    expect(goTags(CDX_AUTH, 'HostInfo')).toContain('reasoning_effort_override');
    expect(goTags(CLX_AUTH, 'HostInfo')).toContain('claude_client_version');
    for (const { file, struct } of CHECKS) expect(goTags(file, struct).length).toBeGreaterThan(10);
  });

  it('decodes only keys the server emits', () => {
    const unmatched = CHECKS.flatMap(({ wrapper, file, struct, server, keys }) =>
      goTags(file, struct)
        .filter((tag) => !keys.includes(tag) && !(`${wrapper} ${struct}.${tag}` in ALLOWED))
        .map((tag) => `${wrapper} ${struct}.${tag} is not emitted by ${server}`),
    );
    expect(
      unmatched,
      'rename the json tag to match the server, or allowlist it with a reason',
    ).toEqual([]);
  });

  it('keeps the allowlist to deltas that still exist', () => {
    const stale = Object.keys(ALLOWED).filter((entry) => {
      const check = CHECKS.find(({ wrapper, struct }) => entry.startsWith(`${wrapper} ${struct}.`));
      if (!check) return true;
      const tag = entry.slice(entry.indexOf('.') + 1);
      return check.keys.includes(tag) || !goTags(check.file, check.struct).includes(tag);
    });
    expect(stale, 'drop the allowlist entry: the tag is gone or the server emits it again').toEqual(
      [],
    );
  });
});
