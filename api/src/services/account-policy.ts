import { z } from 'zod';
import type { Database } from '../db/client.js';
import { ValidationError } from '../http/errors.js';
import type { Engine } from '../util/engine.js';
import { SettingsService } from './settings.js';
import { appendAuditLog } from './audit-log.js';
import { nowIso } from '../util/timestamp.js';
import { selectAccount, selectionOrder, trialDue, weeklyDeadline, type AccountChoice } from './account-selection.js';

/**
 * Per-engine distribution policy for a provider account pool.
 * - balanced: keep every account within `spread` points of the others; a scope
 *   moves once its account is more than the band above the least-used one.
 * - exhaust: use accounts in ID order up to the soft ceiling, then the next;
 *   when all are above it, fill up to the hard ceiling.
 * - reset_aware: like exhaust, but in the order of the weekly resets: the
 *   account whose weekly quota expires first is used first, a freshly reset
 *   one last. Quota left at a reset is lost; quota in a new window keeps.
 * - manual: no automatic moves; only explicit switches.
 */
export const SPREAD_POINTS = { eng: 10, normal: 20, locker: 30 } as const;
export type Spread = keyof typeof SPREAD_POINTS;

const policySchema = z
  .object({
    mode: z.enum(['auto', 'manual']),
    strategy: z.enum(['balanced', 'exhaust', 'reset_aware']),
    spread: z.enum(['eng', 'normal', 'locker']),
    soft_ceiling: z.number().int().min(50).max(99),
    hard_ceiling: z.number().int().min(50).max(100),
    min_dwell_minutes: z.number().int().min(0).max(240),
  })
  .strict()
  .refine((p) => p.hard_ceiling >= p.soft_ceiling, { message: 'hard_ceiling must be at least soft_ceiling' });

export type StoredAccountPolicy = z.infer<typeof policySchema>;
export interface AccountPolicy extends StoredAccountPolicy {
  spread_points: number;
}

export const DEFAULT_ACCOUNT_POLICY: StoredAccountPolicy = {
  mode: 'auto',
  strategy: 'balanced',
  spread: 'normal',
  soft_ceiling: 90,
  hard_ceiling: 99,
  min_dwell_minutes: 15,
};

export const accountPolicyKey = (engine: Engine) => `account_policy_${engine}`;

/** Engines whose wrapper can adopt another account inside a running session. */
export const LIVE_SWITCH_ENGINES: ReadonlySet<Engine> = new Set<Engine>(['claude']);

function withPoints(policy: StoredAccountPolicy): AccountPolicy {
  return { ...policy, spread_points: SPREAD_POINTS[policy.spread] };
}

/** Parses a stored value; an unreadable setting falls back to the default. */
export function parseStoredPolicy(raw: string | null | undefined): AccountPolicy {
  if (!raw) return withPoints(DEFAULT_ACCOUNT_POLICY);
  try {
    const parsed = policySchema.safeParse({ ...DEFAULT_ACCOUNT_POLICY, ...JSON.parse(raw) });
    return withPoints(parsed.success ? parsed.data : DEFAULT_ACCOUNT_POLICY);
  } catch {
    return withPoints(DEFAULT_ACCOUNT_POLICY);
  }
}

export async function readAccountPolicy(db: Database, engine: Engine): Promise<AccountPolicy> {
  return parseStoredPolicy(await new SettingsService(db).getString(accountPolicyKey(engine)));
}

export async function writeAccountPolicy(
  db: Database,
  engine: Engine,
  patch: unknown,
  actor: string | null = null,
): Promise<AccountPolicy> {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch))
    throw new ValidationError('policy must be an object');
  const current = await readAccountPolicy(db, engine);
  const { spread_points: _ignored, ...stored } = current;
  const parsed = policySchema.safeParse({ ...stored, ...(patch as Record<string, unknown>) });
  if (!parsed.success) throw new ValidationError(parsed.error.issues[0]?.message ?? 'Invalid account policy');
  await new SettingsService(db).set(accountPolicyKey(engine), JSON.stringify(parsed.data));
  // The policy moves running sessions between subscriptions: who changed it,
  // and from what, belongs in the audit log like a quota policy change.
  if (JSON.stringify(stored) !== JSON.stringify(parsed.data))
    await appendAuditLog(db, {
      action: 'account.policy.updated',
      details: JSON.stringify({ engine, actor, before: stored, after: parsed.data }),
      createdAt: nowIso(),
    });
  return withPoints(parsed.data);
}

export interface PolicyCandidate extends AccountChoice {
  /** Unmeasured accounts count as unused for comparisons. */
  score: number | null;
}

const effective = (score: number | null) => score ?? 0;
const exhausts = (policy: AccountPolicy) => policy.mode === 'auto' && policy.strategy === 'exhaust';
const resetAware = (policy: AccountPolicy) => policy.mode === 'auto' && policy.strategy === 'reset_aware';

/**
 * Reset-aware guards for moving a running scope (a launch has no prompt cache
 * to lose and ignores them): the target's weekly reset must be at least
 * RESET_LEAD_MS earlier than the current account's, at least RESET_HORIZON_MS
 * away, and the target needs RESET_ROOM_POINTS of room below its ceiling.
 */
export const RESET_LEAD_MS = 3_600_000;
export const RESET_HORIZON_MS = 1_800_000;
export const RESET_ROOM_POINTS = 5;

interface Ranked {
  id: number;
  score: number | null;
  weeklyResetsAt?: string | null;
  active?: number;
}

/** 0: below the soft ceiling, 1: below the hard ceiling, 2: at or above it. */
function ceilingTier(policy: AccountPolicy, score: number | null): 0 | 1 | 2 {
  return effective(score) < policy.soft_ceiling ? 0 : effective(score) < policy.hard_ceiling ? 1 : 2;
}

/**
 * The reset-aware order: accounts below the soft ceiling first, then those
 * below the hard ceiling, each group by weekly reset, earliest first. This is
 * earliest-deadline-first, which leaves the least quota to expire whatever the
 * demand turns out to be; the needed burn rate (unused share / time left) only
 * describes the urgency, sorting by it would strand a small early remainder
 * behind a large later one. An account without a proven reset
 * (`weeklyDeadline`) sorts after every dated one, so missing data never looks
 * urgent. Accounts at the hard ceiling come last, least used first.
 */
export function resetAwareOrder<T extends Ranked>(policy: AccountPolicy, accounts: T[], now: number): T[] {
  const key = (a: T) => {
    const tier = ceilingTier(policy, a.score);
    return { tier, deadline: tier === 2 ? Infinity : (weeklyDeadline(a.weeklyResetsAt, now) ?? Infinity) };
  };
  return accounts
    .map((account) => ({ account, ...key(account) }))
    .sort(
      (a, b) =>
        a.tier - b.tier ||
        (a.deadline === b.deadline ? 0 : a.deadline < b.deadline ? -1 : 1) ||
        effective(a.account.score) - effective(b.account.score) ||
        (a.account.active ?? 0) - (b.account.active ?? 0) ||
        a.account.id - b.account.id,
    )
    .map((entry) => entry.account);
}

function resetAwareLaunch(
  policy: AccountPolicy,
  candidates: PolicyCandidate[],
  threshold: number,
  now: number,
): PolicyCandidate | null {
  // No weekly reset is known anywhere in the pool (no readings yet, or an
  // engine that reports none): nothing can be ordered by expiry.
  if (!candidates.some((a) => weeklyDeadline(a.weeklyResetsAt, now) !== null))
    return selectAccount(candidates, threshold, now) as PolicyCandidate | null;
  // A never-measured idle account takes one launch to publish a reading. An
  // account whose recorded reset has passed is not tried: it is in a new
  // window and is the one to save.
  const trials = candidates.filter((a) => !a.weeklyResetsAt && trialDue(a, now));
  if (trials.length) return trials.sort(selectionOrder)[0]!;
  return resetAwareOrder(policy, candidates, now)[0]!;
}

/** Account a new launch should take under the policy. */
export function selectForLaunch(
  policy: AccountPolicy,
  candidates: PolicyCandidate[],
  threshold: number,
  now: number,
): PolicyCandidate | null {
  if (!candidates.length) return null;
  if (exhausts(policy)) return exhaustTarget(policy, candidates);
  if (resetAware(policy)) return resetAwareLaunch(policy, candidates, threshold, now);
  return selectAccount(candidates, threshold, now) as PolicyCandidate | null;
}

/** The usage ceiling an account may reach before it must hand over. */
export function policyCeiling(policy: AccountPolicy, limitPercent: number): number {
  return exhausts(policy) || resetAware(policy) ? policy.hard_ceiling : limitPercent;
}

/** The account the policy would move to among `others` (exhaust order, reset order or least used). */
function preferredTarget<T extends Ranked>(
  policy: AccountPolicy,
  others: T[],
  ceiling: number,
  now: number = Date.now(),
): T | undefined {
  const headroom = others.filter((a) => effective(a.score) < ceiling);
  if (resetAware(policy)) return resetAwareOrder(policy, headroom, now)[0];
  if (exhausts(policy))
    return (
      [...headroom].sort((a, b) => a.id - b.id).find((a) => effective(a.score) < policy.soft_ceiling) ??
      [...headroom].sort((a, b) => a.id - b.id)[0]
    );
  return [...headroom].sort((a, b) => effective(a.score) - effective(b.score) || a.id - b.id)[0];
}

/**
 * Where a running scope moves under the reset-aware strategy once its dwell
 * has passed, or null to stay. Leaving an account that crossed a ceiling for
 * one still under it needs no further reason. Between accounts on the same
 * side of the ceilings the scope only moves towards a proven earlier weekly
 * reset, and only when the guards above say the cache rebuild is worth it.
 */
function resetAwareMove(
  policy: AccountPolicy,
  current: PolicyCandidate,
  others: PolicyCandidate[],
  now: number,
): PolicyCandidate | null {
  const tier = ceilingTier(policy, current.score);
  const currentDeadline = weeklyDeadline(current.weeklyResetsAt, now) ?? Infinity;
  for (const target of resetAwareOrder(policy, others, now)) {
    const targetTier = ceilingTier(policy, target.score);
    if (targetTier === 2 || targetTier > tier) return null;
    if (targetTier < tier) return target;
    const deadline = weeklyDeadline(target.weeklyResetsAt, now);
    // Sorted by reset: no later entry of this tier has an earlier one.
    if (deadline === null || currentDeadline - deadline < RESET_LEAD_MS) return null;
    const limit = tier === 0 ? policy.soft_ceiling : policy.hard_ceiling;
    if (deadline - now >= RESET_HORIZON_MS && effective(target.score) <= limit - RESET_ROOM_POINTS) return target;
  }
  return null;
}

function exhaustTarget(policy: AccountPolicy, candidates: PolicyCandidate[]): PolicyCandidate {
  const ordered = [...candidates].sort((a, b) => a.id - b.id);
  return (
    ordered.find((a) => effective(a.score) < policy.soft_ceiling) ??
    ordered.find((a) => effective(a.score) < policy.hard_ceiling) ??
    [...ordered].sort((a, b) => effective(a.score) - effective(b.score) || a.id - b.id)[0]!
  );
}

/**
 * Where a running scope should move, or null to stay. `boundAt` is when the
 * scope last changed account; moves wait for the minimum dwell.
 */
export function rebalanceTarget(
  policy: AccountPolicy,
  currentId: number,
  candidates: PolicyCandidate[],
  boundAt: string | null,
  now: number,
  limitPercent = 100,
): PolicyCandidate | null {
  if (policy.mode !== 'auto') return null;
  const current = candidates.find((a) => a.id === currentId);
  const others = candidates.filter((a) => a.id !== currentId);
  if (!others.length) return null;
  // The bound account left the pool (paused or unverified): move to the best one.
  if (!current) return selectForLaunch(policy, others, policy.hard_ceiling, now);
  const currentScore = effective(current.score);
  // At the quota limit the dwell no longer protects the prompt cache: move to
  // the account the policy would pick, as long as it has headroom.
  const ceiling = policyCeiling(policy, limitPercent);
  if (currentScore >= ceiling) {
    const target = preferredTarget(policy, others, ceiling, now);
    return target && effective(target.score) < ceiling ? target : null;
  }
  const bound = boundAt ? Date.parse(boundAt) : NaN;
  if (Number.isFinite(bound) && now - bound < policy.min_dwell_minutes * 60_000) return null;
  if (policy.strategy === 'reset_aware') return resetAwareMove(policy, current, others, now);
  if (policy.strategy === 'exhaust') {
    if (currentScore < policy.soft_ceiling) return null;
    const target = exhaustTarget(policy, candidates);
    return target.id !== currentId && effective(target.score) < currentScore ? target : null;
  }
  const lowest = [...others].sort(
    (a, b) => effective(a.score) - effective(b.score) || a.active - b.active || a.id - b.id,
  )[0]!;
  return currentScore - effective(lowest.score) > policy.spread_points ? lowest : null;
}

export interface PoolAccountView {
  id: number;
  label: string;
  score: number | null;
  usable: boolean;
  /** Weekly reset of the newest reading (see `AccountChoice.weeklyResetsAt`). */
  weeklyResetsAt?: string | null;
}

export interface PoolRecommendation {
  action: 'continue' | 'switch' | 'pause';
  account_id: number | null;
  message: string;
}

/** "40 min", "9 h" or "2 d 3 h" until `at`. */
function untilText(at: number, now: number): string {
  const minutes = Math.max(1, Math.round((at - now) / 60_000));
  if (minutes < 90) return `${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h`;
  return hours % 24 ? `${Math.floor(hours / 24)} d ${hours % 24} h` : `${hours / 24} d`;
}

/**
 * Why the reset-aware strategy takes `account` next, for messages to agents
 * and operators; empty for other strategies or without a proven weekly reset.
 */
export function resetAwareReason(policy: AccountPolicy, account: PoolAccountView, now: number): string {
  if (!resetAware(policy)) return '';
  const deadline = weeklyDeadline(account.weeklyResetsAt, now);
  return deadline === null ? '' : `its weekly quota resets in ${untilText(deadline, now)}, the soonest with room`;
}

/**
 * The usable account (enabled and verified) other than `excludeId` that the
 * policy would hand work to below its ceiling, or null when there is none.
 * This is the pool's headroom verdict: unmeasured accounts count as unused,
 * paused or unverified ones never count. `excludeId` is the bound account, or
 * null to ask whether any account of the pool can take a new launch.
 */
export function poolHeadroomTarget<T extends PoolAccountView>(
  policy: AccountPolicy,
  accounts: T[],
  excludeId: number | null,
  limitPercent: number,
): T | null {
  const others = accounts.filter((a) => a.usable && a.id !== excludeId);
  return preferredTarget(policy, others, policyCeiling(policy, limitPercent)) ?? null;
}

/**
 * The single source for quota warnings in a pool: agents keep working while
 * any usable account has headroom; pausing is advised only when the whole pool
 * is at its limit. `warnPercent` is the level from which the bound account
 * counts as high; `plannedTarget` is what the automatic policy will move to now
 * (null when it waits), so the message never promises a move that is not coming.
 */
export function poolRecommendation(
  policy: AccountPolicy,
  bound: PoolAccountView | null,
  accounts: PoolAccountView[],
  warnPercent: number,
  limitPercent: number,
  liveSwitch: boolean,
  plannedTarget: number | null,
): PoolRecommendation {
  const pct = (score: number | null) => (score === null ? 'no reading' : `${Math.round(score)}%`);
  const others = accounts.filter((a) => a.usable && a.id !== bound?.id);
  const boundScore = bound ? effective(bound.score) : 0;
  // A reset-aware move comes while the bound account is still low: say that the
  // session changes accounts for the weekly reset, not because of its usage.
  const early = bound && boundScore < warnPercent && liveSwitch ? others.find((a) => a.id === plannedTarget) : undefined;
  const earlyReason = early ? resetAwareReason(policy, early, Date.now()) : '';
  if (bound && early && earlyReason)
    return {
      action: 'continue',
      account_id: null,
      message: `${bound.score === null ? `Account ${bound.label} has no usage reading yet` : `Account ${bound.label} is at ${pct(bound.score)}`}. The pool policy moves this session to ${early.label} at a turn boundary: ${earlyReason}; keep working.`,
    };
  const pool = accounts
    .filter((a) => a.id !== bound?.id)
    .map((a) => `${a.label} ${pct(a.score)}`)
    .join(', ');
  if (!bound || boundScore < warnPercent)
    return {
      action: 'continue',
      account_id: null,
      message: !bound
        ? 'No account is bound.'
        : bound.score === null
          ? `Account ${bound.label} has no usage reading yet.`
          : `Account ${bound.label} is at ${pct(bound.score)}.`,
    };
  const best = poolHeadroomTarget(policy, accounts, bound.id, limitPercent);
  if (!best)
    return {
      action: 'pause',
      account_id: null,
      message: `Account ${bound.label} is at ${pct(bound.score)}; every account in the pool is at its limit${pool ? ` (${pool})` : ''}.`,
    };
  const head = `Account ${bound.label} is at ${pct(bound.score)}; pool: ${pool}.`;
  if (!liveSwitch)
    return { action: 'continue', account_id: best.id, message: `${head} Keep working; the next launch uses the pool policy.` };
  if (policy.mode === 'auto') {
    const planned = plannedTarget !== null ? others.find((a) => a.id === plannedTarget) : undefined;
    // Reset-aware picks are not the least used account, so the message says why.
    const now = Date.now();
    const because = (account: PoolAccountView) => {
      const reason = resetAwareReason(policy, account, now);
      return reason ? ` (${reason})` : '';
    };
    const next = because(best) ? `, to ${best.label}${because(best)}` : '';
    return planned
      ? { action: 'switch', account_id: planned.id, message: `${head} The pool policy moves this session to ${planned.label}${because(planned)} at a turn boundary; keep working.` }
      : { action: 'continue', account_id: null, message: `${head} Keep working; the pool policy moves this session before the limit${next}.` };
  }
  return { action: 'switch', account_id: best.id, message: `${head} Switch to ${best.label} with #account-switch; keep working.` };
}
