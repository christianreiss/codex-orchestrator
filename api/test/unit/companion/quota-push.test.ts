import { afterEach, describe, expect, it, vi } from 'vitest';
import { OwnerCompanionPush } from '../../../src/services/companion/push-owner.js';
import {
  coversQuotaWindow,
  parseQuotaSourceKey,
  quotaAlerts,
  quotaJobExpiresAt,
  quotaPushAllowed,
  quotaPushData,
  quotaSourceKey,
} from '../../../src/services/companion/quota-push.js';
import { ownerWorkerFixture } from '../../helpers/owner-worker.js';
import { loadTestEnv, testKeyring } from '../../helpers/test-keyring.js';
import type { StateSeed } from '../../../src/control-plane/state/catalog.js';
import type { RouteContext } from '../../../src/routes/index.js';

afterEach(() => vi.useRealTimers());
const NOW = '2026-10-29T10:00:00.000Z';
const SHORT_RESET = '2026-10-29T13:00:00.000Z';
const LONG_RESET = '2026-11-03T10:00:00.000Z';
const env = { ...loadTestEnv(), COMPANION_FIREBASE_PROJECT_ID: 'test', COMPANION_FIREBASE_CREDENTIAL_FILE: '/not-read' };

function seed(opts: { short?: number; long?: number; accessLevel?: string; disabled?: boolean; policy?: string } = {}) {
  return {
    adminUsers: [{ id: 7, active: 1, accessLevel: opts.accessLevel ?? 'owner', name: 'Chris' }],
    companionDevices: [{ id: 'device', userId: 7, eventCursor: 0, roomChangeCursor: 0, readSyncProtocol: 1, notifications: 1, revokedAt: null, expiresAt: '2999-01-01T00:00:00.000Z', pushTokenDigest: 'digest' }],
    providerAccounts: [{ id: 5, engine: 'claude', label: 'Main', state: 'enabled', mergedIntoAccountId: null }],
    claudeUsageSnapshots: [{ id: 1, accountId: 5, fiveHourUsedPercent: opts.short ?? 90, fiveHourResetsAt: SHORT_RESET, sevenDayUsedPercent: opts.long ?? 40, sevenDayResetsAt: LONG_RESET, fetchedAt: NOW }],
    versions: [
      { name: 'owner_portal_event_id', version: '0', updatedAt: NOW },
      ...(opts.disabled ? [{ name: 'claude_engine_disabled', version: '1', updatedAt: NOW }] : []),
      ...(opts.policy ? [{ name: 'quota_policy_claude', version: opts.policy, updatedAt: NOW }] : []),
    ],
  } as unknown as StateSeed;
}

describe('quota push source keys', () => {
  it('keys one window per account and fits the outbox column', () => {
    const key = quotaSourceKey({ accountId: 123456789, kind: 'short', resetsAt: SHORT_RESET });
    expect(key).toBe(`quota:123456789:short:${SHORT_RESET}`);
    expect(key.length).toBeLessThanOrEqual(100);
    expect(parseQuotaSourceKey(key)).toEqual({ accountId: 123456789, kind: 'short', resetsAt: SHORT_RESET });
    expect(parseQuotaSourceKey('event:5')).toBeNull();
  });
  it('treats a reset timestamp that drifted by seconds as the same window, a new reset as a new one', () => {
    const key = quotaSourceKey({ accountId: 5, kind: 'short', resetsAt: SHORT_RESET });
    expect(coversQuotaWindow(key, { accountId: 5, kind: 'short', resetsAt: '2026-10-29T13:00:07.000Z' })).toBe(true);
    expect(coversQuotaWindow(key, { accountId: 5, kind: 'short', resetsAt: '2026-10-29T18:00:00.000Z' })).toBe(false);
    expect(coversQuotaWindow(key, { accountId: 5, kind: 'long', resetsAt: SHORT_RESET })).toBe(false);
    expect(coversQuotaWindow(key, { accountId: 6, kind: 'short', resetsAt: SHORT_RESET })).toBe(false);
  });
  it('keeps the job until the window resets, clamped to a sane range', () => {
    const now = Date.parse(NOW);
    expect(quotaJobExpiresAt(SHORT_RESET, now)).toBe(SHORT_RESET);
    expect(quotaJobExpiresAt('2026-10-29T09:00:00.000Z', now)).toBe('2026-10-29T10:01:00.000Z');
    expect(quotaJobExpiresAt('2030-01-01T00:00:00.000Z', now)).toBe('2026-11-06T10:00:00.000Z');
  });
  it('uses the quota read capabilities', () => {
    expect(quotaPushAllowed('viewer')).toBe(true);
    expect(quotaPushAllowed('owner')).toBe(true);
    expect(quotaPushAllowed('nonexistent')).toBe(false);
  });
});

describe('quota alerts from the shared quota snapshot', () => {
  it('alerts only fresh windows at or above the effective warn threshold', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const f = await ownerWorkerFixture(seed());
    const alerts = await quotaAlerts(f.db, [{ id: 5, engine: 'claude', state: 'enabled' }]);
    expect(alerts).toEqual([
      expect.objectContaining({ accountId: 5, engine: 'claude', kind: 'short', usedPercent: 90, threshold: 85, resetsAt: SHORT_RESET }),
    ]);
    const data = await quotaPushData(f.db, { sourceKey: quotaSourceKey(alerts[0]!) }, { id: 5, engine: 'claude', label: 'Main', state: 'enabled' });
    expect(data).toMatchObject({ engine: 'claude', account_id: '5', window: 'short', used_percent: '90', threshold: '85', resets_at: SHORT_RESET });
    expect(Object.values(data!).every((value) => typeof value === 'string')).toBe(true);
    await f.close();
  });
  it('honours a policy threshold, an unlimited policy and a suspended engine', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const policy = (p: object) => JSON.stringify({ unlimited: false, short_warn_percent: 85, long_warn_percent: 85, short_auto_resume: true, long_auto_resume: false, ...p });
    for (const [opts, count] of [
      [{ policy: policy({ short_warn_percent: 95 }) }, 0],
      [{ policy: policy({ long_warn_percent: 30 }) }, 2],
      [{ policy: policy({ unlimited: true }) }, 0],
      [{ disabled: true }, 0],
    ] as const) {
      const f = await ownerWorkerFixture(seed(opts));
      expect(await quotaAlerts(f.db, [{ id: 5, engine: 'claude', state: 'enabled' }])).toHaveLength(count);
      await f.close();
    }
    const f = await ownerWorkerFixture(seed());
    expect(await quotaAlerts(f.db, [{ id: 5, engine: 'claude', state: 'removed' }])).toEqual([]);
    expect(await quotaPushData(f.db, { sourceKey: 'quota:5:short:x' }, undefined)).toBeNull();
    await f.close();
  });
});

describe('owner quota push obligations', () => {
  it('schedules one quota obligation per device only when provider accounts exist', async () => {
    const f = await ownerWorkerFixture(seed());
    const push = new OwnerCompanionPush({ db: f.db, env, keyring: testKeyring() } as RouteContext);
    expect(push.obligations(f.state.snapshot()).filter((w) => w.key.startsWith('quota:'))).toEqual([
      expect.objectContaining({ key: 'quota:device', dueAt: 0 }),
    ]);
    const empty = await ownerWorkerFixture({ ...seed(), providerAccounts: [] } as unknown as StateSeed);
    const idle = new OwnerCompanionPush({ db: empty.db, env, keyring: testKeyring() } as RouteContext);
    expect(idle.obligations(empty.state.snapshot()).some((w) => w.key.startsWith('quota:'))).toBe(false);
    await f.close();
    await empty.close();
  });
  it('sends a quota job only while the account exists and its engine is on', async () => {
    const job = { id: 'j', deviceId: 'device', kind: 'quota', targetId: '5', sourceKey: `quota:5:short:${SHORT_RESET}`, expiresAt: '2999-01-01T00:00:00.000Z', state: 'pending', attempts: 0 };
    const eligible = async (s: StateSeed, j = job) => {
      const f = await ownerWorkerFixture(s);
      const push = new OwnerCompanionPush({ db: f.db, env, keyring: testKeyring() } as RouteContext);
      const result = (push as unknown as { eligible(s: unknown, j: unknown): unknown }).eligible(f.state.snapshot(), j);
      await f.close();
      return result;
    };
    expect(await eligible(seed())).toBeTruthy();
    expect(await eligible(seed({ disabled: true }))).toBeUndefined();
    expect(await eligible(seed(), { ...job, targetId: '6' })).toBeUndefined();
    expect(await eligible(seed(), { ...job, expiresAt: '2000-01-01T00:00:00.000Z' })).toBeUndefined();
  });
});
