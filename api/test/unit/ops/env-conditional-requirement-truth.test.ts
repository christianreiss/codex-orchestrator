import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * The `superRefine` in `api/src/env.ts` turns a half-configured pair into a
 * `loadEnv()` throw, which is the API refusing to boot. `ADMIN_WEBAUTHN_RP_ID`
 * shipped that way: three docs presented it as an independent optional
 * override of `PUBLIC_BASE_URL`, so an operator who set only the RP ID crashed
 * the next start.
 *
 * The pairs are read out of the refinement body rather than listed here, so a
 * new `if (env.X && !env.Y)` guard fails this test until some doc says the two
 * knobs travel together.
 */

const ROOT = resolve(import.meta.dirname, '../../../..');
const ENV_TS = resolve(ROOT, 'api/src/env.ts');

/** Docs an operator reads while writing `.env`, in the order to look for a home. */
const DOCS = ['docs/INSTALL.md', 'docs/LOGIN.md', 'docs/ADMIN.md', 'docs/interface-api.md'];

/** `[trigger, required]` for each `if (env.X && !env.Y)` guard in the refinement. */
const conditionalPairs = (): [string, string][] => {
  const src = readFileSync(ENV_TS, 'utf8');
  const start = src.indexOf('.superRefine(');
  expect(start).toBeGreaterThan(-1);
  const body = src.slice(start);
  const guards = body.matchAll(/if \(env\.([A-Z][A-Z0-9_]*) && !env\.([A-Z][A-Z0-9_]*)\)/g);
  return [...guards].map((m) => [m[1]!, m[2]!]);
};

/**
 * One block per leaf bullet. A nested list groups every WebAuthn knob under one
 * parent bullet, so splitting on the list rather than on the bullet would let a
 * sibling three lines away stand in for the coupling. Prose splits on blank
 * lines, and a bullet keeps its continuation lines.
 */
const blocks = (doc: string): string[] => {
  const out: string[] = [];
  let current = '';
  for (const line of doc.split('\n')) {
    const starts = /^\s*(?:[-*+]|\d+\.) /.test(line);
    if (starts || line.trim() === '') {
      if (current) out.push(current);
      current = starts ? line : '';
    } else {
      current = current ? `${current}\n${line}` : line;
    }
  }
  if (current) out.push(current);
  return out;
};

/** Docs with a single block naming both knobs. `\b` keeps `KEY` off `KEYS`. */
const docsCoupling = (a: string, b: string, docs: string[] = DOCS): string[] =>
  docs.filter((rel) =>
    blocks(readFileSync(resolve(ROOT, rel), 'utf8')).some(
      (block) => new RegExp(`\\b${a}\\b`).test(block) && new RegExp(`\\b${b}\\b`).test(block),
    ),
  );

describe('env.ts conditional requirements are documented', () => {
  // Pins the extraction, so a regex that quietly stops matching the guards
  // cannot turn the check below into a loop over an empty list.
  it('reads every conditional pair out of the superRefine body', () => {
    const pairs = conditionalPairs();
    expect(pairs).toContainEqual(['AUTH_RUNNER_URL', 'AUTH_RUNNER_SHARED_SECRET']);
    expect(pairs).toContainEqual(['ADMIN_WEBAUTHN_RP_ID', 'ADMIN_WEBAUTHN_ORIGIN']);
    expect(pairs.length).toBeGreaterThanOrEqual(2);

    expect(blocks('- a `X` b\n  - c `Y` d\n\nprose').length).toBe(3);
  });

  it('names both knobs of each pair in one bullet of an operator doc', () => {
    const undocumented = conditionalPairs().filter(
      ([trigger, required]) => docsCoupling(trigger, required).length === 0,
    );

    // Each entry is a pair that stops the API from booting while every doc
    // still describes the trigger as an independent knob: say in the bullet
    // documenting the trigger that the other one is required with it.
    expect(undocumented).toEqual([]);
  });

  it('states the WebAuthn coupling in each doc that documents the RP ID', () => {
    // The generic check above is satisfied by one doc; an operator reads
    // whichever of these three they landed on, so all three have to say it.
    const docs = ['docs/LOGIN.md', 'docs/ADMIN.md', 'docs/interface-api.md'];
    const silent = docs.filter(
      (rel) => docsCoupling('ADMIN_WEBAUTHN_RP_ID', 'ADMIN_WEBAUTHN_ORIGIN', [rel]).length === 0,
    );

    expect(silent).toEqual([]);
  });

  it('names both encryption keys of the either-or issue in one bullet', () => {
    // Not an `if (env.X && !env.Y)` guard: the refinement fails when neither
    // key is set, so the doc has to name both alternatives together.
    const src = readFileSync(ENV_TS, 'utf8');
    expect(src).toMatch(/env\.ENCRYPTION_ACTIVE_KEY \?\? env\.AUTH_ENCRYPTION_KEY/);

    expect(docsCoupling('ENCRYPTION_ACTIVE_KEY', 'AUTH_ENCRYPTION_KEY')).not.toEqual([]);
  });
});
