import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * `docs/SECURITY.md` is the checklist an operator tunes a deployment from, and
 * `docs-security-env-truth.test.ts` next door deliberately compares names only.
 * So every number beside a name can rot in silence: editing `intish(120)` in
 * the schema, or an entry in `BYPASS_PREFIXES`, leaves the doc confidently
 * wrong with a green gate.
 *
 * Values only — each number the doc quotes is compared against the constant it
 * restates, and its "only ... are skipped" list against the set the rate-limit
 * hook actually skips. They all agree today; this pins them.
 */

const ROOT = resolve(import.meta.dirname, '../../../..');
const DOC_REL = 'docs/SECURITY.md';
const DOC = resolve(ROOT, DOC_REL);
const ENV_TS = resolve(ROOT, 'api/src/env.ts');
const RUNNER_VALIDATION_TS = resolve(ROOT, 'api/src/services/runner-validation.ts');
const RATE_LIMIT_TS = resolve(ROOT, 'api/src/http/plugins/rate-limit.ts');

/** The numbers one sentence of the doc quotes, with the line that quoted them. */
interface Quoted {
  line: number;
  values: number[];
}

/**
 * Every match of `pattern`, which is matched globally because the rate-limit
 * defaults are stated twice — once in the hardening checklist, once under
 * abuse controls — and both copies have to hold.
 */
const quoted = (pattern: RegExp): Quoted[] => {
  const doc = readFileSync(DOC, 'utf8');
  return [...doc.matchAll(pattern)].map((m) => ({
    line: doc.slice(0, m.index).split('\n').length,
    values: m.slice(1).map(Number),
  }));
};

/**
 * Compares quotations against the source values with the doc line carried into
 * both sides, so a failure names the line to fix instead of only the numbers.
 * `times` is what keeps a doc rewrite the pattern stops matching from turning
 * the comparison into two empty lists.
 */
const expectQuoted = (stated: Quoted[], expected: number[], times: number): void => {
  expect(stated).toHaveLength(times);
  const format = (q: Quoted, values: number[]): string =>
    `${DOC_REL}:${q.line} ${values.join(' / ')}`;
  expect(stated.map((q) => format(q, q.values))).toEqual(stated.map((q) => format(q, expected)));
};

/**
 * The `intish(...)` default of every schema key, keyed by name. A bare
 * `intish()` declares no default and is skipped; `60 * 24 * 30` is evaluated as
 * the product it is.
 */
const intishDefaults = (): Map<string, number> => {
  const src = readFileSync(ENV_TS, 'utf8');
  const decls = src.matchAll(/^ {4}([A-Z][A-Z0-9_]*): intish\(([\d* ]+)\)/gm);
  return new Map(
    [...decls].map((d) => [d[1]!, d[2]!.split('*').reduce((n, factor) => n * Number(factor), 1)]),
  );
};

/** `const DEFAULT_TOKEN_MIN_LENGTH = 24;` and the floor declared beside it. */
const tokenLengths = (): Map<string, number> => {
  const src = readFileSync(RUNNER_VALIDATION_TS, 'utf8');
  const decls = src.matchAll(/^const (DEFAULT_TOKEN_MIN_LENGTH|TOKEN_MIN_LENGTH_FLOOR) = (\d+);/gm);
  return new Map([...decls].map((d) => [d[1]!, Number(d[2]!)]));
};

/**
 * What the `preHandler` skips: the `BYPASS_PREFIXES` list plus the `/healthz`
 * and `/admin/ws` checks it spells out inline above the loop.
 */
const bypassPaths = (): Set<string> => {
  const src = readFileSync(RATE_LIMIT_TS, 'utf8');
  const list = /const BYPASS_PREFIXES = \[([^\]]*)\]/.exec(src);
  expect(list).not.toBeNull();
  const prefixes = [...list![1]!.matchAll(/'([^']+)'/g)].map((m) => m[1]!);
  const inline = [...src.matchAll(/req\.url(?: === |\.startsWith\()'([^']+)'/g)].map((m) => m[1]!);
  return new Set([...prefixes, ...inline]);
};

/** The doc's `only ... are skipped` enumeration, with its line. */
const documentedBypass = (): { line: number; paths: Set<string> } => {
  const doc = readFileSync(DOC, 'utf8');
  const sentence = /only (.+?) are skipped/.exec(doc);
  expect(sentence).not.toBeNull();
  return {
    line: doc.slice(0, sentence!.index).split('\n').length,
    paths: new Set([...sentence![1]!.matchAll(/`([^`]+)`/g)].map((m) => m[1]!)),
  };
};

describe('docs/SECURITY.md tuning values', () => {
  it('quotes the admin session TTL default the schema declares', () => {
    expectQuoted(
      quoted(/`ADMIN_SESSION_TTL_MINUTES`, default (\d+)/g),
      [intishDefaults().get('ADMIN_SESSION_TTL_MINUTES')!],
      1,
    );
  });

  it('quotes the global bucket defaults the schema declares', () => {
    const defaults = intishDefaults();
    expectQuoted(
      quoted(/defaults? (\d+) req ?\/ ?(\d+)s\b/g),
      [defaults.get('RATE_LIMIT_GLOBAL_PER_MINUTE')!, defaults.get('RATE_LIMIT_GLOBAL_WINDOW')!],
      2,
    );
  });

  it('quotes the auth-fail bucket defaults the schema declares', () => {
    const defaults = intishDefaults();
    const expected = [
      defaults.get('RATE_LIMIT_AUTH_FAIL_COUNT')!,
      defaults.get('RATE_LIMIT_AUTH_FAIL_WINDOW')!,
    ];
    expectQuoted(quoted(/defaults? (\d+) fails ?\/ ?(\d+)s\b/g), expected, 1);

    // The hardening checklist states the same window as `10m`.
    const inMinutes = quoted(/defaults? (\d+) fails ?\/ ?(\d+)m\b/g).map((q) => ({
      ...q,
      values: [q.values[0]!, q.values[1]! * 60],
    }));
    expectQuoted(inMinutes, expected, 1);
  });

  it('quotes the token length floor and default runner-validation applies', () => {
    const lengths = tokenLengths();
    expectQuoted(
      quoted(/`TOKEN_MIN_LENGTH` min (\d+), default (\d+)/g),
      [lengths.get('TOKEN_MIN_LENGTH_FLOOR')!, lengths.get('DEFAULT_TOKEN_MIN_LENGTH')!],
      1,
    );
  });

  it('lists exactly the paths the rate-limit hook skips', () => {
    const { line, paths } = documentedBypass();
    const format = (set: Set<string>): string => `${DOC_REL}:${line} ${[...set].sort().join(' ')}`;

    // Both directions: a path the hook stopped skipping is a promise the doc
    // makes that the API no longer keeps, and one it started skipping is a
    // bypass the checklist tells operators does not exist.
    expect(format(paths)).toEqual(format(bypassPaths()));
  });

  // Pins the extractions, so a regex that quietly stops matching cannot turn
  // the checks above into comparisons of two empty lists.
  it('reads the numbers out of the doc and each source', () => {
    const defaults = intishDefaults();
    expect(defaults.size).toBeGreaterThan(10);
    expect(defaults.get('MCP_FS_MAX_READ_BYTES')).toBe(1024 * 1024); // The product form, evaluated.
    expect(defaults.has('RATE_LIMIT_AUTH_FAIL_WINDOW')).toBe(true); // Declared before a `.pipe(...)`.
    expect(defaults.has('SMTP_PORT')).toBe(false); // A bare `intish()` states no default.

    expect([...tokenLengths().keys()].sort()).toEqual([
      'DEFAULT_TOKEN_MIN_LENGTH',
      'TOKEN_MIN_LENGTH_FLOOR',
    ]);

    const skipped = bypassPaths();
    expect(skipped.has('/healthz')).toBe(true); // Inline `===`, not in the list.
    expect(skipped.has('/admin/ws')).toBe(true); // Inline `startsWith`.
    expect(skipped.has('/admin/favicon')).toBe(true); // From the list.

    expect(documentedBypass().line).toBeGreaterThan(0);
    expect(quoted(/`TOKEN_MIN_LENGTH` min (\d+), default (\d+)/g)).toHaveLength(1);
  });
});
