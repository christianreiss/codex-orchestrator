import type { Database } from '../../db/client.js';
import { roleHasCapability } from '../../security/capabilities.js';
import { quotaSnapshot, type QuotaWindow } from '../quota-observation.js';
import { readFleetEngineState } from '../engine-switch.js';
import { isEngine, type Engine } from '../../util/engine.js';

/**
 * Quota warning push (R4). One push per device per account window: the outbox
 * source key `quota:<account>:<short|long>:<resets_at>` is unique per device
 * (companion_notifications), and a job lives until its window resets plus the
 * one-day outbox retention, so a window can never re-push. Reset timestamps
 * that drift by a few seconds between samples are matched to the existing key.
 */
export const QUOTA_PUSH_PREFIX = 'quota:';
const SAME_WINDOW_MS = 3600_000;

export interface QuotaAlert {
  accountId: number;
  engine: Engine;
  kind: QuotaWindow['kind'];
  usedPercent: number;
  threshold: number;
  resetsAt: string;
  limitSeconds: number | null;
}

/** Same capabilities as GET /companion/v1/quotas. */
export function quotaPushAllowed(accessLevel: string): boolean {
  return roleHasCapability(accessLevel, 'admin.read') && roleHasCapability(accessLevel, 'auth.read_metadata');
}

export function quotaSourceKey(alert: Pick<QuotaAlert, 'accountId' | 'kind' | 'resetsAt'>): string {
  return `${QUOTA_PUSH_PREFIX}${alert.accountId}:${alert.kind}:${alert.resetsAt}`;
}

export function parseQuotaSourceKey(key: string): { accountId: number; kind: 'short' | 'long'; resetsAt: string } | null {
  const match = /^quota:(\d+):(short|long):(.+)$/.exec(key);
  return match ? { accountId: Number(match[1]), kind: match[2] as 'short' | 'long', resetsAt: match[3]! } : null;
}

/** True when an existing source key already covers this alert's window. */
export function coversQuotaWindow(existingKey: string, alert: Pick<QuotaAlert, 'accountId' | 'kind' | 'resetsAt'>): boolean {
  const existing = parseQuotaSourceKey(existingKey);
  if (!existing || existing.accountId !== alert.accountId || existing.kind !== alert.kind) return false;
  return Math.abs(Date.parse(existing.resetsAt) - Date.parse(alert.resetsAt)) < SAME_WINDOW_MS;
}

/** The outbox job must outlive its window; clamp absurd provider timestamps. */
export function quotaJobExpiresAt(resetsAt: string, now = Date.now()): string {
  const reset = Date.parse(resetsAt);
  return new Date(Math.min(Math.max(reset, now + 60_000), now + 8 * 86400_000)).toISOString();
}

/** Windows at or above the effective warn threshold, from the same snapshot quota_get uses. */
export async function quotaAlerts(
  db: Pick<Database, 'select'>,
  accounts: ReadonlyArray<{ id: number; engine: string; state: string }>,
  now = Date.now(),
): Promise<QuotaAlert[]> {
  const fleet = await readFleetEngineState(db);
  const alerts: QuotaAlert[] = [];
  for (const account of accounts) {
    if (!isEngine(account.engine) || !fleet[account.engine] || account.state === 'removed') continue;
    const q = await quotaSnapshot(db, account.id, account.engine, now);
    if (!q || q.unlimited || !['enabled', 'paused'].includes(q.account_state)) continue;
    for (const w of q.windows) {
      const threshold = w.kind === 'short' ? q.policy.short_warn_percent : q.policy.long_warn_percent;
      if (w.status !== 'fresh' || !w.resets_at || threshold === null || w.used_percent < threshold) continue;
      alerts.push({
        accountId: account.id,
        engine: account.engine,
        kind: w.kind,
        usedPercent: w.used_percent,
        threshold,
        resetsAt: w.resets_at,
        limitSeconds: w.limit_seconds,
      });
    }
  }
  return alerts;
}

/** Window name as GET /companion/v1/quotas spells it. */
function windowName(engine: string, kind: 'short' | 'long', limitSeconds: number | null): string {
  if (kind === 'short') return 'short';
  return engine === 'grok' && limitSeconds !== 604800 ? 'monthly' : 'weekly';
}

/**
 * FCM data for a quota job, read fresh at send time. Null when the account or
 * window is gone, so the job is canceled rather than sent stale.
 */
export async function quotaPushData(
  db: Pick<Database, 'select'>,
  job: { sourceKey: string },
  account: { id: number; engine: string; label: string; state: string } | undefined,
): Promise<Record<string, string> | null> {
  const key = parseQuotaSourceKey(job.sourceKey);
  if (!key || !account || !isEngine(account.engine) || account.state === 'removed') return null;
  if (!(await readFleetEngineState(db))[account.engine]) return null;
  const q = await quotaSnapshot(db, account.id, account.engine);
  const w = q?.windows.find((window) => window.kind === key.kind);
  const threshold = q ? (key.kind === 'short' ? q.policy.short_warn_percent : q.policy.long_warn_percent) : null;
  return {
    engine: account.engine,
    account_id: String(account.id),
    account_label: account.label,
    window: windowName(account.engine, key.kind, w?.limit_seconds ?? null),
    used_percent: String(w?.used_percent ?? ''),
    threshold: String(threshold ?? ''),
    resets_at: w?.resets_at ?? key.resetsAt,
    conversation_key: `quota:${account.engine}`,
    summary: `${account.label}: ${w?.used_percent ?? '?'}% of the ${key.kind === 'short' ? 'short' : 'long'} quota window used.`,
  };
}
