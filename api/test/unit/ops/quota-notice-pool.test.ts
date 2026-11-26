import { describe, expect, it } from 'vitest';
import { quotaNoticeContent } from '../../../src/ops/quota-worker.js';

const q = { engine: 'claude', account_label: 'alice@example.com' } as unknown as Parameters<typeof quotaNoticeContent>[0];
const w = { kind: 'long', used_percent: 90, limit_seconds: 604800, resets_at: '2026-11-29T15:00:00Z', observed_at: '2026-11-26T08:00:00Z', source: 'provider', status: 'fresh' } as const;

describe('pool-aware QUOTA/1 notices', () => {
  it('keeps the single-account text without a pool', () => {
    const text = quotaNoticeContent(q, w);
    expect(text).toContain('Save a continuation checkpoint');
    expect(text).not.toContain('account_status');
  });

  it('names the pool and tells agents to keep working while it has headroom', () => {
    const text = quotaNoticeContent(q, w, {
      action: 'switch',
      account_id: 2,
      message: 'Account alice@example.com is at 90%; pool: bob@example.com 35%. Switching to bob@example.com at the next turn boundary; keep working.',
    });
    expect(text).toContain('pool: bob@example.com 35%');
    expect(text).toContain('Do not stop working');
    expect(text).not.toContain('checkpoint');
  });

  it('falls back to the single-account advice when the whole pool is exhausted', () => {
    const text = quotaNoticeContent(q, w, { action: 'pause', account_id: null, message: 'every account is at its limit' });
    expect(text).toContain('Save a continuation checkpoint');
  });
});
