import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * `wrapper-cli-surface.test.ts` ties each wrapper's SUBCOMMANDS to its operator
 * doc table. Its sibling gap is flags: `parseFlags` in each wrapper's `main.go`
 * decides what `cdx`/`clx` accept, while `cdxHelpFlags`/`clxHelpFlags` in
 * `internal/persona/<engine>/ui/help.go` decide what `--wrapper-help` tells an operator
 * exists. Nothing connected the two, so a flag added to the parser reached
 * operators only if whoever added it remembered the other file.
 *
 * Both lists happen to agree today — this pins that. A flag the wrapper accepts
 * but never advertises is one operators cannot discover; the fleet has already
 * lost a release to exactly this shape of drift (`claudeGlobalOptionsWithValue`
 * silently rotting against `claude --help`).
 *
 * Only the accepted -> documented direction is asserted. The reverse would fire
 * on aliases the parser matches structurally rather than by literal (e.g. the
 * `--resume=<session>` form is `strings.HasPrefix`, not a bare case label).
 */

const ROOT = resolve(import.meta.dirname, '../../../..');

const WRAPPERS = [
  {
    name: 'cdx',
    main: 'wrappers/cxx/internal/app/codex/main.go',
    help: 'wrappers/cxx/internal/persona/codex/ui/help.go',
    table: 'cdxHelpFlags',
    doc: 'docs/interface-cdx.md',
  },
  {
    name: 'clx',
    main: 'wrappers/cxx/internal/app/claude/main.go',
    help: 'wrappers/cxx/internal/persona/claude/ui/help.go',
    table: 'clxHelpFlags',
    doc: 'docs/interface-clx.md',
  },
] as const;

/**
 * Flags the parser accepts on purpose without advertising them, keyed
 * `<wrapper> <flag>` with the reason. Empty today: every flag both wrappers
 * parse is one `--wrapper-help` names. An entry belongs here only for a token
 * the wrapper dispatches to itself rather than one an operator would type.
 */
const ALLOWED: Record<string, string> = {};

const read = (rel: string): string => readFileSync(resolve(ROOT, rel), 'utf8');

/** The body of `func parseFlags(...)`, up to its closing brace at column 0. */
const parseFlagsBody = (source: string): string => {
  const start = source.indexOf('func parseFlags');
  if (start < 0) throw new Error('parseFlags not found');
  const end = source.indexOf('\n}\n', start);
  if (end < 0) throw new Error('unterminated parseFlags');
  return source.slice(start, end);
};

/**
 * Flags `parseFlags` matches: bare `a == "--flag"` literals plus the
 * `strings.HasPrefix(a, "--flag=")` value forms, normalised to the bare name.
 */
const acceptedFlags = (source: string): string[] => {
  const body = parseFlagsBody(source);
  const literals = [...body.matchAll(/"(--?[a-zA-Z0-9][a-zA-Z0-9-]*)"/g)].map((m) => m[1]!);
  const prefixed = [...body.matchAll(/HasPrefix\(a,\s*"(--[a-zA-Z0-9-]+)=/g)].map((m) => m[1]!);
  return [...new Set([...literals, ...prefixed])];
};

/**
 * Flags named in a help table's `usage` column — the FIRST string of each
 * `{"usage", "description"}` item. Descriptions are deliberately not scanned:
 * they contain hyphenated prose ("non-error", "signing-key") that reads as a
 * short flag.
 */
const documentedFlags = (source: string, table: string): string[] => {
  const start = source.indexOf(`var ${table} = []wrapperHelpItem{`);
  if (start < 0) throw new Error(`${table} not found`);
  const end = source.indexOf('\n}', start);
  if (end < 0) throw new Error(`unterminated ${table}`);
  const items = [...source.slice(start, end).matchAll(/\{"([^"]*)",/g)].map((m) => m[1]!);
  return [...new Set(items.flatMap((usage) => [...usage.matchAll(/(--?[a-zA-Z0-9][a-zA-Z0-9-]*)/g)].map((m) => m[1]!)))];
};

describe('wrapper flag surface', () => {
  it('extracts both lists it is meant to compare', () => {
    // A renamed function or table would otherwise pass every check vacuously.
    for (const w of WRAPPERS) {
      const accepted = acceptedFlags(read(w.main));
      const documented = documentedFlags(read(w.help), w.table);
      expect(accepted.length, `${w.name} accepted`).toBeGreaterThan(10);
      expect(documented.length, `${w.name} documented`).toBeGreaterThan(10);
      expect(accepted, `${w.name} accepted`).toContain('--wrapper-help');
      expect(documented, `${w.name} documented`).toContain('--wrapper-help');
    }
  });

  it('advertises every flag it accepts', () => {
    for (const w of WRAPPERS) {
      const documented = new Set(documentedFlags(read(w.help), w.table));
      const undocumented = acceptedFlags(read(w.main))
        .filter((flag) => !documented.has(flag))
        .filter((flag) => !(`${w.name} ${flag}` in ALLOWED));
      expect(
        undocumented,
        `${w.name} parses these flags but --wrapper-help never names them, so operators ` +
          `cannot discover them — add them to ${w.table} in ${w.help}, or record the delta ` +
          `in ALLOWED here with a reason`,
      ).toEqual([]);
    }
  });

  it('names every flag it accepts in the operator interface doc', () => {
    // `--wrapper-help` is what an operator on a host sees; the interface doc is
    // what they read before touching the fleet. Both were complete when this
    // was written and neither was pinned; the doc had in fact never listed
    // --silent, --debug, --ipv4 or --config at all.
    for (const w of WRAPPERS) {
      const doc = read(w.doc);
      // Long-form prose, so match a backticked mention anywhere in the file.
      const mentioned = new Set(
        [...doc.matchAll(/`(--?[a-zA-Z0-9][a-zA-Z0-9-]*)/g)].map((m) => m[1]!),
      );
      const missing = acceptedFlags(read(w.main))
        // Short aliases are documented alongside their long form, not alone.
        .filter((flag) => flag.startsWith('--'))
        .filter((flag) => !mentioned.has(flag))
        .filter((flag) => !(`${w.name} ${flag}` in ALLOWED));
      expect(
        missing,
        `${w.name} accepts these flags but ${w.doc} never mentions them — add them to its ` +
          `"Wrapper-only flags" table, or record the delta in ALLOWED here with a reason`,
      ).toEqual([]);
    }
  });

  it('keeps the allowlist to deltas that still exist', () => {
    const stale = Object.keys(ALLOWED).filter((entry) => {
      const [name, flag] = entry.split(' ');
      const w = WRAPPERS.find((candidate) => candidate.name === name);
      if (!w || !flag) return true;
      return (
        !acceptedFlags(read(w.main)).includes(flag) ||
        documentedFlags(read(w.help), w.table).includes(flag)
      );
    });
    expect(stale, 'drop the allowlist entry: the flag is gone or is documented now').toEqual([]);
  });
});
