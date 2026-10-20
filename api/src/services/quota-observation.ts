import { and, desc, eq } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { providerAccounts, chatgptUsageSnapshots, claudeUsageSnapshots, grokUsageSnapshots } from '../db/schema.js';
import { isEngine, type Engine } from '../util/engine.js';
import { readQuotaPolicy } from './quota-policy.js';

export interface QuotaRecovery {
  account_id: number; window: 'short' | 'long'; native_session_id: string;
  reset_at: string | null; attempts: number; attempt_at: string | null;
}
export async function quotaRecoveryAllowed(db: Pick<Database, 'select'>, engine: Engine, accountId: number, window: string | null) {
  const { effective: p } = await readQuotaPolicy(db, engine, accountId);
  return !p.unlimited && (window === 'short' ? p.short_auto_resume : p.long_auto_resume);
}
export interface QuotaWindow {
  kind: 'short' | 'long'; used_percent: number; limit_seconds: number | null;
  resets_at: string | null; observed_at: string; source: string;
  status: 'fresh' | 'stale';
}
export type QuotaSnapshot = Awaited<ReturnType<typeof quotaSnapshot>>;
export async function quotaSnapshot(db: Pick<Database, 'select'>, accountId: number, engine: Engine, now = Date.now()) {
  const [account] = await db.select().from(providerAccounts).where(and(eq(providerAccounts.id, accountId), eq(providerAccounts.engine, engine)));
  if (!account || account.mergedIntoAccountId || !isEngine(account.engine)) return null;
  const policy = await readQuotaPolicy(db, engine, accountId);
  const windows: QuotaWindow[] = [];
  const add = (kind: 'short' | 'long', used: number | null | undefined, reset: string | null | undefined, seconds: number | null, observed: string | undefined, source: string, failed = false) => {
    if (typeof used !== 'number' || !Number.isFinite(used) || !observed) return;
    const resetAt = reset && Number.isFinite(Date.parse(reset)) ? reset : null;
    const fresh = !failed && Number.isFinite(Date.parse(observed)) && now - Date.parse(observed) <= 600000 && Date.parse(observed) <= now + 30000 && (!resetAt || Date.parse(resetAt) > now);
    windows.push({ kind, used_percent: used, limit_seconds: seconds, resets_at: resetAt, observed_at: observed, source, status: fresh ? 'fresh' : 'stale' });
  };
  if (engine === 'codex') {
    // Include failed refreshes: an older successful row must not hide an outage.
    const [r] = await db.select().from(chatgptUsageSnapshots).where(eq(chatgptUsageSnapshots.accountId, accountId)).orderBy(desc(chatgptUsageSnapshots.id)).limit(1);
    for (const [used, reset, seconds] of [[r?.primaryUsedPercent, r?.primaryResetAt, r?.primaryLimitSeconds], [r?.secondaryUsedPercent, r?.secondaryResetAt, r?.secondaryLimitSeconds]] as const) {
      if (typeof seconds === 'number' && seconds > 0) add(seconds < 86400 ? 'short' : 'long', used, reset, seconds, r?.fetchedAt, 'chatgpt_usage', r?.status !== 'ok');
    }
  } else if (engine === 'claude') {
    const [r] = await db.select().from(claudeUsageSnapshots).where(eq(claudeUsageSnapshots.accountId, accountId)).orderBy(desc(claudeUsageSnapshots.id)).limit(1);
    add('short', r?.fiveHourUsedPercent, r?.fiveHourResetsAt, 18000, r?.fetchedAt, 'claude_statusline');
    add('long', r?.sevenDayUsedPercent, r?.sevenDayResetsAt, 604800, r?.fetchedAt, 'claude_statusline');
  } else {
    const [r] = await db.select().from(grokUsageSnapshots).where(eq(grokUsageSnapshots.accountId, accountId)).limit(1);
    if (r?.periodType === 'weekly' || r?.periodType === 'monthly') add('long', r.usedPercent, r.periodResetsAt, r.periodType === 'weekly' ? 604800 : null, r.fetchedAt ?? undefined, 'grok_subscription', !!r.errorCode);
  }
  return { account_id: account.id, account_label: account.label, account_state: account.state, engine,
    unlimited: policy.effective.unlimited, policy: policy.effective,
    status: policy.effective.unlimited ? 'unlimited' : !windows.length ? 'unavailable' : windows.some(w => w.status === 'stale') ? 'stale' : 'fresh',
    windows, short: windows.find(w => w.kind === 'short') ?? null, long: windows.find(w => w.kind === 'long') ?? null,
    server_time: new Date(now).toISOString(),
  };
}

/** A provider error proves interruption; quota observations determine its scope. */
export function quotaInterruption(snapshot: QuotaSnapshot, explicit: boolean, retry?: string, now = Date.now()) {
  if (!snapshot || snapshot.unlimited || snapshot.account_state !== 'enabled') return null;
  const blocked = snapshot.windows.filter(w => w.used_percent >= 100 && w.status === 'fresh');
  if (!explicit && !blocked.length) return null;
  const window = blocked.find(w => w.kind === 'long') ?? blocked[0];
  // Without scope evidence do not guess that a weekly interruption is a short one.
  if (!window) return null;
  const enabled = window.kind === 'short' ? snapshot.policy.short_auto_resume : snapshot.policy.long_auto_resume;
  const times = [...blocked.map(w => Date.parse(w.resets_at ?? '')), Date.parse(retry ?? '')].filter(Number.isFinite);
  const reset = times.length ? Math.max(...times) : null;
  return { kind: window.kind, enabled, reset_at: reset === null ? null : new Date(reset).toISOString(),
    retry_at: new Date(Math.max(now, reset ?? now) + 60000).toISOString() };
}

export function quotaResumeGate(snapshot: QuotaSnapshot, kind: string | null, resetAt: string | null, attempts: number, attemptAt: string | null, now: number) {
  if (!snapshot || snapshot.unlimited || snapshot.account_state !== 'enabled') return { stop: 'quota_policy_disabled' };
  if (!(kind === 'short' ? snapshot.policy.short_auto_resume : snapshot.policy.long_auto_resume)) return { stop: 'quota_auto_resume_disabled' };
  const blockers = snapshot.windows.filter(w => w.used_percent >= 100 && (w.status === 'fresh' || Date.parse(w.resets_at ?? '') > now));
  if (blockers.some(w => w.kind === 'long' && !snapshot.policy.long_auto_resume)) return { stop: 'long_quota_limit' };
  const resets = [resetAt, ...blockers.map(w => w.resets_at)].map(v => Date.parse(v ?? '')).filter(Number.isFinite);
  const due = resets.length ? Math.max(...resets) + 60000 : 0;
  if (due > now) return { wait_until: new Date(due).toISOString() };
  if (attempts >= 4) return { stop: 'quota_resume_attempts_exhausted' };
  if (attemptAt) {
    const retry = Date.parse(attemptAt) + [300, 900, 1800][Math.max(0, Math.min(attempts - 1, 2))]! * 1000;
    if (retry > now) return { wait_until: new Date(retry).toISOString() };
  }
  return { ready: true };
}
