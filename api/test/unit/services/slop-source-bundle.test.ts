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
  describe('screenshots and a11y exports', () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 1, 0xff, 0xfe]);
    const shot = (path = 'shots/home.png', bytes = png) => ({ path, content_base64: bytes.toString('base64') });
    it('imports binary screenshots by extension next to sources, keeping the exact bytes', () => {
      const sha256 = createHash('sha256').update(png).digest('hex');
      const [a, b] = parseSourceBundle(bundle([source(), { ...shot(), sha256 }]));
      expect(a).toMatchObject({ path: 'src/a.ts', kind: 'source' });
      expect(b).toMatchObject({ path: 'shots/home.png', kind: 'screenshot', sha256, sizeBytes: png.length });
      expect(b!.bytes.equals(png)).toBe(true);
    });
    it('accepts text and a11y JSON through content_base64 and an explicit kind', () => {
      const json = Buffer.from('{"tool":"axe","findings":[]}');
      const [a, t] = parseSourceBundle(bundle([{ path: 'a11y/home.json', kind: 'a11y', content_base64: json.toString('base64') }, { path: 'notes.txt', content_base64: Buffer.from('hi\n').toString('base64') }]));
      expect(a).toMatchObject({ kind: 'a11y' });
      expect(t).toMatchObject({ kind: 'source' });
      const [c] = parseSourceBundle(bundle([{ path: 'a11y/x.json', kind: 'a11y', content: '{"tool":"axe","findings":[]}' }]));
      expect(c).toMatchObject({ kind: 'a11y' });
    });
    it.each([
      [{ path: 'a.png', content: 'text' , kind: 'screenshot' }],
      [{ path: 'a.png', content: 'text', content_base64: 'AAAA' }],
      [{ path: 'a.png' }],
      [{ path: 'a.png', content_base64: 'not base64!' }],
      [{ path: 'a.png', content_base64: 'AAA' }],
      [{ path: 'a.png', content_base64: 'AB==' }],
      [{ path: 'a.png', content_base64: 12 }],
      [{ path: 'a.ts', content_base64: Buffer.from([0x89, 0x50, 0, 1]).toString('base64') }],
      [{ path: 'a.png', kind: 'source', content_base64: Buffer.from([0, 1, 2]).toString('base64') }],
      [{ path: 'a.ts', kind: 'screenshot', content_base64: 'AAAA' }],
      [{ path: 'a.json', kind: 'a11y', content_base64: Buffer.from('nope').toString('base64') }],
      [{ ...shot(), sha256: '0'.repeat(64) }],
      [{ path: 'big.png', content_base64: Buffer.alloc(2 * 1024 * 1024 + 1).toString('base64') }],
      [{ ...shot(), extra: 1 }],
    ])('rejects invalid screenshot entries', (...files) => {
      expect(() => parseSourceBundle(bundle(files))).toThrow();
    });
    it('keeps the 64 MiB transport bound over base64 screenshots', () => {
      const big = Buffer.alloc(2 * 1024 * 1024, 1).toString('base64');
      const files = Array.from({ length: 26 }, (_, i) => ({ path: `s${i}.png`, content_base64: big }));
      expect(() => parseSourceBundle(bundle(files))).toThrow('64 MiB');
    });
    it('plans screenshot revisions and unchanged detection like put', () => {
      const [file] = parseSourceBundle(bundle([shot()]));
      expect(planFileUpdates([{ ...file!, rev: 2 }], [file!])[0]).toMatchObject({ rev: 2, unchanged: true });
      const [next] = parseSourceBundle(bundle([shot('shots/home.png', Buffer.from([1, 2, 3, 0]))]));
      expect(planFileUpdates([{ ...file!, rev: 2 }], [next!])[0]).toMatchObject({ rev: 3, unchanged: false, previous_rev: 2 });
    });
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
