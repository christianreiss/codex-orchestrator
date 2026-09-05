import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { CLAUDE_SUPPORTED_MODELS } from '../../../src/services/claude-models.js';
import {
  ADVISOR_MODEL_ALIASES,
  CLAUDE_PERMISSION_MODES,
  DEFAULT_CLAUDE_PERMISSION_MODE,
  SUPPORTED_MODELS,
} from '../../../src/services/config-normalizer.js';

/**
 * The pickers in `frontend/src/lib/constants/models.ts` declare their lock-step
 * with the API constants in comments only: `frontend.check` typechecks the file
 * and nothing else reads it, so the lists agreeing is luck. The consequence is
 * user-visible — a Claude id outside CLAUDE_SUPPORTED_MODELS pins a host to a
 * model `resolveRequestedModel` 400s at inference time, and a permission mode
 * outside CLAUDE_PERMISSION_MODES writes a `defaultMode` the upstream CLI drops.
 *
 * This parses the option `value`s out of the frontend file as text (it is
 * outside the api tsconfig, so it cannot be imported) and compares each list
 * with the API constant it names. Membership only: order is a picker concern,
 * and the Codex lists already order their ids differently on purpose.
 */

const MODELS_FILE = 'frontend/src/lib/constants/models.ts';
const MODELS_PATH = resolve(import.meta.dirname, '../../../..', MODELS_FILE);

/**
 * Ids one side carries on purpose without the other, keyed `<constant>.<id>`
 * with the reason. Empty today — every list agrees. An entry belongs here only
 * for a deliberate delta, e.g. an id the inference gate still accepts for
 * already-pinned hosts but the picker no longer offers.
 */
const ALLOWED: Record<string, string> = {};

/** Blank out whole-line comments, keeping every other character at its offset. */
const blankComments = (source: string): string =>
  source
    .split('\n')
    .map((line) => (/^\s*(\/\/|\*|\/\*)/.test(line) ? ' '.repeat(line.length) : line))
    .join('\n');

const source = blankComments(readFileSync(MODELS_PATH, 'utf8'));

/**
 * Body of the array literal `export const <name>` is assigned. Brackets are
 * counted without regard for quotes, which is enough: no label or value in the
 * file carries a bracket inside a string literal.
 */
const arrayBody = (name: string): string => {
  const declaration = new RegExp(`\\bexport const ${name}\\b[^=]*=\\s*\\[`).exec(source);
  if (!declaration) throw new Error(`${name} array not found in ${MODELS_FILE}`);
  const open = declaration.index + declaration[0].length - 1;
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === '[') depth += 1;
    else if (source[i] === ']' && (depth -= 1) === 0) return source.slice(open + 1, i);
  }
  throw new Error(`unterminated ${name} array in ${MODELS_FILE}`);
};

/** Literal of a top-level string const, e.g. the ADVISOR_OFF sentinel. */
const stringConst = (name: string): string => {
  const pattern = new RegExp(`\\bexport const ${name}\\b[^=]*=\\s*(?:'([^']*)'|"([^"]*)")`);
  const declaration = pattern.exec(source);
  if (!declaration) throw new Error(`${name} string const not found in ${MODELS_FILE}`);
  return declaration[1] ?? declaration[2]!;
};

const OPTION_VALUE = /\bvalue\s*:\s*(?:'([^']*)'|"([^"]*)"|([A-Za-z_$][\w$]*))/g;

/**
 * `value` of every option of an array literal. A value written as an identifier
 * is a sentinel const of the same file (`value: ADVISOR_OFF`), resolved to its
 * literal so a sentinel that stops being a sentinel is still compared.
 */
const optionValues = (name: string): string[] =>
  [...arrayBody(name).matchAll(OPTION_VALUE)].map(
    (option) => option[1] ?? option[2] ?? stringConst(option[3]!),
  );

const ADVISOR_OFF = stringConst('ADVISOR_OFF');

interface Check {
  /** Frontend constant under test. */
  constant: string;
  /** API constant it must agree with, named in the failure message. */
  api: string;
  /** Values parsed out of the frontend file. */
  frontend: string[];
  /** The API's own list. */
  server: readonly string[];
}

const CHECKS: Check[] = [
  {
    constant: 'CLAUDE_MODEL_OPTIONS',
    api: 'CLAUDE_SUPPORTED_MODELS (api/src/services/claude-models.ts)',
    frontend: optionValues('CLAUDE_MODEL_OPTIONS'),
    server: CLAUDE_SUPPORTED_MODELS,
  },
  {
    constant: 'CODEX_MODELS',
    api: 'SUPPORTED_MODELS (api/src/services/config-normalizer.ts)',
    frontend: optionValues('CODEX_MODELS'),
    server: SUPPORTED_MODELS,
  },
  {
    constant: 'ADVISOR_MODELS',
    api: 'ADVISOR_MODEL_ALIASES (api/src/services/config-normalizer.ts)',
    // The "off" sentinel means "omit advisorModel on save"; it is never stored.
    frontend: optionValues('ADVISOR_MODELS').filter((value) => value !== ADVISOR_OFF),
    server: ADVISOR_MODEL_ALIASES,
  },
  {
    constant: 'CLAUDE_PERMISSION_MODES',
    api: 'CLAUDE_PERMISSION_MODES (api/src/services/config-normalizer.ts)',
    frontend: optionValues('CLAUDE_PERMISSION_MODES'),
    server: CLAUDE_PERMISSION_MODES,
  },
  {
    // A scalar, compared as a one-element list so it drifts, allowlists and
    // reports like the others.
    constant: 'DEFAULT_CLAUDE_PERMISSION_MODE',
    api: 'DEFAULT_CLAUDE_PERMISSION_MODE (api/src/services/config-normalizer.ts)',
    frontend: [stringConst('DEFAULT_CLAUDE_PERMISSION_MODE')],
    server: [DEFAULT_CLAUDE_PERMISSION_MODE],
  },
];

describe('frontend model constants', () => {
  it('extracts the option lists it is meant to compare', () => {
    // A parser reading nothing — after a rename of the file or of a constant —
    // would pass every comparison below vacuously.
    for (const { constant, frontend } of CHECKS) expect(frontend, constant).not.toEqual([]);
    expect(optionValues('CLAUDE_MODEL_OPTIONS')).toContain('claude-sonnet-5');
    expect(optionValues('CODEX_MODELS')[0]).toBe('gpt-6-astra');
    expect(optionValues('CLAUDE_PERMISSION_MODES')).toContain('bypassPermissions');
    // The sentinel is resolved through its identifier, then dropped.
    expect(optionValues('ADVISOR_MODELS')).toContain(ADVISOR_OFF);
    expect(CHECKS.find((check) => check.constant === 'ADVISOR_MODELS')?.frontend).not.toContain(
      ADVISOR_OFF,
    );
  });

  it('offers exactly the ids the API accepts', () => {
    const drift = CHECKS.flatMap(({ constant, api, frontend, server }) => [
      ...frontend
        .filter((id) => !server.includes(id) && !(`${constant}.${id}` in ALLOWED))
        .map((id) => `${constant} offers "${id}", which ${api} does not list`),
      ...server
        .filter((id) => !frontend.includes(id) && !(`${constant}.${id}` in ALLOWED))
        .map((id) => `${api} lists "${id}", which ${constant} does not offer`),
    ]);
    expect(
      drift,
      `update ${MODELS_FILE} to match the API, or record the delta in ALLOWED here with a reason`,
    ).toEqual([]);
  });

  it('keeps the allowlist to deltas that still exist', () => {
    const stale = Object.keys(ALLOWED).filter((entry) => {
      const check = CHECKS.find(({ constant }) => entry.startsWith(`${constant}.`));
      if (!check) return true;
      // Constants carry no dot, ids do (`gpt-5.6-terra`), so the first one splits.
      const id = entry.slice(entry.indexOf('.') + 1);
      return check.frontend.includes(id) === check.server.includes(id);
    });
    expect(stale, 'drop the allowlist entry: the id is gone or both sides agree on it').toEqual([]);
  });
});
