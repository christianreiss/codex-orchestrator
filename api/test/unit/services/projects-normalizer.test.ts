import { describe, expect, it } from 'vitest';
import {
  normalizeAbout,
  normalizeOptionalString,
  normalizeRoster,
  normalizeSlug,
} from '../../../src/services/projects.js';
import { ValidationError } from '../../../src/http/errors.js';

describe('projects: normalizeSlug', () => {
  it('accepts canonical slugs', () => {
    expect(normalizeSlug('foo-bar_baz')).toBe('foo-bar_baz');
  });

  it('rejects slugs starting with non-alphanumeric', () => {
    expect(() => normalizeSlug('-foo')).toThrow(ValidationError);
    expect(() => normalizeSlug('_foo')).toThrow(ValidationError);
  });

  it('rejects empty / null', () => {
    expect(() => normalizeSlug('')).toThrow(ValidationError);
    expect(() => normalizeSlug(null)).toThrow(ValidationError);
  });
});

describe('projects: normalizeAbout', () => {
  it('returns null for null input', () => {
    expect(normalizeAbout(null)).toBeNull();
  });

  it('keeps scalar values, trims strings', () => {
    const out = normalizeAbout({ title: '  Hello  ', count: 3, ok: true });
    expect(out).toEqual({ title: 'Hello', count: 3, ok: true });
  });

  it('rejects arrays at top level', () => {
    expect(() => normalizeAbout([1, 2])).toThrow(ValidationError);
  });

  it('returns null for empty object', () => {
    expect(normalizeAbout({})).toBeNull();
  });
});

describe('projects: normalizeRoster', () => {
  it('trims whitespace', () => {
    expect(normalizeRoster('  hi\n')).toBe('hi');
  });
  it('rejects rosters over 65535 chars', () => {
    expect(() => normalizeRoster('x'.repeat(65536))).toThrow(ValidationError);
  });
});

describe('projects: normalizeOptionalString', () => {
  it('trims, returns null for empty', () => {
    expect(normalizeOptionalString('  ')).toBeNull();
    expect(normalizeOptionalString('hi ')).toBe('hi');
  });
  it('returns null for non-string scalars', () => {
    expect(normalizeOptionalString(true)).toBeNull();
  });
});
