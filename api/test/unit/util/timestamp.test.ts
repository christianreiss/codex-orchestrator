import { describe, expect, it } from 'vitest';
import {
  compareRfc3339,
  formatRfc3339Nanos,
  isRfc3339,
  normalizeRfc3339Nanos,
  parseRfc3339Millis,
  parseRfc3339Nanos,
} from '../../../src/util/timestamp.js';

describe('RFC3339 auth generations', () => {
  it.each([
    '2026-02-31T00:00:00Z',
    '2026-01-01T24:00:00Z',
    '2026-01-01T00:00:60Z',
    '2026-01-01T00:00:00+14:01',
    '2026-01-01T00:00:00-15:00',
    '2026-01-01T00:00:00+0100',
    '2026-01-01T00:00:00.1234567890Z',
  ])('rejects invalid value %s', (value) => {
    expect(isRfc3339(value)).toBe(false);
    expect(parseRfc3339Millis(value)).toBeNull();
  });

  it('orders generations within one JavaScript millisecond', () => {
    const older = '2026-07-17T12:00:00.100000001Z';
    const newer = '2026-07-17T12:00:00.100000002Z';
    expect(Date.parse(older)).toBe(Date.parse(newer));
    expect(compareRfc3339(older, newer)).toBe(-1);
    expect(parseRfc3339Nanos(newer)! - parseRfc3339Nanos(older)!).toBe(1n);
    expect(normalizeRfc3339Nanos(newer)).toBe(newer);
    expect(formatRfc3339Nanos(parseRfc3339Nanos(older)!)).toBe(older);
  });

  it('preserves literal four-digit years below 0100', () => {
    const older = '0099-12-31T23:59:59.999999999Z';
    const newer = '0100-01-01T00:00:00Z';
    expect(compareRfc3339(older, newer)).toBe(-1);
    expect(normalizeRfc3339Nanos(older)).toBe(older);
  });
});
