import { and, eq, gt, isNull, or } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { agentSessions, hosts, providerAccounts, providerAccountSessions } from '../db/schema.js';
import { ConflictError, NotFoundError } from '../http/errors.js';
import type { Keyring } from '../security/keyring.js';
import { nowIso } from '../util/timestamp.js';
import type { Engine } from '../util/engine.js';
import { mutateOwnerState, ownerRuntimeFor } from '../control-plane/state/runtime.js';
import { ownedAccount } from '../control-plane/streams/provider-leases.js';
import { stageUpdate } from '../control-plane/state/rows.js';
import { persistAuditLog } from './audit-log.js';
import { wsPublisher } from '../ws/publisher.js';
import { quotaWindowScore } from './account-selection.js';
import { emulationBlocks } from './quota-emulation.js';
import { ProviderAccountsService } from './provider-accounts.js';
import { SettingsService } from './settings.js';
import {
  poolRecommendation,
  readAccountPolicy,
  rebalanceTarget,
  type AccountPolicy,
  type PoolRecommendation,
} from './account-policy.js';

type Lease = typeof providerAccountSessions.$inferSelect;
export type SwitchReason = 'policy' | 'admin' | 'host' | 'agent';

/** Engines whose wrapper can adopt another account inside a running session. */
export const LIVE_SWITCH_ENGINES: ReadonlySet<Engine> = new Set<Engine>(['claude']);

export interface SwitchDirective {
  account_id: number;
  account_label: string;
  binding_generation: number;
  reason: SwitchReason;
  requested_at: string | null;
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
  score: number | null;
  emulation_blocked: boolean;
  active_sessions: number;
  last_selected_at: string | null;
}

/** Where one listed account stands in its engine's pool (`/admin/accounts` `pool`). */
export interface PoolPosition {
  /** max(short, weekly) used percent; a passed reset is no reading, unlimited is 0, an emulated block is 100. */
  score: number | null;
  /** Enabled and verified: the account can take new work and live switches. */
  usable: boolean;
  emulation_blocked: boolean;
}

/** The fields of a `ProviderAccountsService.list()` row that decide its pool position. */
export interface PoolPositionInput {
  state: string;
  verification_state: string;
  usage: object;
  quota_policy?: { unlimited?: boolean } | null;
  quota_snapshot?: { short?: Parameters<typeof emulationBlocks>[0] } | null;
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
  const scores = [
    quotaWindowScore(num(usage.short_used_percent), str(usage.short_resets_at), now),
    quotaWindowScore(num(usage.weekly_used_percent), str(usage.weekly_resets_at), now),
  ].filter((x): x is number => x !== null);
  return {
    score: unlimited ? 0 : blocked ? 100 : scores.length ? Math.max(...scores) : null,
    usable: account.state === 'enabled' && account.verification_state === 'verified',
    emulation_blocked: blocked,
  };
}

const liveLease = (row: Lease, now: string) => row.ownershipMode === 'connection' || row.expiresAt > now;
const generationOf = (row: Pick<Lease, 'bindingGeneration'>) => row.bindingGeneration ?? 1;

export class AccountSwitchService {
  private readonly accounts: ProviderAccountsService;
  constructor(
    private readonly db: Database,
    keyring: Keyring,
  ) {
    this.accounts = new ProviderAccountsService(db, keyring);
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
          score: position.score,
          emulation_blocked: position.emulation_blocked,
          active_sessions: a.sessions.length,
          last_selected_at: a.last_selected_at,
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

  async directiveFor(row: Lease | undefined): Promise<SwitchDirective | null> {
    if (!row?.desiredAccountId || row.desiredAccountId === row.accountId) return null;
    return {
      account_id: row.desiredAccountId,
      account_label: await this.label(row.engine as Engine, row.desiredAccountId),
      binding_generation: generationOf(row),
      reason: (row.desiredReason as SwitchReason | null) ?? 'admin',
      requested_at: row.desiredAt ?? null,
    };
  }

  /** binding_generation + pending directive for a session (merged into responses). */
  async sessionBinding(hostId: number, engine: Engine, sessionId: string) {
    const row = (await this.leases({ hostId, engine })).find((r) => r.id === sessionId);
    if (!row) return { binding_generation: null, account_switch: null };
    return { binding_generation: generationOf(row), account_switch: await this.directiveFor(row) };
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
      const forced = rebalanceTarget({ ...policy, mode: 'auto', min_dwell_minutes: 0 }, first.accountId, candidates, null, Date.now());
      target = forced?.id ?? first.accountId;
    } else {
      target = (await this.accounts.canonicalId(input.target, engine)) ?? input.target;
    }
    if (target !== first.accountId && !this.usable(pool, target))
      throw new ConflictError('The target account is not enabled and verified', 'account_switch_target_unavailable');
    const generation = generationOf(first);
    if (target === first.accountId) {
      if (first.desiredAccountId)
        await this.updateScope(hostId, engine, scopeId, { accountId: first.accountId, generation }, { desiredAccountId: null, desiredReason: null, desiredAt: null }, null);
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
      },
    };
  }

  /** Called by the wrapper that performed the switch (after flushing the old account). */
  async commitSwitch(input: {
    hostId: number;
    engine: Engine;
    sessionId: string;
    scopeId: string;
    accountId: number;
    generation: number;
  }): Promise<{ previous_account_id: number; account_id: number; binding_generation: number }> {
    const { hostId, engine, sessionId, scopeId, generation } = input;
    if (!LIVE_SWITCH_ENGINES.has(engine))
      throw new ConflictError('Live account switching is not supported for this engine yet', 'account_switch_unsupported_engine');
    const rows = await this.leases({ hostId, engine, scopeId });
    const session = rows.find((r) => r.id === sessionId);
    if (!session) throw new NotFoundError('Account session not found');
    const target = (await this.accounts.canonicalId(input.accountId, engine)) ?? input.accountId;
    if (session.desiredAccountId !== target || generationOf(session) !== generation)
      throw new ConflictError('The switch request is no longer pending', 'account_switch_stale');
    if (!this.usable(await this.pool(engine), target)) {
      await this.updateScope(hostId, engine, scopeId, { accountId: session.accountId, generation }, { desiredAccountId: null, desiredReason: null, desiredAt: null }, null);
      throw new ConflictError('The target account is not enabled and verified', 'account_switch_target_unavailable');
    }
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
        },
      },
    );
    await this.moveAgentSessions(hostId, engine, scopeId, session.accountId, target);
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
    return { previous_account_id: session.accountId, account_id: target, binding_generation: generation + 1 };
  }

  /**
   * Agent sessions record their provider account for quota notices and
   * quota_get. They carry no scope, so they move only when no other live scope
   * of this host and engine still uses the previous account; otherwise the
   * session heals on its next registration.
   */
  private async moveAgentSessions(hostId: number, engine: Engine, scopeId: string, from: number, to: number) {
    const others = (await this.leases({ hostId, engine })).filter((r) => r.scopeId !== scopeId && r.accountId === from);
    if (others.length) return;
    const owner = ownerRuntimeFor(this.db);
    if (owner) {
      await mutateOwnerState(owner, {
        kind: 'session.provider.switch',
        payload: { hostId, engine, from, to },
        prepare(command) {
          const rows = command.draft
            .table('agentSessions')
            .all()
            .filter((r) => r.hostId === hostId && r.engine === engine && r.providerAccountId === from && !r.endedAt);
          for (const row of rows) stageUpdate(command, 'agentSessions', row.id, { providerAccountId: to });
          return null;
        },
      });
      return;
    }
    await this.db
      .update(agentSessions)
      .set({ providerAccountId: to })
      .where(
        and(
          eq(agentSessions.hostId, hostId),
          eq(agentSessions.engine, engine),
          eq(agentSessions.providerAccountId, from),
          isNull(agentSessions.endedAt),
        ),
      );
  }

  private candidates(pool: PoolAccount[]) {
    return pool
      .filter((a) => a.state === 'enabled' && a.verified)
      .map((a) => ({ id: a.id, score: a.score, active: a.active_sessions, lastSelectedAt: a.last_selected_at }));
  }

  /** Live scopes of an engine with their binding (admin view). */
  async scopes(engine: Engine) {
    const rows = await this.leases({ engine });
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
          account_switch: await this.directiveFor(first),
        };
      }),
    );
  }

  /** Pool view and the warning recommendation for one bound account. */
  async poolView(engine: Engine, boundAccountId: number | null, warnPercent?: number) {
    const [policy, pool, limitPercent] = await Promise.all([
      readAccountPolicy(this.db, engine),
      this.pool(engine),
      this.limitPercent(),
    ]);
    const view = (a: PoolAccount) => ({ id: a.id, label: a.label, score: a.score, usable: a.state === 'enabled' && a.verified });
    const bound = pool.find((a) => a.id === boundAccountId) ?? null;
    const planned = bound
      ? rebalanceTarget(policy, bound.id, this.candidates(pool), null, Date.now(), limitPercent)?.id ?? null
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
    return { policy, accounts: pool, recommendation };
  }

  /** The fleet quota limit (`/admin/quota-mode`), clamped like the auth routes. */
  private async limitPercent(): Promise<number> {
    return Math.max(50, Math.min(100, await new SettingsService(this.db).getInt('quota_limit_percent', 95)));
  }

  /**
   * Applies the automatic policy to every live scope of an engine: a scope whose
   * account should move gets a pending `policy` switch. Existing requests stay.
   */
  async evaluate(engine: Engine): Promise<number> {
    if (!LIVE_SWITCH_ENGINES.has(engine)) return 0;
    const policy: AccountPolicy = await readAccountPolicy(this.db, engine);
    if (policy.mode !== 'auto') return 0;
    const pool = await this.pool(engine);
    if (pool.filter((a) => a.state === 'enabled' && a.verified).length < 2) return 0;
    const candidates = this.candidates(pool);
    const limitPercent = await this.limitPercent();
    let requested = 0;
    for (const scope of await this.scopes(engine)) {
      if (scope.account_switch) continue;
      const target = rebalanceTarget(policy, scope.account_id, candidates, scope.bound_at, Date.now(), limitPercent);
      if (!target) continue;
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

