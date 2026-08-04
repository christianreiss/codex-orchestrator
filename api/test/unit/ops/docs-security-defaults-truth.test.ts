import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * `docs/SECURITY.md` is the checklist an operator tunes a deployment from, and
 * `docs-security-env-truth.test.ts` next door deliberately compares names only.
 * So every number beside a name can rot in silence: editing an `intish(...)`
 * default can leave the doc confidently wrong with a green gate.
 *
 * Values only — each number the doc quotes is compared against the constant it
 * restates. They all agree today; this pins them.
 */

const ROOT = resolve(import.meta.dirname, '../../../..');
const DOC_REL = 'docs/SECURITY.md';
const DOC = resolve(ROOT, DOC_REL);
const ENV_TS = resolve(ROOT, 'api/src/env.ts');
const RUNNER_VALIDATION_TS = resolve(ROOT, 'api/src/services/runner-validation.ts');

/** The numbers one sentence of the doc quotes, with the line that quoted them. */
interface Quoted {
  line: number;
  values: number[];
}

/**
 * Every match of `pattern`, matched globally when a value appears more than
 * once in the document.
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

describe('docs/SECURITY.md tuning values', () => {
  it('quotes the admin session TTL default the schema declares', () => {
    expectQuoted(
      quoted(/`ADMIN_SESSION_TTL_MINUTES`, default (\d+)/g),
      [intishDefaults().get('ADMIN_SESSION_TTL_MINUTES')!],
      1,
    );
  });

  it('quotes the token length floor and default runner-validation applies', () => {
    const lengths = tokenLengths();
    expectQuoted(
      quoted(/`TOKEN_MIN_LENGTH` min (\d+), default (\d+)/g),
      [lengths.get('TOKEN_MIN_LENGTH_FLOOR')!, lengths.get('DEFAULT_TOKEN_MIN_LENGTH')!],
      1,
    );
  });

  // Pins the extractions, so a regex that quietly stops matching cannot turn
  // the checks above into comparisons of two empty lists.
  it('reads the numbers out of the doc and each source', () => {
    const defaults = intishDefaults();
    expect(defaults.size).toBeGreaterThan(10);
    expect(defaults.get('MCP_FS_MAX_READ_BYTES')).toBe(1024 * 1024); // The product form, evaluated.
    expect(defaults.has('SMTP_PORT')).toBe(false); // A bare `intish()` states no default.

    expect([...tokenLengths().keys()].sort()).toEqual([
      'DEFAULT_TOKEN_MIN_LENGTH',
      'TOKEN_MIN_LENGTH_FLOOR',
    ]);

    expect(quoted(/`TOKEN_MIN_LENGTH` min (\d+), default (\d+)/g)).toHaveLength(1);
  });
});
