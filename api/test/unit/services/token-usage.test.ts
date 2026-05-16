import { describe, expect, it } from 'vitest';
import {
  normalizeEntry,
  normalizePayload,
  sanitizeLine,
} from '../../../src/services/token-usage.js';
import { ValidationError } from '../../../src/http/errors.js';

describe('token-usage normalization', () => {
  it('parses a single-entry payload with commas in numbers', () => {
    const entries = normalizePayload({ total: '1,234', input: '500', output: '700' });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ total: 1234, input: 500, output: 700, line: null });
  });

  it('parses a multi-entry usages array', () => {
    const entries = normalizePayload({
      usages: [
        { total: 100 },
        { line: 'token usage: 200 tokens', total: 200 },
      ],
    });
    expect(entries).toHaveLength(2);
    expect(entries[1]!.line).toBe('token usage: 200 tokens');
  });

  it('rejects negative numbers', () => {
    expect(() => normalizeEntry({ total: -1 }, 'u')).toThrow(ValidationError);
  });

  it('requires at least one of line or numeric fields', () => {
    expect(() => normalizeEntry({}, 'u')).toThrow(ValidationError);
  });

  it('rejects malformed strings', () => {
    expect(() => normalizeEntry({ total: 'abc' }, 'u')).toThrow(ValidationError);
  });
});

describe('sanitizeLine', () => {
  it('strips ANSI CSI control sequences', () => {
    const input = `\x1B[31mhello\x1B[0m world`;
    expect(sanitizeLine(input)).toBe('hello world');
  });

  it('trims to "token usage:" segment when present', () => {
    const line = 'some prefix garbage Token usage: 100 input + 50 output';
    expect(sanitizeLine(line).toLowerCase()).toContain('token usage:');
    expect(sanitizeLine(line).toLowerCase().startsWith('token usage:')).toBe(true);
  });

  it('caps very long output to 1001 chars (1000 + ellipsis)', () => {
    const big = 'a'.repeat(5000);
    const out = sanitizeLine(big);
    expect(out.length).toBeLessThanOrEqual(1001);
  });

  it('returns empty string for empty input', () => {
    expect(sanitizeLine('')).toBe('');
    expect(sanitizeLine('   \t  ')).toBe('');
  });
});
