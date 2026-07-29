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
 * `frontend/src/lib/constants/models.ts` claims lock-step with five API
 * constants in comments only. The comment on CLAUDE_MODEL_OPTIONS spells out the
 * failure mode: an id outside CLAUDE_SUPPORTED_MODELS is one the picker happily
 * pins a host to and `resolveRequestedModel` then 400s at inference time. The
 * permission modes fail the same way one layer down — a `defaultMode` outside
 * the CLI's choice set is dropped by `normalizeClaudePermissionMode`, so the
 * host silently keeps the fleet default the operator meant to change.
 *
 * The file sits outside the api tsconfig, so it is parsed as text the way
 * `test/unit/ws/event-invalidation-coverage.test.ts` parses
 * `frontend/src/lib/ws/events.ts`; the API side is imported for its real value.
 * Each pair is compared as a set — order is a picker concern, and the Codex
 * lists already order their ids differently on purpose.
 */

const MODELS_FILE = 'frontend/src/lib/constants/models.ts';
const MODELS_PATH = resolve(import.meta.dirname, '../../../..', MODELS_FILE);

/**
 * Ids one side carries on purpose without the other, keyed `<constant>.<id>`
 * with the reason. Empty today — every list agrees. An entry belongs here only
 * for a deliberate delta, e.g. an id the inference gate still accepts so
 * already-pinned hosts keep working but the picker no longer offers.
 */
const DELIBERATE_DELTAS: Record<string, string> = {};

/**
 * Blank out whole-line comments, keeping every other character at its offset.
 * Every comment in the file is whole-line, and the prose in them mentions the
 * very constant names and ids the parse below looks for.
 */
const blankComments = (source: string): string =>
  source
    .split('\n')
    .map((line) => (/^\s*(\/\/|\*|\/\*)/.test(line) ? ' '.repeat(line.length) : line))
    .join('\n');

const source = blankComments(readFileSync(MODELS_PATH, 'utf8'));

/** Index of the `]`/`}`/`)` closing the bracket at `open`, or -1. */
function matchingBracket(text: string, open: number): number {
  let depth = 0;
  let quote: string | null = null;
  for (let i = open; i < text.length; i++) {
    const c = text[i]!;
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') quote = c;
    else if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Split on the top-level commas of an array or object-literal body. */
function splitTopLevel(body: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let start = 0;
  for (let i = 0; i < body.length; i++) {
    const c = body[i]!;
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') quote = c;
    else if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    else if (depth === 0 && c === ',') {
      parts.push(body.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(body.slice(start));
  return parts.filter((part) => part.trim() !== '');
}

/** Body of the array literal `export const <name>` is assigned. */
function arrayBody(name: string): string {
  const declaration = new RegExp(`\\bexport const ${name}\\b[^=]*=\\s*\\[`).exec(source);
  if (!declaration) throw new Error(`${name} array not found in ${MODELS_FILE}`);
  const open = declaration.index + declaration[0].length - 1;
  const close = matchingBracket(source, open);
  if (close === -1) throw new Error(`unterminated ${name} array in ${MODELS_FILE}`);
  return source.slice(open + 1, close);
}

/** Literal of a top-level string const, e.g. the ADVISOR_OFF sentinel. */
function stringConst(name: string): string {
  const pattern = new RegExp(`\\bexport const ${name}\\b[^=]*=\\s*(?:'([^']*)'|"([^"]*)")`);
  const declaration = pattern.exec(source);
  if (!declaration) throw new Error(`${name} string const not found in ${MODELS_FILE}`);
  return declaration[1] ?? declaration[2]!;
}

const VALUE_KEY = /^\s*value\s*:/;

/** The `value` expression of one `{ label, value }` option literal. */
function optionValue(entry: string): string {
  const trimmed = entry.trim();
  const close = trimmed.startsWith('{') ? matchingBracket(trimmed, 0) : -1;
  if (close === -1) throw new Error(`option is not an object literal in ${MODELS_FILE}: ${trimmed}`);
  for (const property of splitTopLevel(trimmed.slice(1, close))) {
    const key = VALUE_KEY.exec(property);
    if (key) return property.slice(key[0].length).trim();
  }
  throw new Error(`option without a value in ${MODELS_FILE}: ${trimmed}`);
}

const STRING_LITERAL = /^(['"])(.*)\1$/s;

/**
 * `value` of every option of an array literal. A value written as an identifier
 * is a sentinel const of the same file (`value: ADVISOR_OFF`), resolved to its
 * literal so a sentinel that stops being a sentinel is still compared.
 */
const optionValues = (name: string): string[] =>
  splitTopLevel(arrayBody(name)).map((entry) => {
    const expression = optionValue(entry);
    const quoted = STRING_LITERAL.exec(expression);
    return quoted ? quoted[2]! : stringConst(expression);
  });

const ADVISOR_OFF = stringConst('ADVISOR_OFF');

interface Catalog {
  /** Frontend constant under test. */
  constant: string;
  /** API constant it must agree with, named in the failure message. */
  api: string;
  /** Values parsed out of the frontend file. */
  frontend: string[];
  /** The API's own list. */
  server: readonly string[];
}

const CATALOGS: Catalog[] = [
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
];

/** The catalog's values minus any deliberate delta, as a comparable set. */
const compared = ({ constant }: Catalog, values: readonly string[]): string[] =>
  values.filter((value) => !(`${constant}.${value}` in DELIBERATE_DELTAS)).sort();

describe('frontend model catalog parity', () => {
  it('extracts the option lists it is meant to compare', () => {
    // A parser reading nothing — after a rename of the file or of a constant —
    // would pass every comparison below vacuously.
    for (const { constant, frontend } of CATALOGS) expect(frontend, constant).not.toEqual([]);
    expect(optionValues('CLAUDE_MODEL_OPTIONS')).toContain('claude-sonnet-5');
    expect(optionValues('CODEX_MODELS')).toContain('gpt-5.6-terra');
    expect(optionValues('CLAUDE_PERMISSION_MODES')).toContain('bypassPermissions');
    // The sentinel is resolved through its identifier, then dropped.
    expect(optionValues('ADVISOR_MODELS')).toContain(ADVISOR_OFF);
    expect(CATALOGS.find((catalog) => catalog.constant === 'ADVISOR_MODELS')?.frontend).not.toContain(
      ADVISOR_OFF,
    );
  });

  it('offers exactly the ids the API accepts', () => {
    for (const catalog of CATALOGS) {
      expect(
        compared(catalog, catalog.frontend),
        `${catalog.constant} in ${MODELS_FILE} must offer exactly ${catalog.api} — update the ` +
          'frontend list, or record the delta in DELIBERATE_DELTAS here with a reason',
      ).toEqual(compared(catalog, catalog.server));
    }
  });

  it('defaults the permission mode to the same value as the API', () => {
    expect(
      stringConst('DEFAULT_CLAUDE_PERMISSION_MODE'),
      `DEFAULT_CLAUDE_PERMISSION_MODE in ${MODELS_FILE} must equal the API's — the settings form ` +
        'seeds its picker from it, so a stale value shows the wrong mode as active',
    ).toBe(DEFAULT_CLAUDE_PERMISSION_MODE);
  });

  it('keeps the allowlist to deltas that still exist', () => {
    const stale = Object.keys(DELIBERATE_DELTAS).filter((entry) => {
      const catalog = CATALOGS.find(({ constant }) => entry.startsWith(`${constant}.`));
      if (!catalog) return true;
      // Constants carry no dot, ids do (`gpt-5.6-terra`), so the first one splits.
      const id = entry.slice(entry.indexOf('.') + 1);
      return catalog.frontend.includes(id) === catalog.server.includes(id);
    });
    expect(stale, 'drop the allowlist entry: the id is gone or both sides agree on it').toEqual([]);
  });
});
