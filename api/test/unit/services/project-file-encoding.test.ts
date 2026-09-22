import { describe, expect, it } from 'vitest';
import {
  FILE_ENCODING_BASE64,
  FILE_ENCODING_UTF8,
  FILE_MAX_DECODED_BYTES,
  STORED_NAME_MAX,
  acceptFileBody,
  base64DecodedLength,
  canonicalizeBase64,
  contentDigest,
  decodedByteLength,
  decodedLengthFromStored,
  inferMimeType,
  isWellFormedBase64,
  normalizeFileEncoding,
  storedNameTooLong,
} from '../../../src/services/project-file-encoding.js';
import { createHash } from 'node:crypto';

describe('normalizeFileEncoding', () => {
  it('defaults to utf8 when nothing is said', () => {
    for (const value of [undefined, null, '']) {
      expect(normalizeFileEncoding(value)).toBe(FILE_ENCODING_UTF8);
    }
  });

  it('accepts the spellings a caller is likely to reach for', () => {
    for (const value of ['utf8', 'UTF-8', ' text ']) expect(normalizeFileEncoding(value)).toBe(FILE_ENCODING_UTF8);
    for (const value of ['base64', 'B64', ' Base64 ']) expect(normalizeFileEncoding(value)).toBe(FILE_ENCODING_BASE64);
  });

  it('reports anything else rather than guessing', () => {
    expect(normalizeFileEncoding('hex')).toBeNull();
    expect(normalizeFileEncoding('gzip')).toBeNull();
  });
});

describe('base64 sizing', () => {
  it('counts decoded bytes without decoding, for every padding case', () => {
    for (const size of [0, 1, 2, 3, 4, 5, 99, 1000, 4096]) {
      const bytes = Buffer.alloc(size, 7);
      const encoded = bytes.toString('base64');
      expect(base64DecodedLength(encoded)).toBe(size);
    }
  });

  it('agrees with what SQL can report about the stored body', () => {
    // `decodedLengthFromStored` is what the lean file listing uses: it sees only
    // octet_length(content) and the last two characters, never the body. It must
    // give the same answer as measuring the body directly, or a listing and a
    // read would disagree about the same file.
    for (const size of [0, 1, 2, 3, 300, 5000]) {
      const encoded = Buffer.alloc(size, 3).toString('base64');
      const stored = canonicalizeBase64(encoded);
      expect(decodedLengthFromStored(stored.length, stored.slice(-2), FILE_ENCODING_BASE64)).toBe(
        decodedByteLength(stored, FILE_ENCODING_BASE64),
      );
    }
  });

  it('passes a utf8 body\'s stored length straight through', () => {
    expect(decodedLengthFromStored(1234, 'ab', FILE_ENCODING_UTF8)).toBe(1234);
    expect(decodedLengthFromStored(1234, 'ab', null)).toBe(1234);
  });

  it('measures a utf8 body in bytes, not characters', () => {
    expect(decodedByteLength('ü'.repeat(1000), FILE_ENCODING_UTF8)).toBe(2000);
  });
});

describe('acceptFileBody', () => {
  it('digests the bytes a base64 body encodes, not the base64 text', () => {
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const encoded = bytes.toString('base64');
    const out = acceptFileBody(encoded, 'base64');
    expect(out.ok).toBe(true);
    if (!out.ok) return;

    // The whole point: this digest can be checked against one taken of the file
    // anywhere else. A sha256 of the base64 text cannot.
    expect(out.value.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
    expect(out.value.sha256).not.toBe(createHash('sha256').update(encoded).digest('hex'));
    expect(out.value.sizeBytes).toBe(bytes.length);
  });

  it('stores a base64 body whitespace-stripped, so SQL can size it', () => {
    const encoded = Buffer.alloc(300, 1).toString('base64');
    const wrapped = (encoded.match(/.{1,76}/g) ?? []).join('\n');
    const out = acceptFileBody(wrapped, 'base64');
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.value.body).toBe(encoded);
    expect(out.value.body).not.toContain('\n');
    expect(out.value.sizeBytes).toBe(300);
  });

  it('rejects a body that is not the encoding it claims', () => {
    const out = acceptFileBody('this is not base64!!', 'base64');
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error).toEqual({ field: 'content', message: 'content is not valid base64' });
  });

  it('rejects an unknown encoding by name', () => {
    const out = acceptFileBody('x', 'rot13');
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error.field).toBe('encoding');
  });

  it('caps a body at the decoded size, so a 4 MiB file is not rejected for its envelope', () => {
    // Project files had no limit at all before this — the only ceiling was
    // Fastify's 32 MiB body limit.
    const justOver = 'a'.repeat(FILE_MAX_DECODED_BYTES + 1);
    const rejected = acceptFileBody(justOver, 'utf8');
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) {
      expect(rejected.error.field).toBe('content');
      expect(rejected.error.message).toContain(String(FILE_MAX_DECODED_BYTES));
      expect(rejected.error.message).toContain('transfer_put');
    }

    // Exactly at the limit, encoded, is over 5 MiB of base64 — and still fine,
    // because the limit is on what it represents.
    const atLimit = Buffer.alloc(FILE_MAX_DECODED_BYTES, 9).toString('base64');
    expect(atLimit.length).toBeGreaterThan(FILE_MAX_DECODED_BYTES);
    const accepted = acceptFileBody(atLimit, 'base64');
    expect(accepted.ok).toBe(true);
  });

  it('leaves a text body exactly as given', () => {
    const out = acceptFileBody('  line one\n\n  line two  ', 'utf8');
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.value.body).toBe('  line one\n\n  line two  ');
    expect(out.value.encoding).toBe(FILE_ENCODING_UTF8);
  });
});

describe('isWellFormedBase64', () => {
  it('accepts padded and unpadded multiples of four, and wrapped bodies', () => {
    expect(isWellFormedBase64(Buffer.from('abc').toString('base64'))).toBe(true);
    expect(isWellFormedBase64(Buffer.from('ab').toString('base64'))).toBe(true);
    expect(isWellFormedBase64('AAAA\nAAAA')).toBe(true);
  });

  it('rejects a truncated or illegal body, which Node would silently accept', () => {
    // Buffer.from(_, 'base64') drops unrecognised input instead of failing, so
    // without this check a typo becomes a shorter file rather than an error.
    expect(isWellFormedBase64('AAA')).toBe(false);
    expect(isWellFormedBase64('AA*A')).toBe(false);
  });
});

describe('inferMimeType', () => {
  it('reads the extension, ignoring the directory', () => {
    expect(inferMimeType('context/PLAN.md')).toBe('text/markdown');
    expect(inferMimeType('context/evidence.tar.gz')).toBe('application/gzip');
    expect(inferMimeType('a/b/c/report.pdf')).toBe('application/pdf');
    expect(inferMimeType('hosts.CSV')).toBe('text/csv');
  });

  it('stays null rather than guessing', () => {
    expect(inferMimeType('LICENSE')).toBeNull();
    expect(inferMimeType('archive.')).toBeNull();
    expect(inferMimeType('.gitignore')).toBeNull();
    expect(inferMimeType('notes.wat')).toBeNull();
  });
});

describe('storedNameTooLong', () => {
  it('guards the varchar(255) column nothing was checking', () => {
    expect(storedNameTooLong('a'.repeat(STORED_NAME_MAX))).toBe(false);
    expect(storedNameTooLong('a'.repeat(STORED_NAME_MAX + 1))).toBe(true);
  });
});

describe('contentDigest', () => {
  it('matches a plain sha256 for text, so existing rows keep their meaning', () => {
    expect(contentDigest('hello', FILE_ENCODING_UTF8)).toBe(
      createHash('sha256').update('hello').digest('hex'),
    );
  });
});
