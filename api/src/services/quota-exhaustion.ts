import { and, eq, gt, or } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { providerAccountSessions, versions } from '../db/schema.js';
import { ownerRuntimeFor } from '../control-plane/state/runtime.js';
import type { Engine } from '../util/engine.js';
import { nowIso } from '../util/timestamp.js';
import { LIVE_SWITCH_ENGINES } from './account-policy.js';
import { appendAuditLog } from './audit-log.js';
import { quotaSnapshot } from './quota-observation.js';
import { SettingsService } from './settings.js';
import { wsPublisher } from '../ws/publisher.js';

/**
 * A provider that refuses a turn with its usage limit is the one authority on
 * the account being exhausted. The statusline readings that feed the pool lag:
 * they repeat what the last successful response said (93 % and still counting),
 * and with per-window merging the highest share is held for an hour. So the
 * refusal itself is recorded, per account, in `versions`
 * (`account_quota_exhausted_<id>`), and scores the account 100 until it ends.
 *
 * It is deliberately not written as a usage reading: a reading is merged,
 * held and replaced by the next statusline report, shows on every dashboard
 * as a measured figure, and needs a reset time the refusal may not carry.
 */
export const QUOTA_EXHAUSTED_PREFIX = 'account_quota_exhausted_';
export const quotaExhaustedKey = (accountId: number) => `${QUOTA_EXHAUSTED_PREFIX}${accountId}`;

/** Without any reset on record the account is held back this long, then tried again. */
export const QUOTA_EXHAUSTED_DEFAULT_MS = 30 * 60_000;
/** A reset the server only inferred from a reading never holds an account longer than one short window. */
export const QUOTA_EXHAUSTED_INFERRED_MAX_MS = 5 * 3_600_000;
/** A reset the provider stated is believed up to a weekly window plus a day of slack. */
export const QUOTA_EXHAUSTED_MAX_MS = 8 * 86_400_000;
/** Resets closer together than this are the same window (as in the usage merge). */
const SAME_RESET_MS = 60_000;
/** A reading has to be this far along before its reset is taken for the limit that was hit. */
const INFERRED_WINDOW_MIN_PERCENT = 75;

export type QuotaExhaustionSource = 'provider_reset' | 'window_reset' | 'default';
export interface QuotaExhaustion {
  /** When the provider refused the turn. */
  at: string;
  /** The account scores 100 until then. */
  until: string;
  /** The window the limit belongs to, when that is known. */
  window: 'short' | 'long' | null;
  source: QuotaExhaustionSource;
  /** The resets on record when it was marked: a later reset proves a new window. */
  short_resets_at: string | null;
  long_resets_at: string | null;
  host_id: number;
  session_id: string;
}

const RANK: Record<QuotaExhaustionSource, number> = { default: 0, window_reset: 1, provider_reset: 2 };
const time = (value: unknown) => (typeof value === 'string' ? Date.parse(value) : NaN);
const text = (value: unknown) => (typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : null);

/** The stored marker while it holds; null for none, an unreadable one or one that has ended. */
export function parseQuotaExhaustion(raw: string | null | undefined, now = Date.now()): QuotaExhaustion | null {
  if (!raw) return null;
  let value: Record<string, unknown>;
  try {
    value = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (!value || typeof value !== 'object') return null;
  const until = time(value.until);
  if (!Number.isFinite(until) || until <= now || !Number.isFinite(time(value.at))) return null;
  return {
    at: value.at as string,
    until: value.until as string,
    window: value.window === 'short' || value.window === 'long' ? value.window : null,
    source: value.source === 'provider_reset' || value.source === 'window_reset' ? value.source : 'default',
    short_resets_at: text(value.short_resets_at),
    long_resets_at: text(value.long_resets_at),
    host_id: typeof value.host_id === 'number' ? value.host_id : 0,
    session_id: typeof value.session_id === 'string' ? value.session_id : '',
  };
}

/** Owner state and plain rows alike: anything that answers a `versions` key. */
export function ownedQuotaExhaustion(
  state: { setting(key: string): string | null | undefined },
  accountId: number,
  now = Date.now(),
): QuotaExhaustion | null {
  return parseQuotaExhaustion(state.setting(quotaExhaustedKey(accountId)), now);
}

export async function readQuotaExhaustion(
  db: Pick<Database, 'select'>,
  accountId: number,
  now = Date.now(),
): Promise<QuotaExhaustion | null> {
  const owner = ownerRuntimeFor(db);
  if (owner) {
    owner.assertOwner();
    return ownedQuotaExhaustion(owner.state.snapshot(), accountId, now);
  }
  const [row] = await db.select().from(versions).where(eq(versions.name, quotaExhaustedKey(accountId)));
  return parseQuotaExhaustion(row?.version, now);
}

interface Window {
  kind: 'short' | 'long';
  used_percent: number;
  resets_at: string | null;
  source: string;
}

/**
 * How long the refusal holds. The provider's own reset wins. Without one, the
 * window whose reading is furthest along is taken to be the one that ran out,
 * capped at one short window because that is an inference. Without any
 * reading a short default applies: the account is simply tried again later.
 */
export function quotaExhaustionEnd(
  now: number,
  providerReset: string | null | undefined,
  windows: Window[],
): Pick<QuotaExhaustion, 'until' | 'window' | 'source'> {
  const measured = windows.filter((w) => w.source !== 'emulated' && time(w.resets_at) > now);
  const stated = time(providerReset);
  if (Number.isFinite(stated) && stated > now && stated <= now + QUOTA_EXHAUSTED_MAX_MS) {
    const same = measured.find((w) => Math.abs(time(w.resets_at) - stated) <= 10 * 60_000);
    return {
      until: new Date(stated).toISOString(),
      window: same?.kind ?? (stated - now > QUOTA_EXHAUSTED_INFERRED_MAX_MS + 10 * 60_000 ? 'long' : null),
      source: 'provider_reset',
    };
  }
  const likely = measured
    .filter((w) => w.used_percent >= INFERRED_WINDOW_MIN_PERCENT)
    .sort((a, b) => b.used_percent - a.used_percent || time(b.resets_at) - time(a.resets_at))[0];
  if (likely)
    return {
      until: new Date(Math.min(time(likely.resets_at), now + QUOTA_EXHAUSTED_INFERRED_MAX_MS)).toISOString(),
      window: likely.kind,
      source: 'window_reset',
    };
  return { until: new Date(now + QUOTA_EXHAUSTED_DEFAULT_MS).toISOString(), window: null, source: 'default' };
}

/**
 * The refusal as the interruption a reset recovery is armed on
 * (`quotaInterruption` only knows a fresh reading of 100 %, which a refused
 * account often does not have). Only with a known window: which auto-resume
 * switch applies is not guessed, as there. And only where that switch is on:
 * a recovery the quota policy would stop is not attached to a watchdog that
 * ran without it before the refusal was recorded.
 */
export function exhaustionInterruption(
  marker: QuotaExhaustion | null,
  snapshot: { unlimited: boolean; account_state: string; policy: { short_auto_resume: boolean; long_auto_resume: boolean } } | null,
  now = Date.now(),
) {
  if (!marker?.window || !snapshot || snapshot.unlimited || snapshot.account_state !== 'enabled') return null;
  if (!(marker.window === 'short' ? snapshot.policy.short_auto_resume : snapshot.policy.long_auto_resume)) return null;
  return {
    kind: marker.window,
    enabled: true,
    reset_at: marker.until,
    retry_at: new Date(Math.max(now, Date.parse(marker.until)) + 60_000).toISOString(),
  };
}

/** A live lease of the host on the account: the refusal can only be about an account the host runs on. */
async function hostRunsOn(db: Database, hostId: number, engine: Engine, accountId: number): Promise<boolean> {
  const now = nowIso();
  const owner = ownerRuntimeFor(db);
  if (owner) {
    owner.assertOwner();
    return owner.state
      .snapshot()
      .table('providerAccountSessions')
      .all()
      .some(
        (r) =>
          r.hostId === hostId &&
          r.engine === engine &&
          r.accountId === accountId &&
          (r.ownershipMode === 'connection' || r.expiresAt > now),
      );
  }
  const rows = await db
    .select({ id: providerAccountSessions.id })
    .from(providerAccountSessions)
    .where(
      and(
        eq(providerAccountSessions.hostId, hostId),
        eq(providerAccountSessions.engine, engine),
        eq(providerAccountSessions.accountId, accountId),
        or(eq(providerAccountSessions.ownershipMode, 'connection'), gt(providerAccountSessions.expiresAt, now)),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

/**
 * Records that the provider refused a turn of `sessionId` on `accountId` with
 * its usage limit. Only engines with live switching keep the marker: only
 * there another account can take over the running session. Returns the marker
 * that holds afterwards, or null when nothing may be concluded (another
 * engine, an account the host does not run on, an unlimited or removed one).
 */
export async function recordQuotaExhaustion(
  db: Database,
  input: { engine: Engine; accountId: number; hostId: number; sessionId: string; retryNotBefore?: string | null; now?: number },
): Promise<QuotaExhaustion | null> {
  const { engine, accountId, hostId, sessionId } = input;
  const now = input.now ?? Date.now();
  if (!LIVE_SWITCH_ENGINES.has(engine)) return null;
  const snapshot = await quotaSnapshot(db, accountId, engine, now);
  // An account without a quota cannot run out; a removed one takes no work anyway.
  if (!snapshot || snapshot.unlimited || snapshot.account_state === 'removed') return null;
  if (!(await hostRunsOn(db, hostId, engine, accountId))) return null;
  const measured = snapshot.windows.filter((w) => w.source !== 'emulated');
  const reset = (kind: 'short' | 'long') => measured.find((w) => w.kind === kind)?.resets_at ?? null;
  const next: QuotaExhaustion = {
    at: new Date(now).toISOString(),
    ...quotaExhaustionEnd(now, input.retryNotBefore, measured),
    short_resets_at: reset('short'),
    long_resets_at: reset('long'),
    host_id: hostId,
    session_id: sessionId,
  };
  const current = await readQuotaExhaustion(db, accountId, now);
  // A second session failing on the same account repeats what is known. A
  // weaker statement never replaces a stronger one that still holds.
  if (
    current &&
    (RANK[current.source] > RANK[next.source] ||
      (RANK[current.source] === RANK[next.source] && time(current.until) >= time(next.until) - SAME_RESET_MS))
  )
    return current;
  await new SettingsService(db).set(quotaExhaustedKey(accountId), JSON.stringify(next), { publish: false });
  await appendAuditLog(db, {
    hostId,
    engine,
    action: 'provider_account.quota_exhausted',
    details: JSON.stringify({
      engine,
      account_id: accountId,
      session_id: sessionId,
      until: next.until,
      window: next.window,
      source: next.source,
      replaced: current ? { until: current.until, source: current.source } : null,
    }),
    createdAt: next.at,
  });
  wsPublisher.publish('accounts.updated', { account_id: accountId });
  return next;
}

/**
 * A reading that was just stored for the account. Lower or equal figures say
 * nothing: every session that has not asked the provider since repeats its old
 * ones. A later reset of the marked window does: the provider only moves it
 * when a new window has begun, so the limit that was hit is gone.
 */
export async function reconcileQuotaExhaustion(
  db: Database,
  engine: Engine,
  accountId: number,
  reading: { short_resets_at: string | null; long_resets_at: string | null },
  now = Date.now(),
): Promise<boolean> {
  const raw = await new SettingsService(db).getString(quotaExhaustedKey(accountId));
  if (raw === null) return false;
  const marker = parseQuotaExhaustion(raw, now);
  if (!marker) {
    // It ended on its own; the row goes with the next reading of the account.
    await clearQuotaExhaustion(db, engine, accountId, 'expired');
    return true;
  }
  const renewed = (kind: 'short' | 'long') => {
    const before = time(kind === 'short' ? marker.short_resets_at : marker.long_resets_at);
    const after = time(kind === 'short' ? reading.short_resets_at : reading.long_resets_at);
    return Number.isFinite(before) && Number.isFinite(after) && after - before > SAME_RESET_MS;
  };
  const window = marker.window ? (renewed(marker.window) ? marker.window : null) : (['long', 'short'] as const).find(renewed) ?? null;
  if (!window) return false;
  await clearQuotaExhaustion(db, engine, accountId, 'new_window', { window });
  return true;
}

export async function clearQuotaExhaustion(
  db: Database,
  engine: Engine,
  accountId: number,
  reason: string,
  details: Record<string, unknown> = {},
): Promise<void> {
  const settings = new SettingsService(db);
  if ((await settings.getString(quotaExhaustedKey(accountId))) === null) return;
  await settings.delete(quotaExhaustedKey(accountId), { publish: false });
  await appendAuditLog(db, {
    hostId: null,
    engine,
    action: 'provider_account.quota_exhaustion_cleared',
    details: JSON.stringify({ engine, account_id: accountId, reason, ...details }),
    createdAt: nowIso(),
  });
  wsPublisher.publish('accounts.updated', { account_id: accountId });
}
