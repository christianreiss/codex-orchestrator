import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * `docs/contracts/README.md` closes by naming, per published schema, the
 * integration suite that validates it against a live response body. Nothing
 * held that claim: `api/test/contract/contract.test.ts` pins the doc's
 * `Current schemas:` bullets and the coverage table of its own README, but a
 * deleted `assertContract` line or a renamed suite would leave a schema
 * documented as live-checked with nothing checking it, and the gate would stay
 * green.
 *
 * Both sides are read as text and compared in both directions: the doc may not
 * name a suite or a call that is not there, and no `assertContract` call site
 * under `test/integration/` may go unattributed.
 */

const CONTRACT_ROOT = resolve(import.meta.dirname, '../../../../docs/contracts');
/** The `assertContract` bullet list of `docs/contracts/README.md`. */
const CONTRACT_DOC = resolve(CONTRACT_ROOT, 'README.md');
const INTEGRATION_ROOT = resolve(import.meta.dirname, '../../integration');
/** The doc names its suites bare; they all sit beside the host-facing routes. */
const DOC_SUITE_DIR = 'host-api';

/** The bullet that opens the schema → suite list. */
const ASSERTION_LIST =
  '- Every schema is checked against a representative live response body via `assertContract`';
/** A nested bullet: the schemas covered, an em dash, then the suite covering them. */
const ASSERTION_BULLET = /^\s+- (.+) — `([^`]+\.test\.ts)`$/;
const SCHEMA_NAME = /`([^`]+\.schema\.json)`/g;
/** An `assertContract` call naming its schema literally, as every call site does. */
const CALL_SITE = /assertContract\(\s*'([^']+\.schema\.json)'/g;
const ANY_CALL = /assertContract\(/g;

interface Pair {
  schema: string;
  /** Suite path relative to `test/integration/`, so both sides compare alike. */
  suite: string;
}

/** `schema -> suite`, the form every failure below reports. */
const label = ({ schema, suite }: Pair): string => `${schema} -> ${suite}`;

/** Every published schema, read off `docs/contracts/`. */
const contractSchemas = readdirSync(CONTRACT_ROOT)
  .filter((entry) => entry.endsWith('.schema.json'))
  .sort();

/** Schema → suite, as the doc's `assertContract` bullets attribute them. */
function collectDocPairs(): Pair[] {
  const out: Pair[] = [];
  let inList = false;
  for (const line of readFileSync(CONTRACT_DOC, 'utf8').split('\n')) {
    if (line.startsWith(ASSERTION_LIST)) {
      inList = true;
      continue;
    }
    if (!inList) continue;
    const bullet = ASSERTION_BULLET.exec(line);
    if (!bullet) break; // the list ends at the first line that is not a nested bullet
    for (const schema of bullet[1]!.matchAll(SCHEMA_NAME)) {
      out.push({ schema: schema[1]!, suite: `${DOC_SUITE_DIR}/${bullet[2]!}` });
    }
  }
  return out;
}

/** Every `*.test.ts` under `test/integration/`, relative to it. */
function collectSuites(dir: string, prefix = ''): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...collectSuites(resolve(dir, entry.name), rel));
    else if (entry.name.endsWith('.test.ts')) out.push(rel);
  }
  return out.sort();
}

const docPairs = collectDocPairs();
const integrationSuites = collectSuites(INTEGRATION_ROOT);

/** Suites holding an `assertContract` call the regex above could not read. */
const looseCallSites: string[] = [];

/** Schema → suite, as the `assertContract` call sites actually stand. */
function collectCallSites(): Pair[] {
  const out: Pair[] = [];
  for (const suite of integrationSuites) {
    const source = readFileSync(resolve(INTEGRATION_ROOT, suite), 'utf8');
    const calls = [...source.matchAll(CALL_SITE)];
    // A call built from a variable would hide from the scan below.
    if (calls.length !== [...source.matchAll(ANY_CALL)].length) looseCallSites.push(suite);
    for (const call of calls) out.push({ schema: call[1]!, suite });
  }
  return out;
}

const callSites = collectCallSites();

const unique = (pairs: Pair[]): string[] => [...new Set(pairs.map(label))].sort();

describe('docs/contracts/README.md assertContract list', () => {
  it('reads the list it is meant to check', () => {
    // A scan that silently matched nothing would pass the assertions below.
    expect(docPairs.length, `${CONTRACT_DOC} has no assertContract bullets`).toBeGreaterThan(0);
    expect(callSites.length, 'no assertContract call site under test/integration/').toBeGreaterThan(0);
    expect(looseCallSites, 'assertContract is called with a schema this scan cannot read').toEqual([]);
  });

  it('names suites that exist under test/integration/host-api/', () => {
    for (const pair of docPairs) {
      expect(existsSync(resolve(INTEGRATION_ROOT, pair.suite)), `${label(pair)}: no such suite`).toBe(
        true,
      );
    }
  });

  it('names a suite that really asserts each schema it is credited with', () => {
    for (const pair of docPairs) {
      const source = readFileSync(resolve(INTEGRATION_ROOT, pair.suite), 'utf8');
      expect(
        source.includes(`assertContract('${pair.schema}'`),
        `${label(pair)}: the suite has no such assertContract call`,
      ).toBe(true);
    }
  });

  it('credits a suite for every published schema', () => {
    const listed = [...new Set(docPairs.map((pair) => pair.schema))].sort();
    expect(listed, 'the assertContract bullets and docs/contracts/ disagree').toEqual(contractSchemas);
  });

  it('attributes every assertContract call site under test/integration/', () => {
    expect(unique(callSites), 'the assertContract bullets and the call sites disagree').toEqual(
      unique(docPairs),
    );
  });
});
