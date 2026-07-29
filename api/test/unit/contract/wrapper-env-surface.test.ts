import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

/**
 * `docs/interface-cdx.md` and `docs/interface-clx.md` call themselves the
 * source of truth for the wrapper interface, but for a long time neither named
 * a single environment variable — while the binaries read operator-facing
 * knobs like `CDX_CONFIG_PATH`, `CDX_CODEX_BIN`, `CDX_CODEX_INSTALL_DIR`,
 * `CLX_CLAUDE_BIN` and the `*_SKIP_BANNER` pair. An override an operator
 * cannot discover is an override that does not exist for them.
 *
 * So each doc's environment-variable table is diffed against the `CDX_*` /
 * `CLX_*` names the matching wrapper actually reads through `os.Getenv` /
 * `os.LookupEnv` in its non-test Go sources. A new or renamed knob fails the
 * API suite with its source file:line instead of shipping undocumented, and a
 * row for a knob nothing reads fails as stale.
 */

const ROOT = resolve(import.meta.dirname, '../../../..');

const WRAPPERS = [
  {
    name: 'cdx',
    dirs: [
      'wrappers/cxx/internal/app/codex',
      'wrappers/cxx/internal/codex',
      'wrappers/cxx/internal/persona/codex',
      'wrappers/cxx/internal/config',
    ],
    doc: 'docs/interface-cdx.md',
    /** Must be extracted: one plain literal read, one read through a `const`. */
    probe: ['CDX_CONFIG_PATH', 'CDX_AUTH_SESSION_HANDOFF'],
  },
  {
    name: 'clx',
    dirs: [
      'wrappers/cxx/internal/app/claude',
      'wrappers/cxx/internal/claude',
      'wrappers/cxx/internal/persona/claude',
      'wrappers/cxx/internal/config',
    ],
    doc: 'docs/interface-clx.md',
    probe: ['CLX_CONFIG_PATH', 'CLX_CLAUDE_BIN'],
  },
] as const;

/**
 * Knobs deliberately kept out of the operator tables, keyed `<wrapper> <NAME>`
 * with the reason, and knobs a table may list without a matching read. Empty
 * today: every name both wrappers read is a documented row. An entry belongs
 * here only for a name that is genuinely not part of the operator surface.
 */
const ALLOWED: Record<string, string> = {};

/** The `CDX_*` / `CLX_*` namespace both docs claim; other env names are engine-level. */
const WRAPPER_ENV = /^(?:CDX|CLX)_[A-Z0-9_]+$/;

/** Every non-test `.go` file of a wrapper, repo-relative for the failure text. */
const goSources = (dirs: readonly string[]): string[] => {
  const found = new Set<string>();
  const walk = (path: string): void => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) walk(child);
      else if (entry.name.endsWith('.go') && !entry.name.endsWith('_test.go')) found.add(child);
    }
  };
  for (const dir of dirs) walk(resolve(ROOT, dir));
  return [...found].map((path) => relative(ROOT, path));
};

/** `const fooEnv = "FOO"` / `fooEnv = "FOO"` inside a `const (...)` block. */
const CONST = /^\s*(?:const|var)?\s*([A-Za-z_]\w*)\s*=\s*"([^"\\]*)"\s*$/;

/** First value in a multi-assignment such as `envName, filename = "CDX_CONFIG_PATH", ...`. */
const ASSIGN = /\b([A-Za-z_]\w*)\s*(?:,\s*[A-Za-z_]\w*)?\s*=\s*"([^"\\]*)"/g;

/** String values assigned to identifiers, including switch-selected values. */
const assignedValues = (sources: string[]): Map<string, Set<string>> => {
  const values = new Map<string, Set<string>>();
  const add = (identifier: string, value: string): void => {
    const seen = values.get(identifier) ?? new Set<string>();
    seen.add(value);
    values.set(identifier, seen);
  };
  for (const source of sources) {
    for (const line of readFileSync(resolve(ROOT, source), 'utf8').split('\n')) {
      const decl = CONST.exec(line);
      if (decl) add(decl[1]!, decl[2]!);
      for (const assignment of line.matchAll(ASSIGN)) add(assignment[1]!, assignment[2]!);
    }
  }
  return values;
};

/**
 * An env read; the argument is a string literal, a local identifier, or a
 * package-qualified shared constant such as `hostcron.CoordinatedEnv`.
 * Qualified constants are accepted by the parser but intentionally resolve to
 * no per-persona name here: this contract owns only the CDX_/CLX_ namespaces.
 */
const READ = /\bos\.(?:Getenv|LookupEnv)\(\s*(?:"([^"\\]*)"|([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)?))\s*\)/g;
/** Guards the argument shapes above: a call the regex above cannot parse must not pass silently. */
const CALL = /\bos\.(?:Getenv|LookupEnv)\(/g;

/** Wrapper-namespace env names the wrapper reads, each with the first source file:line. */
const readNames = (dirs: readonly string[]): Map<string, string> => {
  const sources = goSources(dirs);
  const values = assignedValues(sources);
  const names = new Map<string, string>();
  for (const source of sources) {
    const lines = readFileSync(resolve(ROOT, source), 'utf8').split('\n');
    lines.forEach((line, index) => {
      if (line.trimStart().startsWith('//')) return;
      const where = `${source}:${index + 1}`;
      const reads = [...line.matchAll(READ)];
      if (reads.length !== [...line.matchAll(CALL)].length) {
        throw new Error(`unparsed os.Getenv/os.LookupEnv argument at ${where}`);
      }
      for (const read of reads) {
        const resolved = read[1] ? [read[1]] : [...(values.get(read[2]!) ?? [])];
        for (const name of resolved) {
          if (WRAPPER_ENV.test(name) && !names.has(name)) names.set(name, where);
        }
      }
    });
  }
  return names;
};

const ENV_SURFACE = '## Environment variables';

/** First cell of a table row; a `\|` inside it is escaped markdown, not the column break. */
const CELL = /^\|((?:\\.|[^|\\])*)\|/;

/** Backticked names in the first column of the environment-variable table. */
const documentedNames = (doc: string): Set<string> => {
  const source = readFileSync(resolve(ROOT, doc), 'utf8');
  const start = source.indexOf(ENV_SURFACE);
  if (start < 0) throw new Error(`"${ENV_SURFACE}" not found in ${doc}`);
  const names = new Set<string>();
  for (const line of source.slice(start + ENV_SURFACE.length).split('\n')) {
    if (!line.startsWith('|')) {
      if (names.size > 0) break;
      continue;
    }
    const cell = CELL.exec(line);
    if (!cell) continue;
    for (const name of cell[1]!.matchAll(/`([^`]+)`/g)) names.add(name[1]!);
  }
  return names;
};

describe('wrapper environment variable tables', () => {
  for (const wrapper of WRAPPERS) {
    it(`${wrapper.doc} lists every ${wrapper.name} environment knob`, () => {
      const read = readNames(wrapper.dirs);
      // Guards the extraction itself: a walk or a resolution that parses to
      // nothing would otherwise document nothing and still pass.
      for (const name of wrapper.probe) expect([...read.keys()]).toContain(name);
      expect(read.size).toBeGreaterThanOrEqual(4);

      const documented = documentedNames(wrapper.doc);
      const undocumented = [...read]
        .filter(([name]) => !documented.has(name) && !(`${wrapper.name} ${name}` in ALLOWED))
        .map(([name, where]) => `${name} (${where})`);
      expect(undocumented).toEqual([]);

      const stale = [...documented].filter(
        (name) => !read.has(name) && !(`${wrapper.name} ${name}` in ALLOWED),
      );
      expect(stale).toEqual([]);
    });
  }
});
