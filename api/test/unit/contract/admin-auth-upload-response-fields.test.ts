import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * `UploadAuthResponse` is what the admin UI believes `POST /admin/auth/upload`
 * returns, and it declared two fields the route cannot emit: `queued`, borrowed
 * from the seed-command envelope, and `filename`, from a multipart upload that
 * never existed. Both invite a consumer to branch on data that never arrives.
 *
 * The route returns the members of `StoreAuthCandidateResult` plus the literal
 * keys it adds itself. The frontend file sits outside the api tsconfig, so all
 * three sides are read as text: a member with no counterpart fails here rather
 * than becoming dead UI logic.
 */

const CLIENT_FILE = 'frontend/src/lib/api/auth.ts';
const STORE_FILE = 'api/src/services/canonical-auth-store.ts';
const ROUTE_FILE = 'api/src/routes/admin/overview/index.ts';
const REPO_ROOT = resolve(import.meta.dirname, '../../../..');

/**
 * Members `UploadAuthResponse` may declare that the upload route does not emit.
 * Empty by design: the point of this test is that there are none. An entry here
 * is a documented lie about the response and needs a reason beside it.
 */
const ALLOWED_UNEMITTED: readonly string[] = [];

/** Blank out whole-line comments, keeping every other character at its offset. */
const blankComments = (source: string): string =>
  source
    .split('\n')
    .map((line) => (/^\s*(\/\/|\*|\/\*)/.test(line) ? ' '.repeat(line.length) : line))
    .join('\n');

const read = (file: string): string => blankComments(readFileSync(resolve(REPO_ROOT, file), 'utf8'));

/**
 * Body of the object/interface literal whose opening brace `declaration` ends
 * on. Braces are counted without regard for quotes, which is enough: none of
 * the three declarations puts one inside a string.
 */
const bracedBody = (source: string, file: string, name: string, declaration: RegExp): string => {
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

/** Property names declared at the top level of an interface body. */
const interfaceMembers = (file: string, name: string): string[] => {
  const body = bracedBody(read(file), file, name, new RegExp(`\\binterface\\s+${name}\\s*\\{`));
  return [...body.matchAll(/^ {2}([A-Za-z0-9_]+)\??:/gm)].map((property) => property[1]!);
};

/** The `...spread` and `key:` entries the upload handler's `return ok({ … })` builds. */
const uploadResponseEntries = (): { spreads: string[]; keys: string[] } => {
  const source = read(ROUTE_FILE);
  const handler = source.indexOf("app.post('/admin/auth/upload'");
  if (handler < 0) throw new Error(`no POST /admin/auth/upload handler in ${ROUTE_FILE}`);
  const rest = source.slice(handler);
  expect(rest, `${ROUTE_FILE} no longer spreads a storeCandidate result`).toContain(
    'const stored = await authStore.storeCandidate(',
  );
  const body = bracedBody(rest, ROUTE_FILE, 'the upload response', /return ok\(\{/);
  const spreads: string[] = [];
  const keys: string[] = [];
  for (const line of body.split('\n')) {
    const spread = /^\s*\.\.\.([A-Za-z0-9_]+),?\s*$/.exec(line);
    if (spread) spreads.push(spread[1]!);
    const key = /^\s*([A-Za-z0-9_]+):/.exec(line);
    if (key) keys.push(key[1]!);
  }
  return { spreads, keys };
};

const CLIENT_MEMBERS = interfaceMembers(CLIENT_FILE, 'UploadAuthResponse');
const STORE_MEMBERS = interfaceMembers(STORE_FILE, 'StoreAuthCandidateResult');
const RESPONSE = uploadResponseEntries();

describe('admin auth upload response fields', () => {
  it('extracts the three declarations it is meant to compare', () => {
    // A parser reading nothing — after a rename or a moved route — would pass
    // the comparison below vacuously.
    expect(CLIENT_MEMBERS, CLIENT_FILE).toContain('received');
    expect(STORE_MEMBERS, STORE_FILE).toEqual(
      expect.arrayContaining(['status', 'canonical_digest', 'verification_state', 'engine']),
    );
    expect(RESPONSE.spreads, `${ROUTE_FILE} upload response`).toEqual(['stored']);
    expect(RESPONSE.keys, `${ROUTE_FILE} upload response`).toEqual(['received', 'size']);
  });

  it('declares only members the upload route emits', () => {
    const emitted = new Set([...STORE_MEMBERS, ...RESPONSE.keys]);
    const unemitted = CLIENT_MEMBERS.filter(
      (member) => !emitted.has(member) && !ALLOWED_UNEMITTED.includes(member),
    );
    expect(
      unemitted,
      `UploadAuthResponse in ${CLIENT_FILE} declares fields POST /admin/auth/upload never ` +
        `returns; it emits StoreAuthCandidateResult (${STORE_FILE}) plus ${RESPONSE.keys.join(', ')}`,
    ).toEqual([]);
  });
});
