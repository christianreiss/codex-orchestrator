import { describe, expect, it } from 'vitest';
import { staleSwitchReading, SWITCH_STALE_READING_MS } from '../../../src/services/account-switch.js';

const now = Date.parse('2026-11-26T11:07:52Z');
const boundAt = '2026-11-26T11:04:22Z';
const oldAccount = { short_resets_at: null, weekly_resets_at: '2026-11-29T15:00:00Z' };
const newAccount = { short_resets_at: null, weekly_resets_at: '2026-11-27T11:00:00Z' };

describe('staleSwitchReading', () => {
  it('drops the previous account’s last response filed under the new binding', () => {
    // Production 2026-11-26: 91 % with account #1's reset, reported as #8.
    expect(staleSwitchReading({ short_resets_at: null, weekly_resets_at: '2026-11-29T15:00:00Z' }, boundAt, newAccount, [oldAccount], now)).toBe(true);
    // Also before the new account has any reading of its own.
    expect(staleSwitchReading({ short_resets_at: null, weekly_resets_at: '2026-11-29T15:00:00Z' }, boundAt, undefined, [oldAccount], now)).toBe(true);
  });

  it('keeps the new account’s own readings', () => {
    expect(staleSwitchReading({ short_resets_at: null, weekly_resets_at: '2026-11-27T11:00:00Z' }, boundAt, newAccount, [oldAccount], now)).toBe(false);
    expect(staleSwitchReading({ short_resets_at: null, weekly_resets_at: '2026-12-03T09:00:00Z' }, boundAt, undefined, [oldAccount], now)).toBe(false);
  });

  it('doubts a report without limit while the bound account has a window of its own', () => {
    const later = Date.parse(boundAt) + SWITCH_STALE_READING_MS + 1000;
    // Hours after the switch a session can still sit on the old account's last response.
    expect(staleSwitchReading({ short_resets_at: null, weekly_resets_at: '2026-11-29T15:00:00Z' }, boundAt, newAccount, [oldAccount], later)).toBe(true);
    expect(staleSwitchReading({ short_resets_at: null, weekly_resets_at: '2026-11-29T15:00:00Z' }, null, newAccount, [oldAccount], now)).toBe(true);
    expect(staleSwitchReading({ short_resets_at: null, weekly_resets_at: '2026-11-27T11:00:00Z' }, boundAt, newAccount, [oldAccount], later)).toBe(false);
  });

  it('only applies shortly after a switch when the bound account has nothing to compare with', () => {
    const later = Date.parse(boundAt) + SWITCH_STALE_READING_MS + 1000;
    expect(staleSwitchReading({ short_resets_at: null, weekly_resets_at: '2026-11-29T15:00:00Z' }, boundAt, undefined, [oldAccount], later)).toBe(false);
    expect(staleSwitchReading({ short_resets_at: null, weekly_resets_at: '2026-11-29T15:00:00Z' }, null, undefined, [oldAccount], now)).toBe(false);
    // A window of its own that already ended contradicts nothing either.
    const ended = { short_resets_at: null, weekly_resets_at: '2026-11-26T10:00:00Z' };
    expect(staleSwitchReading({ short_resets_at: null, weekly_resets_at: '2026-11-29T15:00:00Z' }, boundAt, ended, [oldAccount], later)).toBe(false);
  });

  it('checks the short window too', () => {
    const other = { short_resets_at: '2026-11-26T14:00:00Z', weekly_resets_at: null };
    expect(staleSwitchReading({ short_resets_at: '2026-11-26T14:00:00Z', weekly_resets_at: null }, boundAt, undefined, [other], now)).toBe(true);
  });
});
