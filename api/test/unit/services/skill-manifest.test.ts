import { describe, expect, it } from 'vitest';
import { canonicalSkillUri, normalizeSlug, parseManifest } from '../../../src/services/skill-manifest.js';
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

describe('skill-manifest: parseManifest', () => {
  it('returns body verbatim when not JSON', () => {
    const m = parseManifest('git-history', '# Skill\n\nLooks up git history.');
    expect(m.slug).toBe('git-history');
    expect(m.body).toContain('# Skill');
    expect(m.parsedJson).toBeNull();
  });

  it('parses JSON manifests', () => {
    const m = parseManifest('git-history', JSON.stringify({ description: 'demo' }));
    expect(m.parsedJson).toEqual({ description: 'demo' });
  });

  it('rejects empty manifest body', () => {
    expect(() => parseManifest('foo', '')).toThrow(ValidationError);
    expect(() => parseManifest('foo', '   ')).toThrow(ValidationError);
  });
});

describe('canonicalSkillUri', () => {
  it('url-encodes slugs', () => {
    expect(canonicalSkillUri('git.history')).toBe('skill://git.history');
  });
});
