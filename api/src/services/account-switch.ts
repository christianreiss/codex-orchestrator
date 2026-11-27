import { and, eq, gt, isNull, or } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { agentSessions, hosts, providerAccounts, providerAccountSessions } from '../db/schema.js';
import { ConflictError, NotFoundError, ServiceUnavailableError } from '../http/errors.js';
import type { Keyring } from '../security/keyring.js';
import { nowIso } from '../util/timestamp.js';
import type { Engine } from '../util/engine.js';
import { mutateOwnerState, ownerRuntimeFor } from '../control-plane/state/runtime.js';
import { ownedAccount } from '../control-plane/streams/provider-leases.js';
import { stageUpdate } from '../control-plane/state/rows.js';
import { appendAuditLog, persistAuditLog } from './audit-log.js';
import { wsPublisher } from '../ws/publisher.js';
import { quotaWindowScore } from './account-selection.js';
import { emulationBlocks } from './quota-emulation.js';
import { ProviderAccountsService } from './provider-accounts.js';
import { SettingsService } from './settings.js';
import { AccountPauseRounds, type PauseReportState, type PauseScopeView } from './account-switch/pause.js';
import {
  LIVE_SWITCH_ENGINES,
  policyCeiling,
  poolHeadroomTarget,
  poolRecommendation,
  readAccountPolicy,
  rebalanceTarget,
  selectForLaunch,
  type AccountPolicy,
  type PoolRecommendation,
} from './account-policy.js';

type Lease = typeof providerAccountSessions.$inferSelect;
export type SwitchReason = 'policy' | 'admin' | 'host' | 'agent';

export { LIVE_SWITCH_ENGINES };

export interface SwitchDirective {
  account_id: number;
  account_label: string;
  binding_generation: number;
  reason: SwitchReason;
  requested_at: string | null;
  /**
   * False when the account the scope is leaving is paused or no longer
   * verified. The server will not confirm that account's credentials any more,
   * so the wrapper must not wait for that confirmation before it switches.
   */
  bound_account_usable: boolean;
}

export interface PoolAccount {
  id: number;
  label: string;
  email: string | null;
  state: string;
  verified: boolean;
  short_used_percent: number | null;
  short_resets_at: string | null;
  weekly_used_percent: number | null;
  weekly_resets_at: string | null;
  /** When the newest usage reading of the account was taken (null: never). */
  fetched_at: string | null;
  score: number | null;
  emulation_blocked: boolean;
  /** Unlimited by quota policy: no window to save, so no reset to order by. */
  unlimited: boolean;
  active_sessions: number;
  last_selected_at: string | null;
  /** The provider refused a turn with its usage limit: full until then (absent or null: not marked). */
  exhausted_until?: string | null;
}

/**
 * Server notice for every agent whose scope moved accounts: names the new and
 * the previous account with their usage so the agent keeps working instead of
 * reacting to a quota figure that suddenly dropped.
 */
export function accountSwitchNoticeContent(engine: Engine, from: PoolAccount | undefined, to: PoolAccount | undefined, reason: string | null): string {
  const usage = (a: PoolAccount | undefined) => {
    if (!a) return 'usage unknown';
    const parts = [
      a.short_used_percent === null ? null : `5h ${Math.round(a.short_used_percent)}%`,
      a.weekly_used_percent === null ? null : `weekly ${Math.round(a.weekly_used_percent)}%`,
    ].filter(Boolean);
    return parts.length ? parts.join(', ') : 'no usage reading yet';
  };
  const name = (a: PoolAccount | undefined, id: string) => (a ? `${a.label} (#${a.id})` : id);
  return `ACCOUNT/1 switched: this ${engine} session now runs on ${name(to, 'the new account')}, ${usage(to)}; previously ${name(from, 'the old account')}, ${usage(from)}. Reason: ${reason ?? 'unspecified'}. The switch happened at a turn boundary; keep working. Quota figures now refer to the new account, and the first request rebuilds the prompt cache. Use account_status for the pool.`;
}

/** Where one listed account stands in its engine's pool (`/admin/accounts` `pool`). */
export interface PoolPosition {
  /** max(short, weekly) used percent; a passed reset is no reading, unlimited is 0, an emulated block or a provider refusal is 100. */
  score: number | null;
  /** The short and weekly window as scored (null without a current reading), for pool averages. */
  short: number | null;
  weekly: number | null;
  /** Enabled and verified: the account can take new work and live switches. */
  usable: boolean;
  emulation_blocked: boolean;
  /** Until when the provider's own usage-limit refusal holds (null: not marked). */
  exhausted_until: string | null;
}

/** The fields of a `ProviderAccountsService.list()` row that decide its pool position. */
export interface PoolPositionInput {
  state: string;
  verification_state: string;
  usage: object;
  quota_policy?: { unlimited?: boolean } | null;
  quota_snapshot?: { short?: Parameters<typeof emulationBlocks>[0] } | null;
  /** The account's exhaustion marker (`quota-exhaustion.ts`), when one is on record. */
  quota_exhausted?: { until: string } | null;
}

/**
 * The single scoring rule of the pool, shared by the policy, live switching,
 * agent warnings and the admin list, so they never disagree about an account.
 */
export function poolPosition(account: PoolPositionInput, now: number): PoolPosition {
  const usage = account.usage as Record<string, unknown>;
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const str = (v: unknown) => (typeof v === 'string' ? v : null);
  const unlimited = account.quota_policy?.unlimited === true;
  // An emulated budget that blocks managed work makes the account full
  // for the policy: running scopes move away and nothing moves onto it.
  const blocked = !unlimited && emulationBlocks(account.quota_snapshot?.short);
  const short = quotaWindowScore(num(usage.short_used_percent), str(usage.short_resets_at), now);
  const weekly = quotaWindowScore(num(usage.weekly_used_percent), str(usage.weekly_resets_at), now);
  const scores = [short, weekly].filter((x): x is number => x !== null);
  // The provider refused a turn on this account with its usage limit. That
  // outranks every reading, which only repeats the last successful response.
  const until = account.quota_exhausted?.until;
  const exhausted = !unlimited && !!until && Date.parse(until) > now;
  return {
    score: unlimited ? 0 : blocked || exhausted ? 100 : scores.length ? Math.max(...scores) : null,
    short,
    weekly,
    usable: account.state === 'enabled' && account.verification_state === 'verified',
    emulation_blocked: blocked,
    exhausted_until: exhausted ? until : null,
  };
}

/**
 * How long after a live switch a reading is checked against the other accounts'
 * windows while the bound account has no window of its own to compare with,
 * and how long a reading refused as another account's has to keep arriving
 * before it is believed after all.
 */
export const SWITCH_STALE_READING_MS = 30 * 60_000;

/**
 * After a live switch Claude Code's statusline keeps showing the rate limits of
 * the last response, which the previous account served, while the reporter
 * already files them under the new binding. A reading is another account's
 * when its reset matches that account's current window and not the bound
 * account's own: reset times identify an account's window. While the bound
 * account has a running window on record, that holds however long ago the
 * switch was (a session can sit on its last response for hours). Without one
 * there is nothing to contradict the report, so it is only doubted for the
 * first half hour after the switch.
 */
export function staleSwitchReading(
  report: { short_resets_at: string | null; weekly_resets_at: string | null },
  boundAt: string | null | undefined,
  bound: Pick<PoolAccount, 'short_resets_at' | 'weekly_resets_at'> | undefined,
  others: Pick<PoolAccount, 'short_resets_at' | 'weekly_resets_at'>[],
  now: number,
): boolean {
  const at = boundAt ? Date.parse(boundAt) : NaN;
  const justSwitched = Number.isFinite(at) && now - at <= SWITCH_STALE_READING_MS;
  const same = (a: string | null | undefined, b: string | null | undefined) => {
    if (!a || !b) return false;
    const x = Date.parse(a);
    const y = Date.parse(b);
    return Number.isFinite(x) && Number.isFinite(y) && Math.abs(x - y) < 60_000;
  };
  const window = (key: 'short_resets_at' | 'weekly_resets_at') => {
    const reset = report[key];
    if (!reset || same(reset, bound?.[key])) return false;
    const own = bound?.[key] ? Date.parse(bound[key] as string) : NaN;
    if (!justSwitched && !(Number.isFinite(own) && own > now)) return false;
    return others.some((o) => same(reset, o[key]));
  };
  return window('weekly_resets_at') || window('short_resets_at');
}

/**
 * Readings refused as another account's, by account and reset times. The
 * refusal rests on what is stored, and what is stored can itself be wrong
 * (two accounts whose first readings were filed crosswise would refuse each
 * other's true readings until the windows end). A stale statusline stops
 * repeating itself with the session's next response; a reading that keeps
 * arriving for `SWITCH_STALE_READING_MS` is therefore taken as the truth.
 */
const refusedReadings = new Map<string, { since: number; last: number }>();
const REFUSED_READING_GAP_MS = 15 * 60_000;

function refusedLongEnough(key: string, now: number): boolean {
  if (refusedReadings.size > 2000) {
    for (const [k, v] of refusedReadings) if (now - v.last > REFUSED_READING_GAP_MS) refusedReadings.delete(k);
  }
  const seen = refusedReadings.get(key);
  if (!seen || now - seen.last > REFUSED_READING_GAP_MS) {
    refusedReadings.set(key, { since: now, last: now });
    return false;
  }
  seen.last = now;
  if (now - seen.since < SWITCH_STALE_READING_MS) return false;
  refusedReadings.delete(key);
  return true;
}

/** How long an operator, host or agent request may wait for its scope before it is withdrawn. */
export const SWITCH_REQUEST_TTL_MS = 24 * 3_600_000;

/** Unfinished credential writes already audited (host, engine, scope, binding generation). */
const unfinishedWrites = new Set<string>();

const liveLease = (row: Lease, now: string) => row.ownershipMode === 'connection' || row.expiresAt > now;
const generationOf = (row: Pick<Lease, 'bindingGeneration'>) => row.bindingGeneration ?? 1;

export class AccountSwitchService {
  private readonly accounts: ProviderAccountsService;
  /** Pause rounds: the quiet moment a switch needs, made on request. */
  private readonly pauses: AccountPauseRounds;
  constructor(
    private readonly db: Database,
    keyring: Keyring,
  ) {
    this.accounts = new ProviderAccountsService(db, keyring);
    this.pauses = new AccountPauseRounds(db);
  }

  /** A session's report in a pause round (`POST /auth/sessions/pause`). */
  reportPause(input: { hostId: number; engine: Engine; sessionId: string; state: PauseReportState; round?: string; reason?: string | null }) {
    return this.pauses.report(input);
  }

  /** When the policy worker should look at this engine's pause rounds again (0: nothing waits). */
  pauseNextAt(engine: Engine): number {
    return this.pauses.nextAt(engine);
  }

  private async leases(filter: { hostId?: number; engine: Engine; scopeId?: string }): Promise<Lease[]> {
    const now = nowIso();
    const owner = ownerRuntimeFor(this.db);
    if (owner) {
      owner.assertOwner();
      return owner.state
        .snapshot()
        .table('providerAccountSessions')
        .all()
        .filter(
          (r) =>
            r.engine === filter.engine &&
            (filter.hostId === undefined || r.hostId === filter.hostId) &&
            (filter.scopeId === undefined || r.scopeId === filter.scopeId) &&
            liveLease(r, now),
        );
    }
    const rows = await this.db
      .select()
      .from(providerAccountSessions)
      .where(
        and(
          eq(providerAccountSessions.engine, filter.engine),
          filter.hostId === undefined ? undefined : eq(providerAccountSessions.hostId, filter.hostId),
          filter.scopeId === undefined ? undefined : eq(providerAccountSessions.scopeId, filter.scopeId),
          or(eq(providerAccountSessions.ownershipMode, 'connection'), gt(providerAccountSessions.expiresAt, now)),
        ),
      );
    return rows;
  }

  /** Every account of the engine with its quota position (no credential reads). */
  async pool(engine: Engine): Promise<PoolAccount[]> {
    const listed = await this.accounts.list(engine);
    const now = Date.now();
    const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
    const str = (v: unknown) => (typeof v === 'string' ? v : null);
    // The listed row already carries the effective quota policy and snapshot.
    return listed
      .filter((a) => a.state !== 'removed')
      .map((a) => {
        const usage = a.usage as Record<string, unknown>;
        const position = poolPosition(a, now);
        return {
          id: a.id,
          label: a.label,
          email: a.label.includes('@') ? a.label : null,
          state: a.state,
          verified: a.verification_state === 'verified',
          short_used_percent: num(usage.short_used_percent),
          short_resets_at: str(usage.short_resets_at),
          weekly_used_percent: num(usage.weekly_used_percent),
          weekly_resets_at: str(usage.weekly_resets_at),
          fetched_at: str(usage.fetched_at),
          score: position.score,
          emulation_blocked: position.emulation_blocked,
          unlimited: a.quota_policy?.unlimited === true,
          active_sessions: a.sessions.length,
          last_selected_at: a.last_selected_at,
          exhausted_until: position.exhausted_until,
        };
      });
  }

  private async label(engine: Engine, id: number): Promise<string> {
    try {
      return (await this.accounts.get(id, engine)).label;
    } catch {
      return `#${id}`;
    }
  }

  async directiveFor(row: Lease | undefined, pool?: PoolAccount[]): Promise<SwitchDirective | null> {
    if (!row?.desiredAccountId || row.desiredAccountId === row.accountId) return null;
    return {
      account_id: row.desiredAccountId,
      account_label: await this.label(row.engine as Engine, row.desiredAccountId),
      binding_generation: generationOf(row),
      reason: (row.desiredReason as SwitchReason | null) ?? 'admin',
      requested_at: row.desiredAt ?? null,
      bound_account_usable: this.usable(pool ?? (await this.pool(row.engine as Engine)), row.accountId),
    };
  }

  /** binding_generation + pending directive for a session (merged into responses). */
  async sessionBinding(hostId: number, engine: Engine, sessionId: string) {
    const row = (await this.leases({ hostId, engine })).find((r) => r.id === sessionId);
    if (!row) return { binding_generation: null, account_switch: null };
    // Whether the server counts this lease as able to pause; absent for a
    // lease that never can. A wrapper that can announces itself again when
    // it reads false (a lease the server re-reserved has lost the flag).
    const capable = this.pauses.capable(hostId, engine, sessionId);
    return {
      binding_generation: generationOf(row),
      account_switch: await this.directiveFor(row),
      ...(capable === null ? {} : { pause_capable: capable }),
    };
  }

  /** When the scope of a session was bound to its account (null: unknown session). */
  async boundAt(hostId: number, engine: Engine, sessionId: string): Promise<string | null> {
    const row = (await this.leases({ hostId, engine })).find((r) => r.id === sessionId);
    return row ? (row.boundAt ?? row.createdAt) : null;
  }

  /**
   * The account a host's usage report is filed under. The number in the report
   * is only a claim: the account comes from a live lease of the reporting host,
   * so a host cannot file a reading for an account it does not run on. A report
   * that names its session is held to that session's binding. One that names
   * only an account (a statusline outside a wrapper launch) needs a live lease
   * of this host on that account, or the account to be the only one there is.
   * A report that names neither stays unattributed, as before account pools.
   */
  async usageReportAccount(
    hostId: number,
    engine: Engine,
    input: { sessionId?: string; accountId?: number; short_resets_at: string | null; weekly_resets_at: string | null },
    now = Date.now(),
  ): Promise<{ accountId?: number } | { ignored: 'stale_account' | 'session_required' }> {
    let boundAt: string | null = null;
    let accountId: number;
    if (input.sessionId !== undefined) {
      const session = await this.accounts.session(hostId, engine, input.sessionId);
      // After a live switch the statusline may still carry the previous
      // account; its reading must not be filed under the new one.
      if (input.accountId !== undefined && input.accountId !== session.accountId) return { ignored: 'stale_account' };
      accountId = session.accountId;
      boundAt = session.boundAt ?? null;
    } else if (input.accountId !== undefined) {
      accountId = input.accountId;
      const held = (await this.leases({ hostId, engine })).filter((row) => row.accountId === accountId);
      if (!held.length) {
        const live = (await this.accounts.list(engine)).filter((a) => a.state !== 'removed');
        if (live.length !== 1 || live[0]!.id !== accountId) return { ignored: 'session_required' };
      }
      boundAt = held.map((row) => row.boundAt ?? null).sort((a, b) => (b ?? '').localeCompare(a ?? ''))[0] ?? null;
    } else {
      return {};
    }
    // The reporter files by binding, but the payload can still be the previous
    // account's last response (same reset times).
    const pool = await this.pool(engine);
    const bound = pool.find((a) => a.id === accountId);
    if (staleSwitchReading(input, boundAt, bound, pool.filter((a) => a.id !== accountId), now)) {
      const minute = (at: string | null) => (at ? Math.round(Date.parse(at) / 60_000) : 0);
      const key = `${engine}:${accountId}:${minute(input.short_resets_at)}:${minute(input.weekly_resets_at)}`;
      if (!refusedLongEnough(key, now)) return { ignored: 'stale_account' };
    }
    return { accountId };
  }

  private usable(pool: PoolAccount[], id: number) {
    const account = pool.find((a) => a.id === id);
    return !!account && account.state === 'enabled' && account.verified;
  }

  /** Writes the same scope columns on every live lease of a scope. */
  private async updateScope(
    hostId: number,
    engine: Engine,
    scopeId: string,
    expect: { accountId: number; generation: number; desired?: number | null },
    changes: Partial<Pick<Lease, 'accountId' | 'bindingGeneration' | 'desiredAccountId' | 'desiredReason' | 'desiredAt' | 'boundAt'>>,
    audit: { action: string; details: Record<string, unknown> } | null,
  ): Promise<void> {
    const matches = (rows: Lease[]) => {
      const first = rows[0];
      if (!first) throw new NotFoundError('Account session not found');
      if (first.accountId !== expect.accountId || generationOf(first) !== expect.generation)
        throw new ConflictError('The account binding changed; retry with the current state', 'account_switch_stale');
      if (expect.desired !== undefined && (first.desiredAccountId ?? null) !== expect.desired)
        throw new ConflictError('The pending switch changed', 'account_switch_stale');
    };
    const owner = ownerRuntimeFor(this.db);
    const now = nowIso();
    if (owner) {
      await mutateOwnerState(owner, {
        kind: 'provider.scope.update',
        payload: { hostId, engine, scopeId, changes } as never,
        prepare({ snapshot, draft, write }) {
          const rows = snapshot
            .table('providerAccountSessions')
            .all()
            .filter((r) => r.hostId === hostId && r.engine === engine && r.scopeId === scopeId && liveLease(r, now));
          matches(rows);
          for (const row of rows) draft.upsert('providerAccountSessions', { ...row, ...changes });
          write(async (tx) => {
            await tx
              .update(providerAccountSessions)
              .set(changes)
              .where(
                and(
                  eq(providerAccountSessions.hostId, hostId),
                  eq(providerAccountSessions.engine, engine),
                  eq(providerAccountSessions.scopeId, scopeId),
                ),
              );
            if (audit) await persistAuditLog(tx, { hostId, action: audit.action, details: JSON.stringify(audit.details), createdAt: now });
          });
          return null;
        },
      });
    } else {
      await this.db.transaction(async (tx) => {
        const rows = (
          await tx
            .select()
            .from(providerAccountSessions)
            .where(
              and(
                eq(providerAccountSessions.hostId, hostId),
                eq(providerAccountSessions.engine, engine),
                eq(providerAccountSessions.scopeId, scopeId),
              ),
            )
            .for('update')
        ).filter((r) => liveLease(r, now));
        matches(rows);
        await tx
          .update(providerAccountSessions)
          .set(changes)
          .where(
            and(
              eq(providerAccountSessions.hostId, hostId),
              eq(providerAccountSessions.engine, engine),
              eq(providerAccountSessions.scopeId, scopeId),
            ),
          );
        if (audit) await persistAuditLog(tx, { hostId, action: audit.action, details: JSON.stringify(audit.details), createdAt: now });
      });
    }
    wsPublisher.publish('accounts.updated', { host_id: hostId, scope_id: scopeId });
    if (changes.desiredAccountId) wsPublisher.publish('provider.scope.switch', { host_id: hostId, engine, scope_id: scopeId });
  }

  /**
   * Records a pending switch for a scope. Target `auto` asks the policy (or,
   * failing that, the least-used usable account). Requesting the bound account
   * clears a pending switch.
   */
  async requestSwitch(input: {
    hostId: number;
    engine: Engine;
    scopeId: string;
    target: number | 'auto';
    reason: SwitchReason;
    actor?: string | null;
    /** Why a pending request is being cleared (audit only). */
    withdrawn?: 'requested' | 'readings' | 'expired' | 'target_unavailable';
  }): Promise<{ bound_account_id: number; binding_generation: number; account_switch: SwitchDirective | null }> {
    const { hostId, engine, scopeId, reason } = input;
    if (!LIVE_SWITCH_ENGINES.has(engine))
      throw new ConflictError('Live account switching is not supported for this engine yet', 'account_switch_unsupported_engine');
    const rows = await this.leases({ hostId, engine, scopeId });
    const first = rows[0];
    if (!first) throw new NotFoundError('Account session not found');
    const pool = await this.pool(engine);
    let target: number | null;
    if (input.target === 'auto') {
      const policy = await readAccountPolicy(this.db, engine);
      const candidates = this.candidates(pool);
      const forced = rebalanceTarget(
        { ...policy, mode: 'auto', min_dwell_minutes: 0 },
        first.accountId,
        candidates,
        null,
        Date.now(),
        await this.limitPercent(),
      );
      target = forced?.id ?? first.accountId;
    } else {
      target = (await this.accounts.canonicalId(input.target, engine)) ?? input.target;
    }
    if (target !== first.accountId && !this.usable(pool, target))
      throw new ConflictError('The target account is not enabled and verified', 'account_switch_target_unavailable');
    const generation = generationOf(first);
    if (target === first.accountId) {
      if (first.desiredAccountId)
        await this.updateScope(
          hostId,
          engine,
          scopeId,
          { accountId: first.accountId, generation },
          { desiredAccountId: null, desiredReason: null, desiredAt: null },
          this.withdrawal(engine, scopeId, first, input.withdrawn ?? 'requested', reason, input.actor ?? null),
        );
      return { bound_account_id: first.accountId, binding_generation: generation, account_switch: null };
    }
    const requestedAt = nowIso();
    await this.updateScope(
      hostId,
      engine,
      scopeId,
      { accountId: first.accountId, generation },
      { desiredAccountId: target, desiredReason: reason, desiredAt: requestedAt },
      {
        action: 'provider_account.switch_requested',
        details: { engine, scope_id: scopeId, from_account_id: first.accountId, to_account_id: target, reason, actor: input.actor ?? null },
      },
    );
    return {
      bound_account_id: first.accountId,
      binding_generation: generation,
      account_switch: {
        account_id: target,
        account_label: await this.label(engine, target),
        binding_generation: generation,
        reason,
        requested_at: requestedAt,
        bound_account_usable: this.usable(pool, first.accountId),
      },
    };
  }

  /** Audit row for a pending request that ends without a switch. */
  private withdrawal(engine: Engine, scopeId: string, row: Lease, why: string, by: SwitchReason, actor: string | null) {
    return {
      action: 'provider_account.switch_withdrawn',
      details: {
        engine,
        scope_id: scopeId,
        from_account_id: row.accountId,
        to_account_id: row.desiredAccountId ?? null,
        requested_reason: row.desiredReason ?? null,
        requested_at: row.desiredAt ?? null,
        withdrawn: why,
        by,
        actor,
      },
    };
  }

  /**
   * Called by the wrapper that performs the switch (after flushing the old
   * account). The commit can be repeated: a wrapper that never saw the answer,
   * or died before it wrote the credentials, sends the same request again and
   * gets the same binding back (`replayed`), without a second move, audit row
   * or notice. `credentialsReady` is the route's check that the target's
   * credentials can be served; without them the binding must not move, since
   * the scope would then be bound to an account it holds no login for.
   */
  async commitSwitch(input: {
    hostId: number;
    engine: Engine;
    sessionId: string;
    scopeId: string;
    accountId: number;
    generation: number;
    credentialsReady?: boolean;
    /** The pause round the wrapper commits in (absent: a natural gap between turns). */
    pauseRound?: string;
  }): Promise<{ previous_account_id: number | null; account_id: number; binding_generation: number; reason: string | null; moved_addresses: string[]; replayed: boolean }> {
    const { hostId, engine, sessionId, scopeId, generation } = input;
    if (!LIVE_SWITCH_ENGINES.has(engine))
      throw new ConflictError('Live account switching is not supported for this engine yet', 'account_switch_unsupported_engine');
    const rows = await this.leases({ hostId, engine, scopeId });
    const session = rows.find((r) => r.id === sessionId);
    if (!session) throw new NotFoundError('Account session not found');
    const target = (await this.accounts.canonicalId(input.accountId, engine)) ?? input.accountId;
    if (session.accountId === target && generationOf(session) === generation + 1)
      return { previous_account_id: null, account_id: target, binding_generation: generation + 1, reason: null, moved_addresses: [], replayed: true };
    if (session.desiredAccountId !== target || generationOf(session) !== generation)
      throw new ConflictError('The switch request is no longer pending', 'account_switch_stale');
    // A commit inside a pause round must still be inside it: once the round
    // is over the sessions run again and this is no quiet moment any more.
    this.pauses.assertCommit(session, input.pauseRound);
    const pauseDetails = this.pauses.commitDetails(session, input.pauseRound);
    if (!this.usable(await this.pool(engine), target)) {
      await this.updateScope(
        hostId,
        engine,
        scopeId,
        { accountId: session.accountId, generation },
        { desiredAccountId: null, desiredReason: null, desiredAt: null },
        this.withdrawal(engine, scopeId, session, 'target_unavailable', 'host', null),
      );
      throw new ConflictError('The target account is not enabled and verified', 'account_switch_target_unavailable');
    }
    if (input.credentialsReady === false)
      throw new ServiceUnavailableError('Selected account is unavailable', 'account_unavailable');
    const boundAt = nowIso();
    await this.updateScope(
      hostId,
      engine,
      scopeId,
      { accountId: session.accountId, generation, desired: target },
      { accountId: target, bindingGeneration: generation + 1, desiredAccountId: null, desiredReason: null, desiredAt: null, boundAt },
      {
        action: 'provider_account.switched',
        details: {
          engine,
          scope_id: scopeId,
          session_id: sessionId,
          from_account_id: session.accountId,
          to_account_id: target,
          reason: session.desiredReason ?? null,
          binding_generation: generation + 1,
          ...(pauseDetails ? { pause: pauseDetails } : {}),
        },
      },
    );
    const movedAddresses = await this.moveAgentSessions(hostId, engine, scopeId, session.accountId, target);
    const owner = ownerRuntimeFor(this.db);
    if (owner) {
      const account = ownedAccount(owner.state.snapshot(), target, engine);
      if (account)
        await mutateOwnerState(owner, {
          kind: 'provider.account.selected',
          payload: { id: target },
          prepare({ draft, write }) {
            draft.upsert('providerAccounts', { ...account, lastSelectedAt: boundAt });
            write((tx) => tx.update(providerAccounts).set({ lastSelectedAt: boundAt }).where(eq(providerAccounts.id, target)));
            return null;
          },
        });
    } else {
      await this.db.update(providerAccounts).set({ lastSelectedAt: boundAt }).where(eq(providerAccounts.id, target));
    }
    return {
      previous_account_id: session.accountId,
      account_id: target,
      binding_generation: generation + 1,
      reason: session.desiredReason ?? null,
      moved_addresses: movedAddresses,
      replayed: false,
    };
  }

  /**
   * A wrapper says the credentials of a committed switch are still not on
   * disk. The scope runs with the new binding over the previous login until
   * it succeeds, so the operator gets one audit row per scope and binding.
   */
  async reportUnfinishedWrite(hostId: number, engine: Engine, scopeId: string, accountId: number, generation: number): Promise<void> {
    // Every report keeps the scope eligible for a pause round: the write
    // waits for a quiet moment the scope may not have by itself.
    this.pauses.noteUnfinishedWrite(hostId, engine, scopeId, generation);
    const key = `${hostId}:${engine}:${scopeId}:${generation}`;
    if (unfinishedWrites.has(key)) return;
    if (unfinishedWrites.size > 2000) unfinishedWrites.clear();
    unfinishedWrites.add(key);
    await appendAuditLog(this.db, {
      hostId,
      action: 'provider_account.switch_write_unfinished',
      details: JSON.stringify({ engine, scope_id: scopeId, account_id: accountId, binding_generation: generation }),
      createdAt: nowIso(),
    });
  }

  /**
   * Agent sessions record their provider account for quota notices and
   * quota_get. They carry no scope, so they move only when no other live scope
   * of this host and engine still uses the previous account; otherwise the
   * session heals on its next registration.
   */
  private async moveAgentSessions(hostId: number, engine: Engine, scopeId: string, from: number, to: number): Promise<string[]> {
    const others = (await this.leases({ hostId, engine })).filter((r) => r.scopeId !== scopeId && r.accountId === from);
    if (others.length) return [];
    const owner = ownerRuntimeFor(this.db);
    const moved: string[] = [];
    if (owner) {
      await mutateOwnerState(owner, {
        kind: 'session.provider.switch',
        payload: { hostId, engine, from, to },
        prepare(command) {
          const rows = command.draft
            .table('agentSessions')
            .all()
            .filter((r) => r.hostId === hostId && r.engine === engine && r.providerAccountId === from && !r.endedAt);
          moved.length = 0;
          for (const row of rows) {
            stageUpdate(command, 'agentSessions', row.id, { providerAccountId: to });
            if (row.agentBusAddressId) moved.push(row.agentBusAddressId);
          }
          return null;
        },
      });
      return moved;
    }
    const where = and(
      eq(agentSessions.hostId, hostId),
      eq(agentSessions.engine, engine),
      eq(agentSessions.providerAccountId, from),
      isNull(agentSessions.endedAt),
    );
    for (const row of await this.db.select({ address: agentSessions.agentBusAddressId }).from(agentSessions).where(where))
      if (row.address) moved.push(row.address);
    await this.db.update(agentSessions).set({ providerAccountId: to }).where(where);
    return moved;
  }

  private candidates(pool: PoolAccount[]) {
    return pool
      .filter((a) => a.state === 'enabled' && a.verified)
      .map((a) => ({
        id: a.id,
        score: a.score,
        active: a.active_sessions,
        lastSelectedAt: a.last_selected_at,
        weeklyResetsAt: a.unlimited ? null : a.weekly_resets_at,
      }));
  }

  /** Live scopes of an engine with their binding (admin view). */
  async scopes(engine: Engine, known?: PoolAccount[]) {
    const rows = await this.leases({ engine });
    const pool = known ?? (rows.some((r) => r.desiredAccountId) ? await this.pool(engine) : undefined);
    const groups = new Map<string, Lease[]>();
    for (const row of rows.filter((r) => r.hostId > 0)) {
      const key = `${row.hostId}\u0000${row.scopeId}`;
      groups.set(key, [...(groups.get(key) ?? []), row]);
    }
    const fqdns = new Map<number, string>();
    for (const hostId of new Set(rows.map((r) => r.hostId).filter((id) => id > 0))) {
      const host = (await this.db.select({ fqdn: hosts.fqdn }).from(hosts).where(eq(hosts.id, hostId)))[0];
      fqdns.set(hostId, host?.fqdn ?? `#${hostId}`);
    }
    return Promise.all(
      [...groups.values()].map(async (group) => {
        const first = group[0]!;
        return {
          host_id: first.hostId,
          host_fqdn: fqdns.get(first.hostId) ?? `#${first.hostId}`,
          scope_id: first.scopeId,
          account_id: first.accountId,
          account_label: await this.label(engine, first.accountId),
          binding_generation: generationOf(first),
          sessions: group.length,
          bound_at: first.boundAt ?? first.createdAt,
          account_switch: await this.directiveFor(first, pool),
          pause: this.pauses.view(group) as PauseScopeView | null,
        };
      }),
    );
  }

  /**
   * Pool view and the warning recommendation for one bound account.
   * `headroom` says whether another usable account (any usable account when
   * nothing is bound) can take work below the policy ceiling: the CLI's single
   * verdict for "the whole pool is high". `launch_account_id` is the account a
   * new launch would be assigned now (same selection as `POST /auth/sessions`).
   */
  async poolView(engine: Engine, boundAccountId: number | null, warnPercent?: number, boundAt: string | null = null) {
    const [policy, pool, limitPercent] = await Promise.all([
      readAccountPolicy(this.db, engine),
      this.pool(engine),
      this.limitPercent(),
    ]);
    const view = (a: PoolAccount) => ({
      id: a.id,
      label: a.label,
      score: a.score,
      usable: a.state === 'enabled' && a.verified,
      weeklyResetsAt: a.unlimited ? null : a.weekly_resets_at,
    });
    const bound = pool.find((a) => a.id === boundAccountId) ?? null;
    const candidates = this.candidates(pool);
    // With the scope's `boundAt` the advice respects the dwell like the policy
    // itself: it does not announce a move the evaluator will not request yet.
    const planned = bound
      ? rebalanceTarget(policy, bound.id, candidates, boundAt, Date.now(), limitPercent)?.id ?? null
      : null;
    const recommendation: PoolRecommendation = poolRecommendation(
      policy,
      bound ? view(bound) : null,
      pool.map(view),
      warnPercent ?? limitPercent,
      limitPercent,
      LIVE_SWITCH_ENGINES.has(engine),
      planned,
    );
    const blocked = new Set(pool.filter((a) => a.emulation_blocked).map((a) => a.id));
    const admitted = candidates.filter((c) => !blocked.has(c.id));
    const launch = selectForLaunch(policy, admitted.length ? admitted : candidates, limitPercent, Date.now());
    return {
      policy,
      accounts: pool,
      recommendation,
      bound_account_id: bound?.id ?? null,
      headroom: poolHeadroomTarget(policy, pool.map(view), bound?.id ?? null, limitPercent) !== null,
      launch_account_id: launch?.id ?? null,
    };
  }

  /** The fleet quota limit (`/admin/quota-mode`), clamped like the auth routes. */
  private async limitPercent(): Promise<number> {
    return Math.max(50, Math.min(100, await new SettingsService(this.db).getInt('quota_limit_percent', 95)));
  }

  /**
   * Clears requests that can no longer happen: the target was paused, removed
   * or lost its verification, or an operator, host or agent request has waited
   * `SWITCH_REQUEST_TTL_MS` for a turn boundary that never came (no wrapper
   * that can switch, a session that never goes idle). Policy requests are
   * re-derived on every pass and need no age limit.
   */
  private async expireRequests(engine: Engine, pool: PoolAccount[], now = Date.now()): Promise<void> {
    for (const scope of await this.scopes(engine, pool)) {
      const pending = scope.account_switch;
      if (!pending) continue;
      const asked = pending.requested_at ? Date.parse(pending.requested_at) : NaN;
      const withdrawn = !this.usable(pool, pending.account_id)
        ? 'target_unavailable'
        : pending.reason !== 'policy' && Number.isFinite(asked) && now - asked > SWITCH_REQUEST_TTL_MS
          ? 'expired'
          : null;
      if (!withdrawn) continue;
      try {
        await this.requestSwitch({ hostId: scope.host_id, engine, scopeId: scope.scope_id, target: scope.account_id, reason: 'policy', withdrawn });
      } catch {
        // A scope that changed meanwhile is looked at again on the next pass.
      }
    }
  }

  /**
   * Applies the automatic policy to every live scope of an engine: a scope whose
   * account should move gets a pending `policy` switch. A pending policy switch
   * follows the current readings (retargeted or withdrawn); admin and agent
   * requests stay.
   */
  async evaluate(engine: Engine): Promise<number> {
    if (!LIVE_SWITCH_ENGINES.has(engine)) return 0;
    const policy: AccountPolicy = await readAccountPolicy(this.db, engine);
    const pool = await this.pool(engine);
    // Also under the manual policy: a request nobody can carry out must not
    // wait on its scope for ever.
    await this.expireRequests(engine, pool);
    const requested = await this.rebalance(engine, policy, pool);
    // After the requests are settled: a scope whose switch has waited long
    // enough, or cannot wait, is paused for it. Operator and agent requests
    // count as well, so this runs under the manual policy too.
    const limitPercent = await this.limitPercent();
    await this.pauses.tick(engine, {
      policy,
      usable: (id) => this.usable(pool, id),
      score: (id) => pool.find((a) => a.id === id)?.score ?? null,
      ceiling: policyCeiling(policy, limitPercent),
    });
    return requested;
  }

  /** The automatic policy's part of `evaluate`: requests, retargets and withdrawals. */
  private async rebalance(engine: Engine, policy: AccountPolicy, pool: PoolAccount[]): Promise<number> {
    if (policy.mode !== 'auto') return 0;
    // One usable account is enough to move a scope off an account that was
    // paused or lost its verification; `rebalanceTarget` finds no target for a
    // scope that already runs on the only usable one.
    if (!pool.some((a) => a.state === 'enabled' && a.verified)) return 0;
    const candidates = this.candidates(pool);
    const limitPercent = await this.limitPercent();
    let requested = 0;
    for (const scope of await this.scopes(engine, pool)) {
      const pending = scope.account_switch;
      // Admin and agent requests stand; a policy request follows the readings.
      if (pending && pending.reason !== 'policy') continue;
      const target = rebalanceTarget(policy, scope.account_id, candidates, scope.bound_at, Date.now(), limitPercent);
      if (pending && target?.id === pending.account_id) continue;
      if (!target) {
        if (!pending) continue;
        // The reading that asked for the move no longer holds (for example a
        // stale reading right after a switch): withdraw it instead of moving.
        try {
          await this.requestSwitch({ hostId: scope.host_id, engine, scopeId: scope.scope_id, target: scope.account_id, reason: 'policy', withdrawn: 'readings' });
        } catch {
          // Re-evaluated on the next pass.
        }
        continue;
      }
      try {
        await this.requestSwitch({ hostId: scope.host_id, engine, scopeId: scope.scope_id, target: target.id, reason: 'policy' });
        requested += 1;
      } catch {
        // A scope that changed meanwhile is re-evaluated on the next pass.
      }
    }
    return requested;
  }
}

