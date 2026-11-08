import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { parseSourceBundle, planFileUpdates } from '../../../src/services/slop-jobs/source-bundle.js';
const bundle = (files: unknown[]) => Buffer.from(JSON.stringify({ version: 1, files }));
const source = (path = 'src/a.ts', content = 'one\r\ntwo\n') => ({ path, content });

describe('slop source bundles', () => {
  it('keeps UTF-8 bytes and newlines, normalizes paths and verifies optional hashes', () => {
    const entry = source('./src/a.ts', 'ä\r\nβ\n');
    const sha256 = createHash('sha256').update(entry.content).digest('hex');
    const [file] = parseSourceBundle(bundle([{ ...entry, sha256 }]));
    expect(file).toMatchObject({ path: 'src/a.ts', sha256, kind: 'source' });
    expect(file!.bytes.equals(Buffer.from(entry.content))).toBe(true);
  });
  it.each([
    [source('../escape')], [source('/absolute')], [source('.git/config')], [source('.slop/report')],
    [source('a'), source('./a')], [source('a'), source('a/b')],
    [{ ...source(), sha256: 'wrong' }], [{ ...source(), sha256: '0'.repeat(64) }],
    [{ ...source(), kind: 'screenshot' }], [source('x', '\u0000')], [source('x', '\ud800')],
    [source('x', 'x'.repeat(2 * 1024 * 1024 + 1))], Array.from({ length: 201 }, (_, i) => source(`${i}.ts`)),
  ])('rejects invalid bundle entries', (...files) => {
    expect(() => parseSourceBundle(bundle(files))).toThrow();
  });
  it('rejects malformed UTF-8 and unsupported versions', () => {
    expect(() => parseSourceBundle(Buffer.from([0xff]))).toThrow('UTF-8');
    expect(() => parseSourceBundle(Buffer.from('{"version":2,"files":[]}'))).toThrow();
  });
  it('plans revisions from locked current state and makes exact retry a no-op', () => {
    const [file] = parseSourceBundle(bundle([source()]));
    const existing = [{ ...file!, rev: 3 }];
    expect(planFileUpdates(existing, [file!])[0]).toMatchObject({ rev: 3, unchanged: true });
    expect(planFileUpdates(existing, [{ ...file!, sha256: 'a'.repeat(64) }])[0]).toMatchObject({ rev: 4, unchanged: false });
  });
  it('rejects the whole plan on collision or unchanged job caps', () => {
    const entry = { path: 'a', kind: 'source' as const, sha256: 'a'.repeat(64), sizeBytes: 1 };
    expect(() => planFileUpdates([{ ...entry, path: 'a/b', rev: 1 }], [entry])).toThrow('collision');
    const full = Array.from({ length: 200 }, (_, i) => ({ ...entry, path: `${i}.ts`, rev: 1 }));
    expect(() => planFileUpdates(full, [entry])).toThrow('limit');
    expect(() => planFileUpdates([{ ...entry, path: 'big', sizeBytes: 50 * 1024 * 1024, rev: 1 }], [entry])).toThrow('limit');
  });
});
