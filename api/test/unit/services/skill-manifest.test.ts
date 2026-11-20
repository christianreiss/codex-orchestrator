import { describe, expect, it } from 'vitest';
import { canonicalSkillUri, normalizeSlug } from '../../../src/services/skill-manifest.js';
import { ValidationError } from '../../../src/http/errors.js';

describe('skill-manifest: normalizeSlug', () => {
  it('accepts plain lowercase slugs', () => {
    expect(normalizeSlug('git-history')).toBe('git-history');
  });

  it('accepts dotted slugs', () => {
    expect(normalizeSlug('python.django')).toBe('python.django');
  });

  it('rejects empty / whitespace', () => {
    expect(() => normalizeSlug('')).toThrow(ValidationError);
    expect(() => normalizeSlug('   ')).toThrow(ValidationError);
  });

  it('rejects slashes', () => {
    expect(() => normalizeSlug('a/b')).toThrow(ValidationError);
    expect(() => normalizeSlug('a..b')).toThrow(ValidationError);
  });

  it('rejects non-allowed characters', () => {
    expect(() => normalizeSlug('hello world')).toThrow(ValidationError);
    expect(() => normalizeSlug('hello!')).toThrow(ValidationError);
  });

  it('rejects strings over 255 chars', () => {
    expect(() => normalizeSlug('a'.repeat(256))).toThrow(ValidationError);
  });
});

describe('canonicalSkillUri', () => {
  it('url-encodes slugs', () => {
    expect(canonicalSkillUri('git.history')).toBe('skill://git.history');
  });
});
