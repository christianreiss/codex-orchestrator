import { eq } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { authPayloads, providerAccounts } from '../db/schema.js';
import { ownerRuntimeFor } from '../control-plane/state/runtime.js';
import type { Engine } from '../util/engine.js';
import { LIVE_SWITCH_ENGINES, policyCeiling, readAccountPolicy, type AccountPolicy } from './account-policy.js';
import { quotaWindowScore } from './account-selection.js';
import { poolPosition } from './account-switch.js';
import { quotaAttemptGate, quotaResumeGate, quotaSnapshot, type QuotaRecovery } from './quota-observation.js';
import { readQuotaExhaustion, type QuotaExhaustion } from './quota-exhaustion.js';
import type { QuotaPolicy } from './quota-policy.js';
import { SettingsService } from './settings.js';

/**
 * How long a recovery waits for the live switch of its session before it falls
 * back to the reset of the account it failed on. The wrapper commits a pending
 * switch at the next turn boundary; a transcript that does not end on a
 * finished turn can hold that back for about fifteen minutes.
 */
export const QUOTA_SWITCH_WAIT_MS = 20 * 60_000;
/** How often a recovery looks whether its session has moved. */
export const QUOTA_SWITCH_POLL_MS = 15_000;
/** The same once the switch is late and the reset of the failed account is what it waits for. */
export const QUOTA_SWITCH_LATE_POLL_MS = 5 * 60_000;
/** The margin every reset wait adds, as in `quotaResumeGate`. */
const RESET_MARGIN_MS = 60_000;

export interface PoolQuotaAccount {
  id: number;
  label: string;
  /** Enabled and verified: the account can take work and live switches. */
  usable: boolean;
  /** The pool score (`poolPosition`): 100 for a marked or blocked account. */
  score: number | null;
  exhausted: QuotaExhaustion | null;
  /** When a full account has room again; null while that is unknown (or it is not full). */
  available_at: number | null;
  /** The window that keeps it full, for the auto-resume switches of its quota policy. */
  wait_kind: 'short' | 'long';
  policy: QuotaPolicy;
}

export interface PoolQuotaState {
  policy: AccountPolicy;
  /** The score from which an account hands over (`policyCeiling`). */
  ceiling: number;
  accounts: PoolQuotaAccount[];
}

/**
 * The pool as the quota recovery sees it: every account of the engine with the
 * score the policy uses, without credential reads, plan lookups or writes, so
 * it may be read inside a schedule or watchdog command.
 */
export async function poolQuotaState(db: Database, engine: Engine, now = Date.now()): Promise<PoolQuotaState> {
  const owner = ownerRuntimeFor(db);
  owner?.assertOwner();
  const state = owner?.state.snapshot();
  const rows = state
    ? state.accounts.by('engine', engine)
    : await db.select().from(providerAccounts).where(eq(providerAccounts.engine, engine));
  const policy = await readAccountPolicy(db, engine);
  const limit = Math.max(50, Math.min(100, await new SettingsService(db).getInt('quota_limit_percent', 95)));
  const ceiling = policyCeiling(policy, limit);
  const accounts: PoolQuotaAccount[] = [];
  for (const row of [...rows].sort((a, b) => a.id - b.id)) {
    if (row.state === 'removed' || row.mergedIntoAccountId) continue;
    const snapshot = await quotaSnapshot(db, row.id, engine, now);
    if (!snapshot) continue;
    const verification = !row.payloadId
      ? undefined
      : state
        ? state.table('authPayloads').get(row.payloadId)?.verificationState
        : (await db.select({ state: authPayloads.verificationState }).from(authPayloads).where(eq(authPayloads.id, row.payloadId)))[0]?.state;
    const measured = snapshot.windows.filter((w) => w.source !== 'emulated');
    const window = (kind: 'short' | 'long') => measured.find((w) => w.kind === kind);
    const exhausted = snapshot.unlimited ? null : await readQuotaExhaustion(db, row.id, now);
    const position = poolPosition(
      {
        state: row.state,
        verification_state: verification ?? 'pending',
        usage: {
          short_used_percent: window('short')?.used_percent ?? null,
          short_resets_at: window('short')?.resets_at ?? null,
          weekly_used_percent: window('long')?.used_percent ?? null,
          weekly_resets_at: window('long')?.resets_at ?? null,
        },
        quota_policy: { unlimited: snapshot.unlimited },
        quota_snapshot: snapshot,
        quota_exhausted: exhausted,
      },
      now,
    );
    const blockers: { at: number; kind: 'short' | 'long' }[] = [];
    if (exhausted) blockers.push({ at: Date.parse(exhausted.until), kind: exhausted.window ?? 'short' });
    for (const w of measured) {
      const at = Date.parse(w.resets_at ?? '');
      if (Number.isFinite(at) && (quotaWindowScore(w.used_percent, w.resets_at, now) ?? 0) >= ceiling) blockers.push({ at, kind: w.kind });
    }
    const emulated = Date.parse(snapshot.short?.resets_at ?? '');
    if (position.emulation_blocked && Number.isFinite(emulated)) blockers.push({ at: emulated, kind: 'short' });
    accounts.push({
      id: row.id,
      label: row.label,
      usable: position.usable,
      score: position.score,
      exhausted,
      available_at: blockers.length ? Math.max(...blockers.map((b) => b.at)) : null,
      wait_kind: blockers.some((b) => b.kind === 'long') ? 'long' : 'short',
      policy: snapshot.policy,
    });
  }
  return { policy, ceiling, accounts };
}

/** Usable accounts that can take work below the ceiling. */
export function poolHeadroom(state: PoolQuotaState): PoolQuotaAccount[] {
  return state.accounts.filter((a) => a.usable && (a.score ?? 0) < state.ceiling);
}

/**
 * Whether a turn that failed on `accountId` can go on elsewhere: the engine
 * switches accounts in a running session, the operator chose automatic
 * distribution, and another usable account has room. This is the account
 * policy's side of the split; waiting for a reset stays with the quota policy's
 * `short_auto_resume` / `long_auto_resume`.
 */
export async function poolContinuePossible(db: Database, engine: Engine, accountId: number, now = Date.now()): Promise<boolean> {
  if (!LIVE_SWITCH_ENGINES.has(engine)) return false;
  const state = await poolQuotaState(db, engine, now);
  return state.policy.mode === 'auto' && poolHeadroom(state).some((a) => a.id !== accountId);
}

/** The pool decides a recovery of `accountId` rather than that account alone. */
function pooled(state: PoolQuotaState, accountId: number): boolean {
  return state.policy.mode === 'auto' && state.accounts.some((a) => a.usable && a.id !== accountId);
}

/**
 * Whether the recovery of a turn that failed on `accountId` follows the pool:
 * an engine with live switching, the `auto` account policy and another usable
 * account. Then the reset of `accountId` is not a time to wait for by itself;
 * `quotaRecoveryGate` produces the wait.
 */
export async function poolRecoveryApplies(db: Database, engine: Engine, accountId: number, now = Date.now()): Promise<boolean> {
  return LIVE_SWITCH_ENGINES.has(engine) && pooled(await poolQuotaState(db, engine, now), accountId);
}

export type QuotaGate =
  | { stop: string }
  /** `reset_at`: the reset the wait is for, when `wait_until` is only the next look. */
  | { wait_until: string; reason: 'quota_wait' | 'quota_switch_wait'; reset_at?: string }
  | { ready: true; account_id: number | null; account_label: string | null };

/**
 * When an interrupted session may go on. The account it failed on is where the
 * interruption was observed, not where the recovery has to happen:
 *
 * - The session now runs on a usable account with room (its live switch is
 *   committed), the account it failed on has room again, or the session is gone
 *   and a new launch would get an account with room: ready.
 * - Another account has room but the session has not moved yet: look again
 *   shortly, for at most `QUOTA_SWITCH_WAIT_MS` after `switchSince`.
 * - No usable account has room: wait for the earliest one to get it back
 *   (+60 s), where the quota policy of that account lets a recovery wait for
 *   its window.
 *
 * Other engines, the manual account policy and a pool of one account keep the
 * gate of the single account (`quotaResumeGate`). The native-session fence and
 * the attempt budget are the same on every path.
 */
export async function quotaRecoveryGate(
  db: Database,
  input: {
    engine: Engine;
    quota: Pick<QuotaRecovery, 'account_id' | 'native_session_id' | 'reset_at' | 'attempts' | 'attempt_at'> & { window: string | null };
    target: { lastUpstreamSessionId: string | null; continuity: string | null } | undefined;
    /** The target's current session, when it has one that has not ended. */
    session: { providerAccountId: number | null; endedAt: string | null } | null | undefined;
    /** Since when the session's switch is awaited (null: the marker's time decides). */
    switchSince?: string | null;
    now: number;
  },
): Promise<QuotaGate> {
  const { engine, quota: q, now } = input;
  if (input.target?.lastUpstreamSessionId !== q.native_session_id || input.target.continuity !== 'native')
    return { stop: 'quota_native_session_changed' };
  const single = async (): Promise<QuotaGate> => {
    const gate = quotaResumeGate(await quotaSnapshot(db, q.account_id, engine, now), q.window, q.reset_at, q.attempts, q.attempt_at, now);
    if ('stop' in gate) return { stop: gate.stop! };
    if ('wait_until' in gate) return { wait_until: gate.wait_until!, reason: 'quota_wait' };
    return { ready: true, account_id: q.account_id, account_label: null };
  };
  if (!LIVE_SWITCH_ENGINES.has(engine)) return single();
  const state = await poolQuotaState(db, engine, now);
  const usable = state.accounts.filter((a) => a.usable);
  if (!pooled(state, q.account_id)) return single();
  const headroom = poolHeadroom(state);
  const live = !!input.session && !input.session.endedAt;
  const bound = live ? (input.session!.providerAccountId ?? null) : null;
  const moved = bound !== null && bound !== q.account_id ? headroom.find((a) => a.id === bound) : undefined;
  const recovered = headroom.find((a) => a.id === q.account_id);
  if (moved || recovered || (!live && headroom.length)) {
    const attempt = quotaAttemptGate(q.attempts, q.attempt_at, now);
    if ('stop' in attempt) return { stop: attempt.stop! };
    if ('wait_until' in attempt) return { wait_until: attempt.wait_until!, reason: 'quota_wait' };
    const account = moved ?? (live ? recovered : undefined);
    return { ready: true, account_id: account?.id ?? null, account_label: account?.label ?? null };
  }
  if (headroom.length) {
    // The policy moves the scope at its next turn boundary; the session is
    // still bound to the account it failed on (or to another full one).
    const since = Date.parse(input.switchSince ?? state.accounts.find((a) => a.id === q.account_id)?.exhausted?.at ?? '');
    if (Number.isFinite(since) && now - since < QUOTA_SWITCH_WAIT_MS)
      return { wait_until: new Date(now + QUOTA_SWITCH_POLL_MS).toISOString(), reason: 'quota_switch_wait' };
    // The switch is late (a sibling's long turn, a wrapper without live
    // switching). The reset of the failed account decides from here on, but a
    // switch that still comes is not slept through until then.
    const gate = await single();
    if (!('wait_until' in gate) || Date.parse(gate.wait_until) <= now + QUOTA_SWITCH_LATE_POLL_MS) return gate;
    return { wait_until: new Date(now + QUOTA_SWITCH_LATE_POLL_MS).toISOString(), reason: 'quota_wait', reset_at: gate.wait_until };
  }
  // The whole pool is full: the first account to get room back ends the wait,
  // not the one the turn happened to fail on.
  const known = usable.filter((a) => a.available_at !== null);
  const permitted = known.filter((a) => !a.policy.unlimited && (a.wait_kind === 'short' ? a.policy.short_auto_resume : a.policy.long_auto_resume));
  if (!permitted.length) return known.length ? { stop: 'quota_auto_resume_disabled' } : single();
  const due = Math.min(...permitted.map((a) => a.available_at!)) + RESET_MARGIN_MS;
  // A reset that has passed while the reading still says full: look again soon.
  return { wait_until: new Date(Math.max(due, now + RESET_MARGIN_MS)).toISOString(), reason: 'quota_wait' };
}
