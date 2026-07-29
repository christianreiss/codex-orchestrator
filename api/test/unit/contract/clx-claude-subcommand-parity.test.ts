import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * clx keeps two lists of Claude CLI subcommands. `reservedClaudeSubcommands` in
 * `wrappers/cxx/internal/app/claude/main.go` decides what the wrapper forwards verbatim to
 * the upstream binary; `claudeTopLevelSubcommands` in
 * `wrappers/cxx/internal/claude/runtime_auth.go` decides where
 * `injectRuntimeAuthSettings` puts the `--settings <tmpfile>` auth overlay. A
 * forwarded name missing from the second list is read as a prompt, so the
 * overlay is appended *after* the subcommand and its arguments — where Claude
 * reads it as one of the subcommand's own operands rather than as the
 * highest-precedence auth source it is meant to be.
 *
 * Both map literals are read as text and the first is diffed against the second.
 * The reverse direction is deliberately not asserted: the runtime list is a
 * superset covering every upstream subcommand, forwarded or not.
 */

const ROOT = resolve(import.meta.dirname, '../../../..');

const MAIN = 'wrappers/cxx/internal/app/claude/main.go';
const RUNTIME_AUTH = 'wrappers/cxx/internal/claude/runtime_auth.go';

/**
 * Forwarded names deliberately kept out of `claudeTopLevelSubcommands`, keyed by
 * subcommand with the reason. An entry belongs here only for a name the upstream
 * binary does not parse as a subcommand.
 */
const ALLOWED: Record<string, string> = {
  resume:
    'claude spells resume as `--resume`, so clx rewrites the token in resumeArgs and it never reaches upstream argv as a subcommand',
};

const RESERVED_MAP = 'var reservedClaudeSubcommands = map[string]bool{';
const TOP_LEVEL_MAP = 'var claudeTopLevelSubcommands = map[string]struct{}{';

/** Body of the brace-delimited block whose opening `{` is at `open`. */
const block = (source: string, open: number): string => {
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}' && (depth -= 1) === 0) return source.slice(open + 1, i);
  }
  throw new Error(`unbalanced braces at offset ${open}`);
};

/** String keys of a Go map literal, in source order. */
const mapKeys = (file: string, declaration: string): string[] => {
  const source = readFileSync(resolve(ROOT, file), 'utf8');
  const start = source.indexOf(declaration);
  if (start < 0) throw new Error(`"${declaration}" not found in ${file}`);
  // `map[string]struct{}{` ends on the literal's own `{`; step back to it.
  const body = block(source, start + declaration.length - 1);
  return [...body.matchAll(/"([^"]+)"\s*:/g)].map((entry) => entry[1]!);
};

describe('clx Claude subcommand lists', () => {
  it('routes the runtime auth overlay ahead of every passed-through subcommand', () => {
    const reserved = mapKeys(MAIN, RESERVED_MAP);
    const topLevel = mapKeys(RUNTIME_AUTH, TOP_LEVEL_MAP);
    // Guards the extraction itself: a rewritten map that parses to nothing would
    // otherwise compare empty against empty and still pass.
    expect(reserved).toContain('mcp');
    expect(reserved.length).toBeGreaterThanOrEqual(8);
    expect(topLevel).toContain('mcp');
    expect(topLevel.length).toBeGreaterThanOrEqual(16);

    const unhandled = reserved.filter((sub) => !topLevel.includes(sub) && !(sub in ALLOWED));
    expect(unhandled).toEqual([]);
  });
});
