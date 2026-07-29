import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { VALID_ACCESS_LEVELS } from '../../../src/services/admin-auth.js';

/**
 * The admin UI keeps its own copy of the role list, and nothing compared it
 * with the server's until now. The drift it grew was user-visible and silent:
 * `USER_ROLES` was missing `owner` and `viewer`, so the edit dialog seeded its
 * role select from a list those rows were absent from and saving an owner
 * rewrote them to `user` — and `userSchema`'s `z.enum(USER_ROLES)` rejected
 * their own current role on the way out.
 *
 * Both frontend files sit outside the api tsconfig, so their lists are parsed
 * out as text; the API side is imported for its real value. Membership only,
 * in both directions — order is the picker's business, and the server's list
 * puts the legacy roles last on purpose.
 */

const TYPES_FILE = 'frontend/src/lib/api/types.ts';
const SCHEMA_FILE = 'frontend/src/lib/components/users/userSchema.ts';
const REPO_ROOT = resolve(import.meta.dirname, '../../../..');

/** Blank out whole-line comments, keeping every other character at its offset. */
const blankComments = (source: string): string =>
  source
    .split('\n')
    .map((line) => (/^\s*(\/\/|\*|\/\*)/.test(line) ? ' '.repeat(line.length) : line))
    .join('\n');

const read = (file: string): string => blankComments(readFileSync(resolve(REPO_ROOT, file), 'utf8'));

const typesSource = read(TYPES_FILE);
const schemaSource = read(SCHEMA_FILE);

/**
 * Body of the array literal `export const <name>` is assigned. Brackets are
 * counted without regard for quotes, which is enough: no role id or label in
 * either file carries a bracket inside a string literal.
 */
const arrayBody = (source: string, file: string, name: string): string => {
  const declaration = new RegExp(`\\bexport const ${name}\\b[^=]*=\\s*\\[`).exec(source);
  if (!declaration) throw new Error(`${name} array not found in ${file}`);
  const open = declaration.index + declaration[0].length - 1;
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === '[') depth += 1;
    else if (source[i] === ']' && (depth -= 1) === 0) return source.slice(open + 1, i);
  }
  throw new Error(`unterminated ${name} array in ${file}`);
};

const STRING_LITERAL = /(?:'([^']*)'|"([^"]*)")/g;
const OPTION_VALUE = /\bvalue\s*:\s*(?:'([^']*)'|"([^"]*)")/g;

/** Every bare string literal of a list, i.e. the `USER_ROLES` members. */
const userRoles = (): string[] =>
  [...arrayBody(typesSource, TYPES_FILE, 'USER_ROLES').matchAll(STRING_LITERAL)].map(
    (literal) => literal[1] ?? literal[2]!,
  );

/** `value` of every `{ value, label }` entry of `ROLE_OPTIONS`. */
const roleOptions = (): string[] =>
  [...arrayBody(schemaSource, SCHEMA_FILE, 'ROLE_OPTIONS').matchAll(OPTION_VALUE)].map(
    (option) => option[1] ?? option[2]!,
  );

const USER_ROLES = userRoles();
const ROLE_OPTIONS = roleOptions();
/** Widened off the literal tuple so it compares against parsed strings. */
const SERVER_ROLES: readonly string[] = VALID_ACCESS_LEVELS;

const duplicates = (values: string[]): string[] =>
  values.filter((value, index) => values.indexOf(value) !== index);

describe('frontend user roles', () => {
  it('extracts the role lists it is meant to compare', () => {
    // A parser reading nothing — after a rename of a file or of a constant —
    // would pass every comparison below vacuously.
    expect(USER_ROLES, TYPES_FILE).not.toEqual([]);
    expect(ROLE_OPTIONS, SCHEMA_FILE).not.toEqual([]);
    expect(USER_ROLES).toContain('owner');
    expect(ROLE_OPTIONS).toContain('fleet_operator');
  });

  it('lists exactly the access levels the API accepts', () => {
    const drift = [
      ...USER_ROLES.filter((role) => !SERVER_ROLES.includes(role)).map(
        (role) => `USER_ROLES lists "${role}", which VALID_ACCESS_LEVELS does not accept`,
      ),
      ...SERVER_ROLES.filter((role) => !USER_ROLES.includes(role)).map(
        (role) => `VALID_ACCESS_LEVELS accepts "${role}", which USER_ROLES does not list`,
      ),
    ];
    expect(
      drift,
      `update ${TYPES_FILE} to match VALID_ACCESS_LEVELS in api/src/services/admin-auth.ts`,
    ).toEqual([]);
    expect(duplicates(USER_ROLES), `${TYPES_FILE} repeats a role`).toEqual([]);
  });

  it('offers one role option per member', () => {
    const drift = [
      ...ROLE_OPTIONS.filter((role) => !USER_ROLES.includes(role)).map(
        (role) => `ROLE_OPTIONS offers "${role}", which USER_ROLES does not list`,
      ),
      ...USER_ROLES.filter((role) => !ROLE_OPTIONS.includes(role)).map(
        (role) => `USER_ROLES lists "${role}", which ROLE_OPTIONS does not offer`,
      ),
    ];
    expect(
      drift,
      `every USER_ROLES member needs an option in ${SCHEMA_FILE}: a role missing from the ` +
        'picker is one the edit dialog cannot preserve',
    ).toEqual([]);
    expect(duplicates(ROLE_OPTIONS), `${SCHEMA_FILE} repeats a role`).toEqual([]);
  });
});
