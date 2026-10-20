import { describe, it, expect } from 'vitest';
import { quotaSnapshot, quotaInterruption, quotaResumeGate } from '../../../src/services/quota-observation.js';
import { readQuotaPolicy, DEFAULT_QUOTA_POLICY } from '../../../src/services/quota-policy.js';
import { agentSessions, providerAccounts, versions, chatgptUsageSnapshots, claudeUsageSnapshots, grokUsageSnapshots } from '../../../src/db/schema.js';
import { createDbFake } from '../../helpers/db-fake.js';
import { warnQuotaSessions } from '../../../src/ops/quota-worker.js';
const now = Date.parse('2026-10-20T12:00:00Z');
const iso = (delta: number) => new Date(now + delta * 1000).toISOString();
function fixture(engine = 'claude') {
  const db = createDbFake();
  db.tables.set(providerAccounts, [{ id: 1, engine, state: 'enabled', label: 'One' }, { id: 2, engine, state: 'enabled', label: 'Two' }]);
  db.tables.set(claudeUsageSnapshots, [{ id: 1, accountId: 1, fetchedAt: iso(-10), fiveHourUsedPercent: 100, fiveHourResetsAt: iso(300), sevenDayUsedPercent: 80, sevenDayResetsAt: iso(86400) }, { id: 2, accountId: 2, fetchedAt: iso(-10), fiveHourUsedPercent: 0 }]);
  return db;
}
describe('account quota observation and recovery policy', () => {
  it('isolates accounts and retains true zero and absent windows', async () => {
    const db = fixture();
    const one = await quotaSnapshot(db as never, 1, 'claude', now);
    const two = await quotaSnapshot(db as never, 2, 'claude', now);
    expect(one?.short?.used_percent).toBe(100);
    expect(two?.short?.used_percent).toBe(0);
    expect(two?.long).toBeNull();
    expect(await quotaSnapshot(db as never, 1, 'codex', now)).toBeNull();
  });
  it('uses duration instead of provider slot order and reports stale reset data', async () => {
    const db = fixture('codex');
    db.tables.set(chatgptUsageSnapshots, [{ id: 1, accountId: 1, status: 'ok', fetchedAt: iso(-1), primaryUsedPercent: 0, primaryLimitSeconds: 604800, primaryResetAt: iso(900), secondaryUsedPercent: 90, secondaryLimitSeconds: 18000, secondaryResetAt: iso(-1) }]);
    const q = await quotaSnapshot(db as never, 1, 'codex', now);
    expect(q?.long?.used_percent).toBe(0);
    expect(q?.short?.status).toBe('stale');
    expect(q?.status).toBe('stale');
  });
  it('supports Grok monthly periods without fabricating a short window', async () => {
    const db = fixture('grok');
    db.tables.set(grokUsageSnapshots, [{ accountId: 1, usedPercent: 71, periodType: 'monthly', periodResetsAt: iso(900), fetchedAt: iso(-1) }]);
    const q = await quotaSnapshot(db as never, 1, 'grok', now);
    expect(q?.short).toBeNull(); expect(q?.long?.used_percent).toBe(71);
  });
  it('inherits defaults and makes explicit unlimited authoritative', async () => {
    const db = fixture();
    db.tables.set(versions, [{ name: 'quota_policy_claude', version: JSON.stringify({ ...DEFAULT_QUOTA_POLICY, short_warn_percent: 70 }) }, { name: 'quota_policy_account_1', version: JSON.stringify({ ...DEFAULT_QUOTA_POLICY, unlimited: true }) }]);
    const policy = await readQuotaPolicy(db as never, 'claude', 2);
    expect(policy.effective.short_warn_percent).toBe(70);
    const q = await quotaSnapshot(db as never, 1, 'claude', now);
    expect(q?.status).toBe('unlimited'); expect(q?.short?.used_percent).toBe(100);
    expect(quotaInterruption(q, true, iso(300), now)).toBeNull();
    expect(quotaResumeGate(q, 'short', iso(300), 0, null, now)).toEqual({ stop: 'quota_policy_disabled' });
  });
  it('does not arm from high usage below a proven exhausted window', async () => {
    const db = fixture();
    const q = await quotaSnapshot(db as never, 1, 'claude', now);
    expect(quotaInterruption(q, false, undefined, now)).toMatchObject({ kind: 'short', enabled: true, retry_at: iso(360) });
    const two = await quotaSnapshot(db as never, 2, 'claude', now);
    expect(quotaInterruption(two, false, undefined, now)).toBeNull();
    expect(quotaInterruption(two, true, undefined, now)).toBeNull();
  });
  it('waits for all blocking windows and honors disabled long resume', async () => {
    const db = fixture();
    db.tables.get(claudeUsageSnapshots)![0]!.sevenDayUsedPercent = 100;
    const q = await quotaSnapshot(db as never, 1, 'claude', now);
    expect(quotaInterruption(q, false, undefined, now)).toMatchObject({ kind: 'long', enabled: false });
    expect(quotaResumeGate(q, 'short', iso(300), 0, null, now)).toEqual({ stop: 'long_quota_limit' });
    q!.policy.long_auto_resume = true;
    expect(quotaResumeGate(q, 'short', iso(300), 0, null, now)).toEqual({ wait_until: iso(86460) });
  });
  it('permits bounded reset probes with stale data and stops unlimited retry loops', async () => {
    const db = fixture(); const q = await quotaSnapshot(db as never, 1, 'claude', now + 1000000);
    expect(quotaResumeGate(q, 'short', iso(300), 0, null, now + 1000000)).toEqual({ ready: true });
    expect(quotaResumeGate(q, 'short', null, 1, iso(1000), now + 1000000)).toEqual({ wait_until: iso(1300) });
    expect(quotaResumeGate(q, 'short', null, 4, iso(1000), now + 1000000)).toEqual({ stop: 'quota_resume_attempts_exhausted' });
  });
  it('emits stable warning IDs across sweeps and only for active bound sessions', async () => {
    const db = fixture(); const real = Date.now();
    db.tables.set(versions, [{ name: 'fleet_engine_claude_enabled', version: '1' }]);
    db.tables.get(claudeUsageSnapshots)![0]!.fetchedAt = new Date(real).toISOString();
    db.tables.get(claudeUsageSnapshots)![0]!.fiveHourResetsAt = new Date(real + 3600000).toISOString();
    db.tables.set(agentSessions, [{ id: 's1', engine: 'claude', status: 'active', endedAt: null, providerAccountId: 1, agentBusAddressId: 'a1', heartbeatAt: new Date(real).toISOString() }, { id: 's2', engine: 'claude', status: 'active', endedAt: null }]);
    const ids: string[] = [];
    const notify = async (_ids: string[], _body: string, key: string) => { ids.push(key); };
    await warnQuotaSessions(db as never, notify); await warnQuotaSessions(db as never, notify);
    expect(ids.length).toBe(2); expect(ids[0]).toBe(ids[1]);
  });
});
