import { describe, expect, it } from 'vitest';
import { poolPosition } from '../../../src/services/account-switch.js';

const now = Date.parse('2026-11-26T10:00:00Z');
const row = (patch: Record<string, unknown> = {}, usage: Record<string, unknown> = {}) => ({
  state: 'enabled',
  verification_state: 'verified',
  quota_policy: { unlimited: false },
  quota_snapshot: null,
  ...patch,
  usage: {
    short_used_percent: 20,
    short_resets_at: '2026-11-26T12:00:00Z',
    weekly_used_percent: 87,
    weekly_resets_at: '2026-11-30T00:00:00Z',
    ...usage,
  },
});

describe('pool position of a listed account', () => {
  it('scores the higher window and marks enabled, verified accounts usable', () => {
    expect(poolPosition(row(), now)).toEqual({ score: 87, short: 20, weekly: 87, usable: true, emulation_blocked: false });
  });

  it('treats a passed reset as no reading and missing readings as unknown', () => {
    expect(poolPosition(row({}, { weekly_resets_at: '2026-11-25T00:00:00Z' }), now)).toMatchObject({ score: 20, short: 20, weekly: null });
    expect(poolPosition(row({}, { short_used_percent: null, weekly_used_percent: null }), now).score).toBeNull();
  });

  it('scores unlimited accounts 0 and accounts blocked by an emulated budget 100', () => {
    expect(poolPosition(row({ quota_policy: { unlimited: true } }), now).score).toBe(0);
    const blocked = row({ quota_snapshot: { short: { source: 'emulated', status: 'fresh', action: 'hard_stop', used_percent: 100 } } }, { weekly_used_percent: 10 });
    expect(poolPosition(blocked, now)).toEqual({ score: 100, short: 20, weekly: 10, usable: true, emulation_blocked: true });
  });

  it('never counts paused or unverified accounts as usable', () => {
    expect(poolPosition(row({ state: 'paused' }), now).usable).toBe(false);
    expect(poolPosition(row({ verification_state: 'pending' }), now).usable).toBe(false);
  });
});
