import { describe, expect, it } from 'vitest';
import { parseTags, sortedLowercase, sortedAssoc } from '../../../src/services/memory-tags.js';

describe('parseTags', () => {
  it('keeps the string entries of an array and drops everything else', () => {
    expect(parseTags(['ops', 1, '', null, 'deploy'])).toEqual(['ops', 'deploy']);
  });

  // The JSON column comes back as a string from some drivers and as an array
  // from others; both shapes have to yield the same tag list.
  it('parses the JSON-string form the driver may hand back', () => {
    expect(parseTags('["ops","deploy"]')).toEqual(['ops', 'deploy']);
    expect(parseTags('["ops",2,""]')).toEqual(['ops']);
  });

  it('returns no tags for malformed JSON', () => {
    expect(parseTags('["ops",')).toEqual([]);
  });

  it('returns no tags for JSON that is not an array', () => {
    expect(parseTags('{"ops":true}')).toEqual([]);
  });

  it('returns no tags for null, undefined and non-string scalars', () => {
    expect(parseTags(null)).toEqual([]);
    expect(parseTags(undefined)).toEqual([]);
    expect(parseTags(42)).toEqual([]);
  });
});

describe('sortedLowercase', () => {
  it('lowercases, de-duplicates and sorts', () => {
    expect(sortedLowercase(['Ops', 'deploy', 'OPS', 'ops'])).toEqual(['deploy', 'ops']);
  });

  it('leaves an empty list empty', () => {
    expect(sortedLowercase([])).toEqual([]);
  });
});

describe('sortedAssoc', () => {
  it('passes null through', () => {
    expect(sortedAssoc(null)).toBeNull();
  });

  // Insertion order must not make two identical metadata objects compare
  // different, so the key order is what is being asserted here, not the values.
  it('orders keys so insertion order cannot affect comparison', () => {
    const sorted = sortedAssoc({ zulu: 1, alpha: 2, mike: 3 });
    expect(Object.keys(sorted!)).toEqual(['alpha', 'mike', 'zulu']);
    expect(sorted).toEqual({ alpha: 2, mike: 3, zulu: 1 });
    expect(JSON.stringify(sortedAssoc({ alpha: 2, zulu: 1, mike: 3 }))).toBe(JSON.stringify(sorted));
  });

  it('keeps an empty object empty', () => {
    expect(sortedAssoc({})).toEqual({});
  });
});
