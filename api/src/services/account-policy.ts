import { z } from 'zod';
import type { Database } from '../db/client.js';
import { ValidationError } from '../http/errors.js';
import type { Engine } from '../util/engine.js';
import { SettingsService } from './settings.js';
import { selectAccount, type AccountChoice } from './account-selection.js';

/**
 * Per-engine distribution policy for a provider account pool.
 * - balanced: keep every account within `spread` points of the others; a scope
 *   moves once its account is more than the band above the least-used one.
 * - exhaust: use accounts in ID order up to the soft ceiling, then the next;
 *   when all are above it, fill up to the hard ceiling.
 * - manual: no automatic moves; only explicit switches.
 */
export const SPREAD_POINTS = { eng: 10, normal: 20, locker: 30 } as const;
export type Spread = keyof typeof SPREAD_POINTS;

const policySchema = z
  .object({
    mode: z.enum(['auto', 'manual']),
    strategy: z.enum(['balanced', 'exhaust']),
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

export async function writeAccountPolicy(db: Database, engine: Engine, patch: unknown): Promise<AccountPolicy> {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch))
    throw new ValidationError('policy must be an object');
  const current = await readAccountPolicy(db, engine);
  const { spread_points: _ignored, ...stored } = current;
  const parsed = policySchema.safeParse({ ...stored, ...(patch as Record<string, unknown>) });
  if (!parsed.success) throw new ValidationError(parsed.error.issues[0]?.message ?? 'Invalid account policy');
  await new SettingsService(db).set(accountPolicyKey(engine), JSON.stringify(parsed.data));
  return withPoints(parsed.data);
}

export interface PolicyCandidate extends AccountChoice {
  /** Unmeasured accounts count as unused for comparisons. */
  score: number | null;
}

const effective = (score: number | null) => score ?? 0;

/** Account a new launch should take under the policy. */
export function selectForLaunch(
  policy: AccountPolicy,
  candidates: PolicyCandidate[],
  threshold: number,
  now: number,
): PolicyCandidate | null {
  if (!candidates.length) return null;
  if (policy.mode === 'auto' && policy.strategy === 'exhaust') return exhaustTarget(policy, candidates);
  return selectAccount(candidates, threshold, now) as PolicyCandidate | null;
}

/** The usage ceiling an account may reach before it must hand over. */
export function policyCeiling(policy: AccountPolicy, limitPercent: number): number {
  return policy.mode === 'auto' && policy.strategy === 'exhaust' ? policy.hard_ceiling : limitPercent;
}

/** The account the policy would move to among `others` (exhaust order or least used). */
function preferredTarget<T extends { id: number; score: number | null }>(
  policy: AccountPolicy,
  others: T[],
  ceiling: number,
): T | undefined {
  const headroom = others.filter((a) => effective(a.score) < ceiling);
  if (policy.mode === 'auto' && policy.strategy === 'exhaust')
    return (
      [...headroom].sort((a, b) => a.id - b.id).find((a) => effective(a.score) < policy.soft_ceiling) ??
      [...headroom].sort((a, b) => a.id - b.id)[0]
    );
  return [...headroom].sort((a, b) => effective(a.score) - effective(b.score) || a.id - b.id)[0];
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
    const target = preferredTarget(policy, others, ceiling);
    return target && effective(target.score) < ceiling ? target : null;
  }
  const bound = boundAt ? Date.parse(boundAt) : NaN;
  if (Number.isFinite(bound) && now - bound < policy.min_dwell_minutes * 60_000) return null;
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
}

export interface PoolRecommendation {
  action: 'continue' | 'switch' | 'pause';
  account_id: number | null;
  message: string;
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
  const ceiling = policyCeiling(policy, limitPercent);
  const pct = (score: number | null) => (score === null ? 'unknown' : `${Math.round(score)}%`);
  const others = accounts.filter((a) => a.usable && a.id !== bound?.id);
  const boundScore = bound ? effective(bound.score) : 0;
  const pool = accounts
    .filter((a) => a.id !== bound?.id)
    .map((a) => `${a.label} ${pct(a.score)}`)
    .join(', ');
  if (!bound || boundScore < warnPercent)
    return { action: 'continue', account_id: null, message: bound ? `Account ${bound.label} is at ${pct(bound.score)}.` : 'No account is bound.' };
  const best = preferredTarget(policy, others, ceiling);
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
    return planned
      ? { action: 'switch', account_id: planned.id, message: `${head} The pool policy moves this session to ${planned.label} at a turn boundary; keep working.` }
      : { action: 'continue', account_id: null, message: `${head} Keep working; the pool policy moves this session before the limit.` };
  }
  return { action: 'switch', account_id: best.id, message: `${head} Switch to ${best.label} with #account-switch; keep working.` };
}
