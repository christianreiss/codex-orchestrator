import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { ARTIFACT_KINDS, KIND_DIRS } from '../../../src/services/claude-frontmatter.js';

/**
 * `ARTIFACT_KINDS` / `KIND_DIRS` key the `/sync/bootstrap` artifact bundle
 * (host-claude-artifacts.ts), and clx re-declares that vocabulary three more
 * times by hand: the `ClaudeArtifacts` json tags it decodes the bundle into, the
 * `artifactDirs` map that picks the `~/.claude` subdir to write, and the
 * `collectionDirs` map uninstall walks — whose comment claims lock-step with
 * `artifactDirs` with nothing checking it.
 *
 * Drift is silent and destructive rather than loud: a server-side kind the
 * struct has no tag for decodes into a nil slice, and because `applyCollection`
 * reconciles deletions against the on-disk manifest, an empty list makes clx
 * delete every fleet-written file of that kind. `wrappers.parity` only compares
 * cdx against clx, so it cannot see an API-to-wrapper rename.
 *
 * All three Go sides are read as text against the TypeScript constants, in both
 * directions. Sibling of wrapper-skill-struct.test.ts.
 */

const BUNDLE = resolve(
  import.meta.dirname,
  '../../../../wrappers/cxx/internal/persona/claude/orchestrator/bundle.go',
);
const COLLECTIONS = resolve(
  import.meta.dirname,
  '../../../../wrappers/cxx/internal/persona/claude/lifecycle/collections.go',
);
const UNINSTALL = resolve(
  import.meta.dirname,
  '../../../../wrappers/cxx/internal/persona/claude/uninstall/uninstall.go',
);

/** Body of the brace-delimited block whose opening `{` is at `open`. */
const block = (source: string, open: number): string => {
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}' && (depth -= 1) === 0) return source.slice(open + 1, i);
  }
  throw new Error(`unbalanced braces at offset ${open}`);
};

/**
 * Body of the declaration `header` matches, whose `{` must be its last
 * character. Throws when the declaration is absent so a rename fails here
 * instead of leaving an empty extraction to match nothing.
 */
const declarationBody = (file: string, name: string, header: RegExp): string => {
  const source = readFileSync(file, 'utf8');
  const declaration = header.exec(source);
  if (!declaration) throw new Error(`declaration ${name} not found in ${file}`);
  return block(source, declaration.index + declaration[0].length - 1);
};

const GO_TAG = /`[^`]*\bjson:"([^",]+)/g;

/** json tags of the fields of a Go struct. */
const goTags = (file: string, struct: string): string[] => {
  const body = declarationBody(file, struct, new RegExp(`\\btype ${struct} struct \\{`));
  return [...body.matchAll(GO_TAG)].map((tag) => tag[1]!);
};

const GO_PAIR = /"([^"]+)"\s*:\s*"([^"]+)"/g;

/** Entries of a `var <name> = map[string]string{…}` literal. */
const goMap = (file: string, name: string): Record<string, string> => {
  const body = declarationBody(file, name, new RegExp(`\\bvar ${name} = map\\[string\\]string\\{`));
  return Object.fromEntries([...body.matchAll(GO_PAIR)].map((pair) => [pair[1]!, pair[2]!]));
};

const sorted = (values: readonly string[]): string[] => [...new Set(values)].sort();

describe('claude artifact kind vocabulary', () => {
  it('decodes exactly the kinds the bundle is keyed by', () => {
    expect(sorted(goTags(BUNDLE, 'ClaudeArtifacts'))).toEqual(sorted(ARTIFACT_KINDS));
  });

  it('writes each kind into the directory the server names', () => {
    expect(goMap(COLLECTIONS, 'artifactDirs')).toEqual(KIND_DIRS);
  });

  it('uninstalls exactly the directories the kinds map to', () => {
    expect(sorted(Object.values(goMap(UNINSTALL, 'collectionDirs')))).toEqual(
      sorted(Object.values(KIND_DIRS)),
    );
  });
});
