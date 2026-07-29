import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * `docs/USAGE.md` spells out the Codex subcommands that "are reserved by the
 * wrapper" and tells operators to reach a same-named profile through
 * `cdx --profile <name>`. That sentence is free text; the authority is the
 * `reservedCodexSubcommands` map in `wrappers/cxx/internal/app/codex/main.go`, which grows
 * whenever upstream Codex adds a subcommand. The two agree today, and nothing
 * would notice the doc going stale — the same drift the wrapper CLI surface and
 * auth struct contract tests were added to close.
 *
 * So the map's string keys are read as text and diffed against the backticked
 * names of that sentence, both directions. A reserved name operators cannot
 * discover, and a name the doc reserves that the wrapper does not, each fail the
 * API suite instead of aging in the doc.
 */

const ROOT = resolve(import.meta.dirname, '../../../..');

const MAIN = 'wrappers/cxx/internal/app/codex/main.go';
const DOC = 'docs/USAGE.md';

/**
 * Reserved names deliberately kept out of the sentence, keyed by subcommand with
 * the reason. Empty today — every key of the map is a name an operator can
 * collide with by naming a profile after it. An entry belongs here only for a
 * name upstream Codex does not actually expose.
 */
const ALLOWED: Record<string, string> = {};

const MAP = 'var reservedCodexSubcommands = map[string]bool{';

/** Body of the brace-delimited block whose opening `{` is at `open`. */
const block = (source: string, open: number): string => {
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}' && (depth -= 1) === 0) return source.slice(open + 1, i);
  }
  throw new Error(`unbalanced braces at offset ${open}`);
};

/** String keys of the `reservedCodexSubcommands` map literal, in source order. */
const reservedSubcommands = (): string[] => {
  const source = readFileSync(resolve(ROOT, MAIN), 'utf8');
  const start = source.indexOf(MAP);
  if (start < 0) throw new Error(`"${MAP}" not found in ${MAIN}`);
  const body = block(source, start + MAP.length - 1);
  return [...body.matchAll(/^\s*"([^"]+)"\s*:/gm)].map((entry) => entry[1]!);
};

/** The doc sentence carrying the list; its shape is part of what is asserted. */
const SENTENCE = /^Known Codex subcommands \(([^)]*)\) are reserved by the wrapper\b/m;

/** Backticked names of the reserved-subcommand sentence, in doc order. */
const documentedSubcommands = (): string[] => {
  const source = readFileSync(resolve(ROOT, DOC), 'utf8');
  const sentence = SENTENCE.exec(source);
  if (!sentence) throw new Error(`the reserved-subcommand sentence was not found in ${DOC}`);
  return [...sentence[1]!.matchAll(/`([^`]+)`/g)].map((name) => name[1]!);
};

describe('docs/USAGE.md reserved Codex subcommands', () => {
  it('lists exactly the subcommands cdx reserves', () => {
    const reserved = reservedSubcommands();
    // Guards the extraction itself: a rewritten map that parses to nothing would
    // otherwise reserve nothing and still pass.
    expect(reserved).toContain('exec');
    expect(reserved.length).toBeGreaterThanOrEqual(8);

    const documented = documentedSubcommands();
    const undocumented = reserved.filter((sub) => !documented.includes(sub) && !(sub in ALLOWED));
    expect(undocumented).toEqual([]);

    const stale = documented.filter((sub) => !reserved.includes(sub));
    expect(stale).toEqual([]);
  });
});
