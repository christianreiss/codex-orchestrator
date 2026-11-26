import { describe, expect, it } from 'vitest';
import { accountSwitchNoticeContent, type PoolAccount } from '../../../src/services/account-switch.js';

const account = (id: number, label: string, short: number | null, weekly: number | null): PoolAccount => ({
  id,
  label,
  email: label,
  state: 'enabled',
  verified: true,
  short_used_percent: short,
  short_resets_at: null,
  weekly_used_percent: weekly,
  weekly_resets_at: null,
  fetched_at: null,
  score: weekly,
  emulation_blocked: false,
  unlimited: false,
  active_sessions: 0,
  last_selected_at: null,
});

describe('accountSwitchNoticeContent', () => {
  it('names the new and previous account with their usage', () => {
    const text = accountSwitchNoticeContent('claude', account(1, 'old@example.com', 12, 91.4), account(8, 'new@example.com', null, 3), 'policy');
    expect(text).toMatch(/^ACCOUNT\/1 switched: /);
    expect(text).toContain('now runs on new@example.com (#8), weekly 3%');
    expect(text).toContain('previously old@example.com (#1), 5h 12%, weekly 91%');
    expect(text).toContain('Reason: policy.');
    expect(text).toContain('keep working');
  });

  it('says when an account has no reading or is unknown', () => {
    const text = accountSwitchNoticeContent('claude', undefined, account(8, 'new@example.com', null, null), null);
    expect(text).toContain('new@example.com (#8), no usage reading yet');
    expect(text).toContain('previously the old account, usage unknown');
    expect(text).toContain('Reason: unspecified.');
  });
});
