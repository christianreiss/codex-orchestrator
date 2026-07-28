import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * `docs/interface-cdx.md` and `docs/interface-clx.md` carry the CLI surface
 * tables operators run the fleet from, but nothing tied them to the wrappers.
 * They drifted: both wrappers dispatch bare `update`, `uninstall` and `cron`
 * subcommands next to the documented `--update`/`--uninstall`/`--cron` flags,
 * and `exec`'s sibling `execute` was documented only as a flag on cdx and not
 * at all on clx. A subcommand that exists but is written down nowhere is a
 * subcommand operators cannot use.
 *
 * So the `case "<name>":` labels of each wrapper's top-level dispatch switch
 * are read as text and matched against the leading token of every backticked
 * name in the first column of the matching doc table. A new case with no row
 * fails the API suite instead of shipping undocumented.
 */

const ROOT = resolve(import.meta.dirname, '../../../..');

const WRAPPERS = [
  { name: 'cdx', main: 'wrappers/cdx/cmd/cdx/main.go', doc: 'docs/interface-cdx.md' },
  { name: 'clx', main: 'wrappers/clx/cmd/clx/main.go', doc: 'docs/interface-clx.md' },
] as const;

/**
 * Dispatch cases deliberately kept out of the operator tables, keyed
 * `<wrapper> <case>` with the reason. Empty today — every case of both
 * switches is a spelling an operator can type. An entry belongs here only for
 * an internal token, e.g. one the wrapper dispatches to itself.
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

const RUN = /\bfunc run\(args \[\]string, stdout, stderr io\.Writer\)[^\n]*\{/;
/** The subcommand dispatch inside `run()`; the other `switch sub` blocks are helpers. */
const DISPATCH = 'switch sub {';

const CASE = /^\s*case\s+([^{}]*?):\s*$/;

/**
 * Names of the `case` labels at the switch's own nesting depth, in source
 * order. A nested block opens a brace, so its labels are skipped; braces are
 * counted literally, which holds because neither dispatch body has one inside
 * a string or comment.
 */
const caseNames = (body: string): string[] => {
  const names: string[] = [];
  let depth = 0;
  for (const line of body.split('\n')) {
    const label = depth === 0 ? CASE.exec(line) : null;
    if (label) names.push(...[...label[1]!.matchAll(/"([^"]+)"/g)].map((name) => name[1]!));
    for (const char of line) {
      if (char === '{') depth += 1;
      else if (char === '}') depth -= 1;
    }
  }
  return names;
};

/** Subcommands the wrapper's top-level dispatch switch claims. */
const dispatchedSubcommands = (main: string): string[] => {
  const source = readFileSync(resolve(ROOT, main), 'utf8');
  const run = RUN.exec(source);
  if (!run) throw new Error(`${RUN.source} not found in ${main}`);
  const body = block(source, run.index + run[0].length - 1);
  const dispatch = body.indexOf(DISPATCH);
  if (dispatch < 0) throw new Error(`"${DISPATCH}" not found in run() of ${main}`);
  return caseNames(block(body, dispatch + DISPATCH.length - 1));
};

const CLI_SURFACE = '## CLI surface';

/** The command a first-column name documents: `lane [normal\|spark]` documents `lane`. */
const command = (name: string): string => /^[^\s[\\]+/.exec(name)?.[0] ?? '';

/** First cell of a table row; a `\|` inside it is escaped markdown, not the column break. */
const CELL = /^\|((?:\\.|[^|\\])*)\|/;

/** Leading tokens of the backticked names in the first column of the CLI surface table. */
const documentedCommands = (doc: string): Set<string> => {
  const source = readFileSync(resolve(ROOT, doc), 'utf8');
  const start = source.indexOf(CLI_SURFACE);
  if (start < 0) throw new Error(`"${CLI_SURFACE}" not found in ${doc}`);
  const commands = new Set<string>();
  for (const line of source.slice(start + CLI_SURFACE.length).split('\n')) {
    if (!line.startsWith('|')) {
      if (commands.size > 0) break;
      continue;
    }
    const cell = CELL.exec(line);
    if (!cell) continue;
    for (const name of cell[1]!.matchAll(/`([^`]+)`/g)) commands.add(command(name[1]!));
  }
  return commands;
};

describe('wrapper CLI surface tables', () => {
  for (const wrapper of WRAPPERS) {
    it(`${wrapper.doc} lists every subcommand ${wrapper.name} dispatches`, () => {
      const subcommands = dispatchedSubcommands(wrapper.main);
      // Guards the extraction itself: a rewritten switch that parses to nothing
      // would otherwise document nothing and still pass.
      expect(subcommands).toContain('run');
      expect(subcommands.length).toBeGreaterThanOrEqual(8);

      const documented = documentedCommands(wrapper.doc);
      const undocumented = subcommands.filter(
        (sub) => !documented.has(sub) && !(`${wrapper.name} ${sub}` in ALLOWED),
      );
      expect(undocumented).toEqual([]);
    });
  }
});
