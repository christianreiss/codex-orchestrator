import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * The admin user dialog validates before it submits, and a field it treats as
 * optional while the create route demands one is a form that passes its own
 * checks and comes back a 400: `name` and `email` were both `.optional()` on
 * the client while `POST /admin/users` parsed them as required strings and
 * `AdminUsersService.create` threw on a blank one.
 *
 * Both schemas are declared, not exported values a test can compare, and the
 * frontend file sits outside the api tsconfig — so each is parsed out as text.
 * Only the direction that produces the failed submit is checked: a field the
 * route requires may not be optional on the client. The client is free to ask
 * for more (`password_confirm` has no server counterpart).
 */

const ROUTE_FILE = 'api/src/routes/admin/users/index.ts';
const SCHEMA_FILE = 'frontend/src/lib/components/users/userSchema.ts';
const REPO_ROOT = resolve(import.meta.dirname, '../../../..');

/** Blank out whole-line comments, keeping every other character at its offset. */
const blankComments = (source: string): string =>
  source
    .split('\n')
    .map((line) => (/^\s*(\/\/|\*|\/\*)/.test(line) ? ' '.repeat(line.length) : line))
    .join('\n');

const read = (file: string): string => blankComments(readFileSync(resolve(REPO_ROOT, file), 'utf8'));

const routeSource = read(ROUTE_FILE);
const schemaSource = read(SCHEMA_FILE);

/**
 * Body of the object literal whose opening brace `declaration` ends on. Braces
 * are counted without regard for quotes, which is enough: neither schema puts
 * one inside a string, and the `{3,64}` of a quantifier balances anyway.
 */
const objectBody = (source: string, file: string, name: string, declaration: RegExp): string => {
  const match = declaration.exec(source);
  if (!match) throw new Error(`${name} not found in ${file}`);
  const open = match.index + match[0].length - 1;
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}' && (depth -= 1) === 0) return source.slice(open + 1, i);
  }
  throw new Error(`unterminated ${name} in ${file}`);
};

/** The `key: value` (and `...spread`) entries at the top level of an object body. */
const topLevelEntries = (body: string): string[] => {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < body.length; i++) {
    const char = body[i]!;
    if ('([{'.includes(char)) depth += 1;
    else if (')]}'.includes(char)) depth -= 1;
    else if (char === ',' && depth === 0) {
      out.push(body.slice(start, i));
      start = i + 1;
    }
  }
  out.push(body.slice(start));
  return out.map((entry) => entry.trim()).filter((entry) => entry !== '');
};

/**
 * Field name -> its declaration text, following a `...spread` into the const of
 * that name in the same file (the client schema keeps its shared fields there).
 */
const schemaFields = (
  source: string,
  file: string,
  name: string,
  declaration: RegExp,
): Map<string, string> => {
  const fields = new Map<string, string>();
  for (const entry of topLevelEntries(objectBody(source, file, name, declaration))) {
    const spread = /^\.\.\.(\w+)$/.exec(entry);
    if (spread) {
      const shape = spread[1]!;
      for (const [field, value] of schemaFields(
        source,
        file,
        shape,
        new RegExp(`\\b${shape}\\s*=\\s*\\{`),
      )) {
        fields.set(field, value);
      }
      continue;
    }
    const field = /^(\w+)\s*:([\s\S]*)$/.exec(entry);
    if (!field) throw new Error(`unparsable entry in ${name} of ${file}: ${entry}`);
    fields.set(field[1]!, field[2]!);
  }
  return fields;
};

const ROUTE_CREATE = schemaFields(
  routeSource,
  ROUTE_FILE,
  'createSchema',
  /\bcreateSchema\s*=\s*z\s*\.object\(\s*\{/,
);
const CLIENT_CREATE = schemaFields(
  schemaSource,
  SCHEMA_FILE,
  'createUserSchema',
  /\bcreateUserSchema\s*=\s*z\s*\.object\(\s*\{/,
);

const isOptional = (declaration: string): boolean => /\.optional\(\)/.test(declaration);

const REQUIRED_BY_ROUTE = [...ROUTE_CREATE]
  .filter(([, declaration]) => !isOptional(declaration))
  .map(([field]) => field);

describe('frontend user form required fields', () => {
  it('extracts the two create schemas it is meant to compare', () => {
    // A parser reading nothing — after a rename of a file, a schema or the
    // shared shape — would pass the comparison below vacuously.
    expect([...ROUTE_CREATE.keys()], ROUTE_FILE).toContain('name');
    expect(REQUIRED_BY_ROUTE, ROUTE_FILE).toContain('email');
    expect(REQUIRED_BY_ROUTE, `${ROUTE_FILE} still parses "active" as optional`).not.toContain(
      'active',
    );
    // `username` only appears through the `...baseShape` spread.
    expect([...CLIENT_CREATE.keys()], SCHEMA_FILE).toEqual(
      expect.arrayContaining(['name', 'username', 'email', 'password']),
    );
  });

  it('asks for every field the create route requires', () => {
    const drift = REQUIRED_BY_ROUTE.flatMap((field) => {
      const declaration = CLIENT_CREATE.get(field);
      if (declaration === undefined) {
        return [`createUserSchema has no "${field}" field`];
      }
      return isOptional(declaration) ? [`createUserSchema marks "${field}" .optional()`] : [];
    });
    expect(
      drift,
      `${SCHEMA_FILE} must require what createSchema in ${ROUTE_FILE} parses as required: a ` +
        'field optional on the client is a form that validates and then 400s on submit',
    ).toEqual([]);
  });
});
