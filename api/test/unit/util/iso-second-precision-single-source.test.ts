import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * `util/timestamp.ts` owns the legacy second-precision ISO format the DB
 * columns and the wrappers expect — `nowIso` and `isoOffsetSeconds` are the
 * only two places that strip the milliseconds. Hand-rolled copies of the same
 * `.replace(/\.\d{3}Z$/, 'Z')` expression compile and pass, so a new one drifts
 * out of the shared format silently and survives a precision change nobody
 * applies to it.
 *
 * This scan reads every module under `api/src` and fails when the
 * millisecond-stripping regex appears outside `OWNER`.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const API_SRC = resolve(HERE, '../../../src');
/** The module allowed to implement the format. */
const OWNER = 'util/timestamp.ts';

/**
 * Modules that may keep their own copy. Empty on purpose — an addition here is
 * a deliberate decision to let a second implementation of the format exist.
 */
const ALLOWLIST: string[] = [];

/** The millisecond-stripping regex literal, matched as source text. */
const STRIP_MILLIS = /\/\\\.\\d\{3\}Z\$\//;

function sourceFiles(): string[] {
  return readdirSync(API_SRC, { recursive: true, encoding: 'utf8' })
    .filter((file) => file.endsWith('.ts'))
    .sort();
}

describe('second-precision ISO format', () => {
  it('is implemented only in util/timestamp.ts', () => {
    const copies = sourceFiles().filter(
      (file) =>
        file !== OWNER &&
        !ALLOWLIST.includes(file) &&
        STRIP_MILLIS.test(readFileSync(join(API_SRC, file), 'utf8')),
    );
    expect(copies, 'call isoOffsetSeconds()/nowIso() from util/timestamp.js instead').toEqual([]);
  });

  it('still finds the implementation it guards', () => {
    expect(STRIP_MILLIS.test(readFileSync(join(API_SRC, OWNER), 'utf8'))).toBe(true);
  });
});
