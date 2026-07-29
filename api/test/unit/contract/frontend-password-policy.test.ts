import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Database } from '../../../src/db/client.js';
import type { Env } from '../../../src/env.js';
import { AdminAuthService } from '../../../src/services/admin-auth.js';

/**
 * The admin UI states the password rule to the user and rejects what it thinks
 * the server would: a client minimum above the server's turns a valid password
 * into an inline error, one below it turns a 422 into a surprise. The frontend
 * now keeps a single `PASSWORD_MIN_LENGTH`, and this pins it to the server's.
 *
 * `PASSWORD_MIN_LENGTH` is module-private on the API side, so it is parsed out
 * as text and then checked against what the service actually reports; the
 * frontend file sits outside the api tsconfig and is only readable as text.
 */

const FRONTEND_FILE = 'frontend/src/lib/constants/password.ts';
const API_FILE = 'api/src/services/admin-auth.ts';
const REPO_ROOT = resolve(import.meta.dirname, '../../../..');

/** Value of `const <name> = <integer>;`, declared or exported. */
const minLength = (file: string, name: string): number => {
  const source = readFileSync(resolve(REPO_ROOT, file), 'utf8');
  const declaration = new RegExp(`^\\s*(?:export\\s+)?const ${name}\\s*=\\s*(\\d+)\\s*;`, 'm').exec(
    source,
  );
  if (!declaration) throw new Error(`${name} not found in ${file}`);
  return Number(declaration[1]);
};

const FRONTEND_MIN = minLength(FRONTEND_FILE, 'PASSWORD_MIN_LENGTH');
const API_MIN = minLength(API_FILE, 'PASSWORD_MIN_LENGTH');

describe('frontend password policy', () => {
  it('reads the minimum the API enforces', () => {
    // A parser reading a stale constant would pass the comparison below on a
    // value no request is ever validated against.
    expect(new AdminAuthService({} as Database, {} as Env).passwordMinLength()).toBe(API_MIN);
  });

  it('mirrors that minimum in the frontend', () => {
    expect(
      FRONTEND_MIN,
      `PASSWORD_MIN_LENGTH in ${FRONTEND_FILE} must equal the ${API_MIN} enforced in ${API_FILE}`,
    ).toBe(API_MIN);
  });
});
