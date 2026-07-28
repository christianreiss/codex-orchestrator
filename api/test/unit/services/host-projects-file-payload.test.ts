import { describe, expect, it } from 'vitest';
import { ValidationError } from '../../../src/http/errors.js';
import { HostProjectsService } from '../../../src/services/host-projects.js';
import { createDbFake } from '../../helpers/db-fake.js';

const service = new HostProjectsService(createDbFake() as never);

/**
 * ValidationError's message is always the generic "Validation failed"; the
 * per-field detail lives in `extra.errors`, which is what a caller actually
 * reads. Assert against that rather than the message.
 */
function fieldErrors(fn: () => unknown): Record<string, string[]> {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(ValidationError);
    return ((err as ValidationError).extra as { errors?: Record<string, string[]> } | undefined)?.errors ?? {};
  }
  throw new Error('expected the call to throw');
}

describe('HostProjectsService.normalizeStoredName', () => {
  it.each([
    ['empty string', ''],
    ['whitespace only', '   '],
    ['undefined', undefined],
  ])('rejects %s as required', (_label, value) => {
    expect(fieldErrors(() => service.normalizeStoredName(value))).toEqual({
      stored_name: ['stored_name is required'],
    });
  });

  it.each([
    ['a NUL byte', 'notes\0.md'],
    ['only separators', '///'],
  ])('rejects a name containing %s', (_label, value) => {
    expect(fieldErrors(() => service.normalizeStoredName(value))).toEqual({
      stored_name: ['stored_name is invalid'],
    });
  });

  // The whole point of this guard: nothing that resolves outside the project
  // directory may reach the host/MCP file lane.
  it.each([
    ['a leading parent segment', '../x'],
    ['an interior parent segment', 'a/../b'],
    ['a bare parent', '..'],
    ['a current-directory segment', 'a/./b'],
  ])('rejects %s', (_label, value) => {
    expect(fieldErrors(() => service.normalizeStoredName(value))).toEqual({
      stored_name: ['stored_name cannot contain dot segments'],
    });
  });

  it.each([
    ['folds backslashes to slashes', 'a\\b\\c', 'a/b/c'],
    ['collapses repeated slashes', 'a//b', 'a/b'],
    ['strips leading and trailing slashes', '/a/b/', 'a/b'],
    ['trims surrounding whitespace', '  docs/plan.md  ', 'docs/plan.md'],
  ])('%s', (_label, value, expected) => {
    expect(service.normalizeStoredName(value)).toBe(expected);
  });
});

describe('HostProjectsService.normalizeFilePayload', () => {
  it('prefers stored_name over name', () => {
    const out = service.normalizeFilePayload({ stored_name: 'docs/a.md', name: 'b.md', content: 'x' });

    expect(out.storedName).toBe('docs/a.md');
  });

  it('falls back to name when stored_name is absent', () => {
    const out = service.normalizeFilePayload({ name: 'b.md', content: 'x' });

    expect(out.storedName).toBe('b.md');
  });

  it('falls back from content to text', () => {
    const out = service.normalizeFilePayload({ stored_name: 'a.md', text: 'from text' });

    expect(out.content).toBe('from text');
  });

  it('rejects an empty body', () => {
    expect(fieldErrors(() => service.normalizeFilePayload({ stored_name: 'a.md' }))).toEqual({
      content: ['content is required'],
    });
  });

  it('runs the stored name through the dot-segment guard', () => {
    expect(fieldErrors(() => service.normalizeFilePayload({ name: '../escape.md', content: 'x' }))).toEqual({
      stored_name: ['stored_name cannot contain dot segments'],
    });
  });

  it('passes description and mime_type through optString', () => {
    const out = service.normalizeFilePayload({
      stored_name: 'a.md',
      content: 'x',
      description: '  a plan  ',
      mime_type: 'text/markdown',
    });

    expect(out.description).toBe('a plan');
    expect(out.mimeType).toBe('text/markdown');
  });

  it('nulls blank and missing description and mime_type', () => {
    const blank = service.normalizeFilePayload({ stored_name: 'a.md', content: 'x', description: '   ', mime_type: '' });
    const missing = service.normalizeFilePayload({ stored_name: 'a.md', content: 'x' });

    expect(blank.description).toBeNull();
    expect(blank.mimeType).toBeNull();
    expect(missing.description).toBeNull();
    expect(missing.mimeType).toBeNull();
  });
});
