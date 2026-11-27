import { randomUUID } from 'node:crypto';
import type { Database } from '../../db/client.js';
import { providerAccountSessions } from '../../db/schema.js';
import { ConflictError, NotFoundError } from '../../http/errors.js';
import { mutateOwnerState, ownerRuntimeFor, type OwnerRuntime } from '../../control-plane/state/runtime.js';
import { ownerPresence } from '../../control-plane/presence.js';
import { stageUpdate } from '../../control-plane/state/rows.js';
import { persistAuditLog } from '../audit-log.js';
import { wsPublisher } from '../../ws/publisher.js';
import type { Engine } from '../../util/engine.js';
import { LIVE_SWITCH_ENGINES, type AccountPolicy } from '../account-policy.js';

/**
 * Pause, switch, resume.
 *
 * A live account switch needs a moment in which no session sharing one
 * credentials file has a model request in flight. On a busy host that moment
 * rarely comes by itself, so the server makes it: it asks every session of
 * the scope to hold itself at its next hook, records who was asked and who
 * reported back, marks the round ready once all have, and releases everyone
 * when the wrapper that switched says so, or when the round runs out.
 *
 * The round lives on the scope's lease rows, like the pending switch does, so
 * each change reaches its session through the lease's provider stream. That
 * stream and the proof that a session is attached exist only under the owner
 * runtime; without it there are no rounds and a switch waits as before.
 *
 * What is kept in memory only (backoff, the last outcome, the start of a
 * round) is lost with the owner process. The effect is an earlier retry and a
 * missing duration in one audit row; a held session is released by its own
 * local deadline either way.
 */

type Lease = typeof providerAccountSessions.$inferSelect;
export type PauseReportState = 'capable' | 'paused' | 'running' | 'done' | 'failed';
export type PauseAbortReason = 'deadline' | 'running' | 'detached' | 'failed' | 'disabled';

/** A commit is accepted until this long before the round ends: the write still has to happen inside it. */
export const PAUSE_COMMIT_MARGIN_MS = 10_000;
/** Waits after a round a session did not join in time. The last one repeats. */
export const PAUSE_STRAGGLER_BACKOFF_MS = [2, 5, 10].map((m) => m * 60_000);
/** Waits after a round whose flush, commit or write failed: pausing again soon would only freeze the scope again. */
export const PAUSE_FAILURE_BACKOFF_MS = [10, 30, 60].map((m) => m * 60_000);
/** How long a wrapper's "credentials not written" report keeps a scope eligible; wrappers repeat it every minute. */
export const WRITE_PENDING_FRESH_MS = 3 * 60_000;

export interface PauseOutcome {
  round: string;
  outcome: 'switched' | PauseAbortReason;
  at: string;
  /** Sessions asked, and those that had reported paused when the round ended. */
  asked: number;
  paused: number;
  /** The session that kept the round from completing, when one did. */
  blocker: string | null;
  detail: string | null;
}

export interface PauseScopeView {
  /** Every live session of the scope can be paused right now. */
  pausable: boolean;
  /** Sessions that cannot, with the reason: `timed_lease`, `no_hooks` or `detached`. */
  blocked_by: Array<{ session_id: string; reason: string }>;
  round: {
    id: string;
    deadline: string;
    ready_at: string | null;
    sessions: Array<{ session_id: string; state: string; reported_at: string | null }>;
  } | null;
  last: PauseOutcome | null;
  /** When the next round may start after a failed one (null: not held back). */
  retry_at: string | null;
}

export interface PauseTickInput {
  policy: AccountPolicy;
  /** Enabled and verified. */
  usable(accountId: number): boolean;
  score(accountId: number): number | null;
  /** The usage from which an account must hand over at once (policyCeiling). */
  ceiling: number;
}

interface ScopeMemory {
  stragglers: number;
  failures: number;
  retryAt: number;
  last: PauseOutcome | null;
}

interface OwnerMemory {
  scopes: Map<string, ScopeMemory>;
  /** scope key + binding generation -> when a wrapper last reported the credentials as not written. */
  writePending: Map<string, number>;
  /** round -> when it started and how many sessions were asked. */
  rounds: Map<string, { startedAt: number; asked: number; readyAt: number | null }>;
  /** engine -> when the worker should look again. */
  nextAt: Map<string, number>;
}

const memories = new WeakMap<OwnerRuntime, OwnerMemory>();

function memoryOf(owner: OwnerRuntime): OwnerMemory {
  let memory = memories.get(owner);
  if (!memory) {
    memory = { scopes: new Map(), writePending: new Map(), rounds: new Map(), nextAt: new Map() };
    memories.set(owner, memory);
  }
  return memory;
}

const scopeKey = (hostId: number, engine: string, scopeId: string) => `${hostId}\u0000${engine}\u0000${scopeId}`;
const liveLease = (row: Lease, now: string) => row.ownershipMode === 'connection' || row.expiresAt > now;
const generationOf = (row: Pick<Lease, 'bindingGeneration'>) => row.bindingGeneration ?? 1;
const CLEARED = { pauseRound: null, pauseDeadline: null, pauseState: null, pauseReportedAt: null, pauseReadyAt: null } as const;

function scopeMemory(memory: OwnerMemory, key: string): ScopeMemory {
  let scope = memory.scopes.get(key);
  if (!scope) {
    if (memory.scopes.size > 5000) memory.scopes.clear();
    scope = { stragglers: 0, failures: 0, retryAt: 0, last: null };
    memory.scopes.set(key, scope);
  }
  return scope;
}

export class AccountPauseRounds {
  constructor(private readonly db: Database) {}

  private owner(): OwnerRuntime | null {
    const owner = ownerRuntimeFor(this.db);
    owner?.assertOwner();
    return owner ?? null;
  }

  private rows(owner: OwnerRuntime, hostId: number, engine: Engine, scopeId: string, now = new Date().toISOString()): Lease[] {
    return owner.state
      .snapshot()
      .table('providerAccountSessions')
      .all()
      .filter((r) => r.hostId === hostId && r.engine === engine && r.scopeId === scopeId && liveLease(r, now));
  }

  /** Why a lease cannot be paused, or null when it can. */
  private obstacle(owner: OwnerRuntime, row: Lease): string | null {
    if (row.ownershipMode !== 'connection') return 'timed_lease';
    if (!row.pauseCapable) return 'no_hooks';
    if (!ownerPresence(owner).hasProvider(row.id)) return 'detached';
    return null;
  }

  /**
   * Stages changes on rows of one scope inside one owner command. `plan` sees
   * the rows as they are at that moment and answers the patches, or null to
   * do nothing.
   */
  private async change(
    owner: OwnerRuntime,
    kind: string,
    scope: { hostId: number; engine: Engine; scopeId: string },
    plan: (rows: Lease[]) => { patches: Map<string, Partial<Lease>>; audit?: { action: string; details: Record<string, unknown> } } | null,
  ): Promise<boolean> {
    let changed = false;
    await mutateOwnerState(owner, {
      kind,
      payload: { hostId: scope.hostId, engine: scope.engine, scopeId: scope.scopeId },
      prepare(command) {
        const now = new Date().toISOString();
        const rows = command.draft
          .table('providerAccountSessions')
          .all()
          .filter((r) => r.hostId === scope.hostId && r.engine === scope.engine && r.scopeId === scope.scopeId && liveLease(r, now));
        const planned = plan(rows);
        changed = !!planned && planned.patches.size > 0;
        if (!planned) return null;
        for (const [id, patch] of planned.patches) stageUpdate(command, 'providerAccountSessions', id, patch);
        const audit = planned.audit;
        if (audit)
          command.write(async (tx) => {
            await persistAuditLog(tx, { hostId: scope.hostId, action: audit.action, details: JSON.stringify(audit.details), createdAt: now });
          });
        return null;
      },
    });
    if (changed) wsPublisher.publish('accounts.updated', { host_id: scope.hostId, scope_id: scope.scopeId });
    return changed;
  }

  /** Ends the round of a scope without a switch and decides when the next one may start. */
  private async abort(
    owner: OwnerRuntime,
    scope: { hostId: number; engine: Engine; scopeId: string },
    round: string,
    reason: PauseAbortReason,
    detail: string | null,
    blocker: string | null,
    now: number,
  ): Promise<boolean> {
    const memory = memoryOf(owner);
    let outcome: PauseOutcome | null = null;
    let generation = 0;
    const ended = await this.change(owner, 'provider.scope.pause.abort', scope, (rows) => {
      if (!rows.some((r) => r.pauseRound === round)) return null;
      const asked = rows.filter((r) => r.pauseRound === round);
      const paused = asked.filter((r) => r.pauseState === 'paused');
      const waiting = asked.filter((r) => r.pauseState !== 'paused').map((r) => r.id);
      generation = generationOf(rows[0]!);
      outcome = {
        round,
        outcome: reason,
        at: new Date(now).toISOString(),
        asked: asked.length,
        paused: paused.length,
        blocker: blocker ?? waiting[0] ?? null,
        detail,
      };
      return {
        patches: new Map(rows.filter((r) => r.pauseRound).map((r) => [r.id, { ...CLEARED }])),
        audit: {
          action: 'provider_account.switch_pause_aborted',
          details: {
            engine: scope.engine,
            scope_id: scope.scopeId,
            round,
            reason,
            detail,
            asked: asked.map((r) => r.id),
            paused: paused.map((r) => r.id),
            waiting,
            blocker: blocker ?? waiting[0] ?? null,
            waited_ms: memory.rounds.has(round) ? now - memory.rounds.get(round)!.startedAt : null,
          },
        },
      };
    });
    memory.rounds.delete(round);
    if (!ended || !outcome) return false;
    const state = scopeMemory(memory, `${scopeKey(scope.hostId, scope.engine, scope.scopeId)}\u0000${generation}`);
    state.last = outcome;
    if (reason === 'failed') {
      state.retryAt = now + PAUSE_FAILURE_BACKOFF_MS[Math.min(state.failures, PAUSE_FAILURE_BACKOFF_MS.length - 1)]!;
      state.failures += 1;
    } else if (reason !== 'disabled') {
      state.retryAt = now + PAUSE_STRAGGLER_BACKOFF_MS[Math.min(state.stragglers, PAUSE_STRAGGLER_BACKOFF_MS.length - 1)]!;
      state.stragglers += 1;
    }
    return true;
  }

  /**
   * Whether the server counts the lease as able to pause. Null when it never
   * can be: without the owner runtime, or for a timed lease, there is no
   * stream a pause could travel on. A wrapper is only told what it can act on.
   */
  capable(hostId: number, engine: Engine, sessionId: string): boolean | null {
    const owner = this.owner();
    if (!owner) return null;
    const row = owner.state.snapshot().table('providerAccountSessions').get(sessionId);
    if (!row || row.hostId !== hostId || row.engine !== engine || row.ownershipMode !== 'connection') return null;
    return !!row.pauseCapable;
  }

  /** `capable` as a response field: absent when the lease can never pause. */
  private capableField(hostId: number, engine: Engine, sessionId: string): { pause_capable?: boolean } {
    const capable = this.capable(hostId, engine, sessionId);
    return capable === null ? {} : { pause_capable: capable };
  }

  /**
   * A session's report. `capable` says that its hooks run; the others belong
   * to a round and are refused (409 `account_pause_stale`) once that round is
   * over, so a late report never touches the next one.
   */
  async report(input: {
    hostId: number;
    engine: Engine;
    sessionId: string;
    state: PauseReportState;
    round?: string;
    reason?: string | null;
    now?: number;
  }): Promise<{ pause_capable?: boolean }> {
    const { hostId, engine, sessionId, state } = input;
    const now = input.now ?? Date.now();
    if (!LIVE_SWITCH_ENGINES.has(engine))
      throw new ConflictError('Live account switching is not supported for this engine yet', 'account_switch_unsupported_engine');
    const owner = this.owner();
    if (!owner) return {};
    const session = owner.state.snapshot().table('providerAccountSessions').get(sessionId);
    if (!session || session.hostId !== hostId || session.engine !== engine || !liveLease(session, new Date(now).toISOString()))
      throw new NotFoundError('Account session not found');
    const scope = { hostId, engine, scopeId: session.scopeId };
    if (state === 'capable') {
      // Only a connection-owned lease has the stream a pause travels on.
      if (session.ownershipMode === 'connection' && !session.pauseCapable)
        await this.change(owner, 'provider.session.pause.capable', scope, (rows) =>
          rows.some((r) => r.id === sessionId) ? { patches: new Map([[sessionId, { pauseCapable: 1 }]]) } : null,
        );
      return this.capableField(hostId, engine, sessionId);
    }
    const round = input.round;
    if (!round) throw new ConflictError('A pause report needs its round', 'account_pause_stale');
    const stale = () => new ConflictError('The pause round is over', 'account_pause_stale');
    if (session.pauseRound !== round) throw stale();
    const memory = memoryOf(owner);
    if (state === 'paused') {
      const reportedAt = new Date(now).toISOString();
      await this.change(owner, 'provider.session.pause.paused', scope, (rows) => {
        const row = rows.find((r) => r.id === sessionId);
        if (!row || row.pauseRound !== round) throw stale();
        const patches = new Map<string, Partial<Lease>>([[sessionId, { pauseState: 'paused', pauseReportedAt: reportedAt }]]);
        // Ready when every session of the scope has reported for this round.
        // A session that joined later counts: it was asked on arrival.
        const all = rows.every((r) => r.id === sessionId || (r.pauseRound === round && r.pauseState === 'paused'));
        if (all && !row.pauseReadyAt) {
          for (const r of rows) patches.set(r.id, { ...(patches.get(r.id) ?? {}), pauseReadyAt: reportedAt });
          const known = memory.rounds.get(round);
          if (known) known.readyAt = now;
        }
        return { patches };
      });
    } else if (state === 'running') {
      await this.abort(owner, scope, round, 'running', input.reason ?? null, sessionId, now);
    } else if (state === 'failed') {
      await this.abort(owner, scope, round, 'failed', input.reason ?? null, null, now);
    } else {
      // done: the credentials are written. Everyone goes on.
      const known = memory.rounds.get(round);
      let generation = 0;
      let asked = 0;
      const ended = await this.change(owner, 'provider.scope.pause.finish', scope, (rows) => {
        if (!rows.some((r) => r.pauseRound === round)) return null;
        generation = generationOf(rows[0]!);
        asked = rows.filter((r) => r.pauseRound === round).length;
        return {
          patches: new Map(rows.filter((r) => r.pauseRound).map((r) => [r.id, { ...CLEARED }])),
          audit: {
            action: 'provider_account.switch_pause_finished',
            details: {
              engine,
              scope_id: session.scopeId,
              round,
              session_id: sessionId,
              asked,
              paused_after_ms: known?.readyAt ? known.readyAt - known.startedAt : null,
              held_ms: known ? now - known.startedAt : null,
            },
          },
        };
      });
      memory.rounds.delete(round);
      if (ended) {
        const key = scopeKey(hostId, engine, session.scopeId);
        // The binding moved with the commit: the memory of the old generation is history.
        for (const stored of [...memory.scopes.keys()]) if (stored.startsWith(`${key}\u0000`)) memory.scopes.delete(stored);
        for (const stored of [...memory.writePending.keys()]) if (stored.startsWith(`${key}\u0000`)) memory.writePending.delete(stored);
        scopeMemory(memory, `${key}\u0000${generation}`).last = {
          round,
          outcome: 'switched',
          at: new Date(now).toISOString(),
          asked,
          paused: asked,
          blocker: null,
          detail: null,
        };
      }
    }
    return this.capableField(hostId, engine, sessionId);
  }

  /**
   * A commit that names a pause round is only accepted while that round is
   * the scope's own and has time left for the write. After that the sessions
   * are running again and the commit would not happen in a quiet moment.
   */
  assertCommit(row: Lease, round: string | undefined, now = Date.now()): void {
    if (round === undefined) return;
    const deadline = row.pauseDeadline ? Date.parse(row.pauseDeadline) : NaN;
    if (row.pauseRound !== round || !Number.isFinite(deadline) || now > deadline - PAUSE_COMMIT_MARGIN_MS)
      throw new ConflictError('The pause round is over', 'account_switch_pause_expired');
  }

  /** What the `switched` audit row says about the round a commit happened in. */
  commitDetails(row: Lease, round: string | undefined, now = Date.now()): Record<string, unknown> | null {
    if (round === undefined || row.pauseRound !== round) return null;
    const owner = this.owner();
    const known = owner ? memoryOf(owner).rounds.get(round) : undefined;
    return { round, asked: known?.asked ?? null, paused_after_ms: known?.readyAt ? known.readyAt - known.startedAt : null, committed_after_ms: known ? now - known.startedAt : null };
  }

  /** A wrapper says the credentials of the scope's current binding are still not on disk. */
  noteUnfinishedWrite(hostId: number, engine: Engine, scopeId: string, generation: number, now = Date.now()): void {
    const owner = this.owner();
    if (!owner) return;
    const pending = memoryOf(owner).writePending;
    if (pending.size > 5000) pending.clear();
    pending.set(`${scopeKey(hostId, engine, scopeId)}\u0000${generation}`, now);
  }

  /** When the worker should look at this engine's rounds again (0: nothing is waiting). */
  nextAt(engine: Engine): number {
    const owner = this.owner();
    return owner ? (memoryOf(owner).nextAt.get(engine) ?? 0) : 0;
  }

  /**
   * One pass over the scopes of an engine: ends rounds that ran out, lost a
   * session or were switched off, and starts a round for every scope that is
   * waiting long enough or cannot wait.
   */
  async tick(engine: Engine, input: PauseTickInput, now = Date.now()): Promise<{ started: number; aborted: number }> {
    const owner = this.owner();
    if (!owner || !LIVE_SWITCH_ENGINES.has(engine)) return { started: 0, aborted: 0 };
    const memory = memoryOf(owner);
    const iso = new Date(now).toISOString();
    const groups = new Map<string, Lease[]>();
    for (const row of owner.state.snapshot().table('providerAccountSessions').all()) {
      if (row.engine !== engine || row.hostId <= 0 || !liveLease(row, iso)) continue;
      const key = scopeKey(row.hostId, engine, row.scopeId);
      groups.set(key, [...(groups.get(key) ?? []), row]);
    }
    let started = 0;
    let aborted = 0;
    let next = 0;
    const wake = (at: number) => {
      if (at > now && (next === 0 || at < next)) next = at;
    };
    const enabled = input.policy.pause === 'on';
    for (const [key, rows] of groups) {
      const first = rows[0]!;
      const scope = { hostId: first.hostId, engine, scopeId: first.scopeId };
      const active = rows.find((r) => r.pauseRound);
      if (active?.pauseRound) {
        const round = active.pauseRound;
        const deadline = active.pauseDeadline ? Date.parse(active.pauseDeadline) : 0;
        const detached = rows.find((r) => !ownerPresence(owner).hasProvider(r.id));
        const reason: PauseAbortReason | null = !enabled ? 'disabled' : now >= deadline ? 'deadline' : detached ? 'detached' : null;
        if (reason) {
          if (await this.abort(owner, scope, round, reason, null, reason === 'detached' ? detached!.id : null, now)) aborted += 1;
        } else wake(deadline);
        continue;
      }
      if (!enabled) continue;
      const generation = generationOf(first);
      const state = scopeMemory(memory, `${key}\u0000${generation}`);
      const pending = first.desiredAccountId && first.desiredAccountId !== first.accountId ? first.desiredAccountId : null;
      const unwritten = now - (memory.writePending.get(`${key}\u0000${generation}`) ?? -Infinity) <= WRITE_PENDING_FRESH_MS;
      if (!pending && !unwritten) continue;
      // A request whose target is gone is withdrawn by the evaluator; pausing for it would be for nothing.
      if (pending && !input.usable(pending)) continue;
      let due = now;
      if (pending && !unwritten) {
        const score = input.score(first.accountId);
        const urgent = !input.usable(first.accountId) || (score !== null && score >= input.ceiling);
        const asked = first.desiredAt ? Date.parse(first.desiredAt) : NaN;
        if (!urgent && Number.isFinite(asked)) due = asked + input.policy.pause_after_seconds * 1000;
      }
      due = Math.max(due, state.retryAt);
      if (due > now) {
        wake(due);
        continue;
      }
      if (rows.some((r) => this.obstacle(owner, r))) continue;
      const round = randomUUID();
      const deadline = now + input.policy.pause_hold_seconds * 1000;
      const begun = await this.change(owner, 'provider.scope.pause.start', scope, (current) => {
        const head = current[0];
        // Looked at again inside the command: the scope may have switched, lost its request or gained a session meanwhile.
        if (!head || current.some((r) => r.pauseRound) || generationOf(head) !== generation || head.accountId !== first.accountId) return null;
        if ((head.desiredAccountId ?? null) !== (first.desiredAccountId ?? null)) return null;
        if (current.some((r) => this.obstacle(owner, r))) return null;
        return {
          patches: new Map(
            current.map((r) => [
              r.id,
              { pauseRound: round, pauseDeadline: new Date(deadline).toISOString(), pauseState: 'requested' as const, pauseReportedAt: null, pauseReadyAt: null },
            ]),
          ),
          audit: {
            action: 'provider_account.switch_pause_started',
            details: {
              engine,
              scope_id: first.scopeId,
              round,
              asked: current.map((r) => r.id),
              from_account_id: head.accountId,
              to_account_id: pending,
              reason: unwritten && !pending ? 'credentials_not_written' : (head.desiredReason ?? null),
              hold_seconds: input.policy.pause_hold_seconds,
            },
          },
        };
      });
      if (!begun) continue;
      if (memory.rounds.size > 5000) memory.rounds.clear();
      memory.rounds.set(round, { startedAt: now, asked: rows.length, readyAt: null });
      started += 1;
      wake(deadline);
    }
    memory.nextAt.set(engine, next);
    return { started, aborted };
  }

  /** The pause side of one scope for the admin view. */
  view(rows: Lease[]): PauseScopeView | null {
    const owner = this.owner();
    const first = rows[0];
    if (!owner || !first) return null;
    const memory = memoryOf(owner);
    const state = memory.scopes.get(`${scopeKey(first.hostId, first.engine, first.scopeId)}\u0000${generationOf(first)}`);
    const blocked = rows.flatMap((r) => {
      const reason = this.obstacle(owner, r);
      return reason ? [{ session_id: r.id, reason }] : [];
    });
    const active = rows.find((r) => r.pauseRound);
    return {
      pausable: blocked.length === 0,
      blocked_by: blocked,
      round: active?.pauseRound
        ? {
            id: active.pauseRound,
            deadline: active.pauseDeadline ?? '',
            ready_at: active.pauseReadyAt ?? null,
            sessions: rows.map((r) => ({ session_id: r.id, state: r.pauseState ?? 'requested', reported_at: r.pauseReportedAt ?? null })),
          }
        : null,
      last: state?.last ?? null,
      retry_at: state && state.retryAt > Date.now() ? new Date(state.retryAt).toISOString() : null,
    };
  }
}
