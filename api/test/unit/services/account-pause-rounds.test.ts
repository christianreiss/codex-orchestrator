import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import * as schema from '../../../src/db/schema.js';
import { CommandExecutor } from '../../../src/control-plane/commands.js';
import { DeadlineQueue } from '../../../src/control-plane/deadlines.js';
import { OwnerStateSnapshot, OwnerStateStore, type PreparedOwnerState } from '../../../src/control-plane/state/store.js';
import type { StateSeed } from '../../../src/control-plane/state/catalog.js';
import { bindOwnerRuntime, type OwnerRuntime } from '../../../src/control-plane/state/runtime.js';
import type { PersistenceTransaction } from '../../../src/control-plane/persistence.js';
import { ConnectionPresence, bindOwnerPresence } from '../../../src/control-plane/presence.js';
import { acquireOwnedProvider, providerPause } from '../../../src/control-plane/streams/provider-leases.js';
import { stageUpdate } from '../../../src/control-plane/state/rows.js';
import { mutateOwnerState } from '../../../src/control-plane/state/runtime.js';
import {
  AccountPauseRounds,
  PAUSE_COMMIT_MARGIN_MS,
  PAUSE_FAILURE_BACKOFF_MS,
  PAUSE_STRAGGLER_BACKOFF_MS,
  WRITE_PENDING_FRESH_MS,
  type PauseTickInput,
} from '../../../src/services/account-switch/pause.js';
import { parseStoredPolicy } from '../../../src/services/account-policy.js';
import type { Database } from '../../../src/db/client.js';
import { createDbFake } from '../../helpers/db-fake.js';

const queues: DeadlineQueue[] = [];
afterEach(() => {
  queues.splice(0).forEach((q) => q.close());
});

const A = 'a'.repeat(32);
const B = 'b'.repeat(32);
const C = 'c'.repeat(32);
const SCOPE = 's'.repeat(32);

function harness() {
  const now = new Date().toISOString();
  const account = (id: number) => ({
    id,
    engine: 'claude',
    state: 'enabled',
    payloadId: id,
    lastSelectedAt: null,
    mergedIntoAccountId: null,
    createdAt: now,
    updatedAt: now,
  });
  const seed = {
    hosts: [{ id: 1, fqdn: 'one.test' }],
    providerAccounts: [account(1), account(2)],
    authPayloads: [
      { id: 1, engine: 'claude', accountId: 1, verificationState: 'verified' },
      { id: 2, engine: 'claude', accountId: 2, verificationState: 'verified' },
    ],
  };
  const tables = new Map<unknown, Record<string, unknown>[]>(
    Object.entries(seed).map(([name, values]) => [(schema as unknown as Record<string, unknown>)[name], structuredClone(values)]),
  );
  tables.set(schema.logs, []);
  const db = createDbFake(tables as never);
  const state = new OwnerStateStore(new OwnerStateSnapshot({ epoch: randomUUID(), sequence: 0n }, seed as unknown as StateSeed));
  const deadlines = new DeadlineQueue((e) => {
    throw e;
  });
  queues.push(deadlines);
  const executor = new CommandExecutor<OwnerStateSnapshot, PersistenceTransaction, PreparedOwnerState>({
    state,
    assertOwner() {},
    loseOwner(e) {
      throw e;
    },
    committed() {},
    notificationError(e) {
      throw e;
    },
    persistence: {
      async receipt() {
        return undefined;
      },
      async transaction(run) {
        await run(db as unknown as PersistenceTransaction);
      },
      async record() {},
    },
  });
  const owner: OwnerRuntime = { state, deadlines, assertOwner() {}, execute: (command) => executor.execute(command) };
  const presence = new ConnectionPresence((e) => {
    throw e;
  });
  bindOwnerPresence(owner, presence);
  // The service only needs a handle that names the owner; the transaction the
  // executor hands out is the fake database itself.
  const handle = {};
  bindOwnerRuntime(handle, owner);
  const rounds = new AccountPauseRounds(handle as unknown as Database);
  const attached = new Map<string, { detach(): void }>();
  const attach = (id: string) => {
    attached.set(
      id,
      presence.attach({ connectionId: randomUUID(), hostId: 1, username: 'u', scope: { topic: 'provider', provider_session_id: id, engine: 'claude' } as never }),
    );
  };
  const detach = (id: string) => attached.get(id)?.detach();
  const lease = (id: string) => state.snapshot().table('providerAccountSessions').get(id)!;
  const patchScope = async (patch: Record<string, unknown>) => {
    await mutateOwnerState(owner, {
      kind: 'test.scope.patch',
      payload: {},
      prepare(command) {
        for (const row of command.draft.table('providerAccountSessions').all()) stageUpdate(command, 'providerAccountSessions', row.id, patch as never);
        return null;
      },
    });
  };
  /** A live session: a connection-owned lease whose hooks have run and whose stream is attached. */
  const session = async (id: string, capable = true) => {
    await acquireOwnedProvider(owner, 1, 'claude', SCOPE, id, 90, 1, 'connection');
    attach(id);
    if (capable) await rounds.report({ hostId: 1, engine: 'claude', sessionId: id, state: 'capable' });
  };
  const audits = () =>
    db.inserts
      .filter((i) => i.table === schema.logs)
      .map((i) => {
        const row = i.values as { action: string; details: string };
        return { action: row.action, details: JSON.parse(row.details) as Record<string, unknown> };
      });
  return { owner, rounds, session, attach, detach, lease, patchScope, audits };
}

function input(overrides: Omit<Partial<PauseTickInput>, 'policy'> & { policy?: Record<string, unknown> } = {}): PauseTickInput {
  const { policy, ...rest } = overrides;
  return {
    policy: parseStoredPolicy(JSON.stringify({ pause: 'on', pause_after_seconds: 120, pause_hold_seconds: 90, ...(policy ?? {}) })),
    usable: () => true,
    score: () => 40,
    ceiling: 96,
    ...rest,
  };
}

const requested = (at: number) => ({ desiredAccountId: 2, desiredReason: 'policy', desiredAt: new Date(at).toISOString() });

describe('pause rounds', () => {
  it('asks every session of a scope once its switch has waited long enough, and is ready when all report', async () => {
    const h = harness();
    await h.session(A);
    await h.session(B);
    const t0 = Date.now();
    await h.patchScope(requested(t0));
    // Not yet: a gap between turns costs nothing and gets its two minutes.
    expect(await h.rounds.tick('claude', input(), t0 + 119_000)).toEqual({ started: 0, aborted: 0 });
    expect(h.rounds.nextAt('claude')).toBe(t0 + 120_000);
    expect(await h.rounds.tick('claude', input(), t0 + 120_000)).toEqual({ started: 1, aborted: 0 });
    const round = h.lease(A).pauseRound!;
    expect(h.lease(B).pauseRound).toBe(round);
    expect(h.lease(A).pauseState).toBe('requested');
    expect(Date.parse(h.lease(A).pauseDeadline!)).toBe(t0 + 120_000 + 90_000);
    expect(h.rounds.nextAt('claude')).toBe(t0 + 210_000);
    // What each session receives on its provider stream.
    expect(providerPause(h.lease(A))).toEqual({ round, deadline: h.lease(A).pauseDeadline, ready: false });
    expect(h.audits().at(-1)).toMatchObject({ action: 'provider_account.switch_pause_started', details: { round, asked: [A, B], to_account_id: 2, hold_seconds: 90 } });

    await h.rounds.report({ hostId: 1, engine: 'claude', sessionId: A, state: 'paused', round, now: t0 + 125_000 });
    expect(h.lease(A).pauseState).toBe('paused');
    expect(h.lease(A).pauseReadyAt).toBeNull();
    await h.rounds.report({ hostId: 1, engine: 'claude', sessionId: B, state: 'paused', round, now: t0 + 131_000 });
    expect(h.lease(A).pauseReadyAt).not.toBeNull();
    expect(providerPause(h.lease(B))).toMatchObject({ round, ready: true });

    // The commit of the wrapper that switches belongs to this round and to no other.
    expect(() => h.rounds.assertCommit(h.lease(A), round, t0 + 140_000)).not.toThrow();
    expect(() => h.rounds.assertCommit(h.lease(A), randomUUID(), t0 + 140_000)).toThrow(/pause round is over/);
    expect(() => h.rounds.assertCommit(h.lease(A), round, t0 + 210_000 - PAUSE_COMMIT_MARGIN_MS + 1)).toThrow(/pause round is over/);
    // A commit outside any round is not judged by rounds at all.
    expect(() => h.rounds.assertCommit(h.lease(A), undefined, t0 + 999_000)).not.toThrow();
    expect(h.rounds.commitDetails(h.lease(A), round, t0 + 140_000)).toEqual({ round, asked: 2, paused_after_ms: 11_000, committed_after_ms: 20_000 });

    // Written: everyone goes on, and the record says how long they were held.
    await h.rounds.report({ hostId: 1, engine: 'claude', sessionId: B, state: 'done', round, now: t0 + 142_000 });
    expect(h.lease(A).pauseRound).toBeNull();
    expect(h.lease(B).pauseState).toBeNull();
    expect(providerPause(h.lease(A))).toBeNull();
    expect(h.audits().at(-1)).toMatchObject({
      action: 'provider_account.switch_pause_finished',
      details: { round, session_id: B, asked: 2, paused_after_ms: 11_000, held_ms: 22_000 },
    });
    expect(h.rounds.view([h.lease(A), h.lease(B)])).toMatchObject({ pausable: true, round: null, last: { round, outcome: 'switched', asked: 2 } });
    // A report for a round that is over never touches the next one.
    await expect(h.rounds.report({ hostId: 1, engine: 'claude', sessionId: A, state: 'paused', round })).rejects.toMatchObject({ code: 'account_pause_stale' });
  });

  it('pauses at once when the account cannot wait', async () => {
    const h = harness();
    await h.session(A);
    const t0 = Date.now();
    await h.patchScope(requested(t0));
    // At the ceiling, or refused by the provider (score 100).
    expect(await h.rounds.tick('claude', input({ score: () => 96 }), t0 + 1000)).toEqual({ started: 1, aborted: 0 });
    const h2 = harness();
    await h2.session(A);
    await h2.patchScope(requested(t0));
    // The account being left is paused or lost its verification.
    expect(await h2.rounds.tick('claude', input({ usable: (id) => id === 2 }), t0 + 1000)).toEqual({ started: 1, aborted: 0 });
    // But never for a target that is gone: the evaluator withdraws that request.
    const h3 = harness();
    await h3.session(A);
    await h3.patchScope(requested(t0 - 600_000));
    expect(await h3.rounds.tick('claude', input({ usable: (id) => id === 1 }), t0)).toEqual({ started: 0, aborted: 0 });
  });

  it('starts no round while one session of the scope cannot pause', async () => {
    const h = harness();
    await h.session(A);
    await h.session(B, false); // a wrapper without the gate hooks
    const t0 = Date.now();
    await h.patchScope(requested(t0 - 600_000));
    expect(await h.rounds.tick('claude', input(), t0)).toEqual({ started: 0, aborted: 0 });
    expect(h.rounds.view([h.lease(A), h.lease(B)])).toMatchObject({ pausable: false, blocked_by: [{ session_id: B, reason: 'no_hooks' }] });
    // Its hooks run after all, but its stream is gone.
    await h.rounds.report({ hostId: 1, engine: 'claude', sessionId: B, state: 'capable' });
    h.detach(B);
    expect(await h.rounds.tick('claude', input(), t0)).toEqual({ started: 0, aborted: 0 });
    expect(h.rounds.view([h.lease(A), h.lease(B)])?.blocked_by).toEqual([{ session_id: B, reason: 'detached' }]);
    h.attach(B);
    expect(await h.rounds.tick('claude', input(), t0)).toEqual({ started: 1, aborted: 0 });
    // And nothing at all while the policy says no.
    const off = harness();
    await off.session(A);
    await off.patchScope(requested(t0 - 600_000));
    expect(await off.rounds.tick('claude', input({ policy: { pause: 'off' } }), t0)).toEqual({ started: 0, aborted: 0 });
  });

  it('counts only a connection-owned lease as able to pause', async () => {
    const h = harness();
    await acquireOwnedProvider(h.owner, 1, 'claude', SCOPE, A, 90, 1, 'timed');
    // No stream a pause could travel on: the wrapper is told nothing, so it does not ask again.
    expect(await h.rounds.report({ hostId: 1, engine: 'claude', sessionId: A, state: 'capable' })).toEqual({});
    expect(h.rounds.capable(1, 'claude', A)).toBeNull();
    expect(h.lease(A).pauseCapable).toBe(0);
    await expect(h.rounds.report({ hostId: 1, engine: 'claude', sessionId: C, state: 'capable' })).rejects.toThrow(/not found/);
    await expect(h.rounds.report({ hostId: 1, engine: 'codex', sessionId: A, state: 'capable' })).rejects.toMatchObject({ code: 'account_switch_unsupported_engine' });
  });

  it('releases everyone when the round runs out, and waits longer each time', async () => {
    const h = harness();
    await h.session(A);
    await h.session(B);
    let now = Date.now();
    await h.patchScope(requested(now - 600_000));
    for (const [index, wait] of [...PAUSE_STRAGGLER_BACKOFF_MS, PAUSE_STRAGGLER_BACKOFF_MS.at(-1)!].entries()) {
      expect(await h.rounds.tick('claude', input(), now)).toEqual({ started: 1, aborted: 0 });
      const round = h.lease(A).pauseRound!;
      await h.rounds.report({ hostId: 1, engine: 'claude', sessionId: A, state: 'paused', round, now: now + 5000 });
      // B never reports: a model response that outlasts the budget.
      expect(await h.rounds.tick('claude', input(), now + 89_000)).toEqual({ started: 0, aborted: 0 });
      now += 90_000;
      expect(await h.rounds.tick('claude', input(), now)).toEqual({ started: 0, aborted: 1 });
      expect(h.lease(A).pauseRound).toBeNull();
      expect(h.audits().at(-1)).toMatchObject({
        action: 'provider_account.switch_pause_aborted',
        details: { round, reason: 'deadline', asked: [A, B], paused: [A], waiting: [B], blocker: B, waited_ms: 90_000 },
      });
      expect(h.rounds.view([h.lease(A), h.lease(B)])).toMatchObject({ last: { outcome: 'deadline', blocker: B, paused: 1, asked: 2 } });
      // The request stays; the next round waits for the backoff.
      expect(h.lease(A).desiredAccountId).toBe(2);
      expect(await h.rounds.tick('claude', input(), now + wait - 1000)).toEqual({ started: 0, aborted: 0 });
      expect(h.rounds.nextAt('claude')).toBe(now + wait);
      now += wait;
      void index;
    }
  });

  it('ends the round at once when a session takes its report back or loses its stream', async () => {
    const h = harness();
    await h.session(A);
    await h.session(B);
    const t0 = Date.now();
    await h.patchScope(requested(t0 - 600_000));
    await h.rounds.tick('claude', input(), t0);
    let round = h.lease(A).pauseRound!;
    await h.rounds.report({ hostId: 1, engine: 'claude', sessionId: A, state: 'paused', round, now: t0 + 1000 });
    await h.rounds.report({ hostId: 1, engine: 'claude', sessionId: A, state: 'running', round, reason: 'subagent x is in a model request', now: t0 + 2000 });
    expect(h.lease(B).pauseRound).toBeNull();
    expect(h.audits().at(-1)).toMatchObject({ details: { reason: 'running', blocker: A, detail: 'subagent x is in a model request' } });

    const t1 = t0 + 2000 + PAUSE_STRAGGLER_BACKOFF_MS[0]!;
    expect(await h.rounds.tick('claude', input(), t1)).toEqual({ started: 1, aborted: 0 });
    round = h.lease(A).pauseRound!;
    h.detach(B); // its wrapper was killed
    expect(await h.rounds.tick('claude', input(), t1 + 3000)).toEqual({ started: 0, aborted: 1 });
    expect(h.audits().at(-1)).toMatchObject({ details: { round, reason: 'detached', blocker: B } });
  });

  it('backs off for longer after a flush, commit or write that failed', async () => {
    const h = harness();
    await h.session(A);
    await h.session(B);
    let now = Date.now();
    await h.patchScope(requested(now - 600_000));
    for (const wait of PAUSE_FAILURE_BACKOFF_MS) {
      expect(await h.rounds.tick('claude', input(), now)).toEqual({ started: 1, aborted: 0 });
      const round = h.lease(A).pauseRound!;
      // Reported while the others are still coming to rest: nobody is held for the whole budget.
      await h.rounds.report({ hostId: 1, engine: 'claude', sessionId: B, state: 'failed', round, reason: 'flush: server says no', now: now + 800 });
      expect(h.lease(A).pauseRound).toBeNull();
      expect(h.audits().at(-1)).toMatchObject({ details: { reason: 'failed', detail: 'flush: server says no', waited_ms: 800 } });
      expect(await h.rounds.tick('claude', input(), now + 800 + wait - 1000)).toEqual({ started: 0, aborted: 0 });
      now += 800 + wait;
    }
  });

  it('asks a session that joins a running round, and is ready only when it has answered too', async () => {
    const h = harness();
    await h.session(A);
    const t0 = Date.now();
    await h.patchScope(requested(t0 - 600_000));
    await h.rounds.tick('claude', input(), t0);
    const round = h.lease(A).pauseRound!;
    // A new launch in the scope: it inherits the round, not the proof that its hooks run.
    await acquireOwnedProvider(h.owner, 1, 'claude', SCOPE, B, 90, 1, 'connection');
    h.attach(B);
    expect(h.lease(B)).toMatchObject({ pauseRound: round, pauseState: 'requested', pauseCapable: 0, pauseDeadline: h.lease(A).pauseDeadline });
    expect(h.rounds.capable(1, 'claude', B)).toBe(false);
    expect(h.rounds.capable(1, 'claude', A)).toBe(true);
    await h.rounds.report({ hostId: 1, engine: 'claude', sessionId: A, state: 'paused', round, now: t0 + 1000 });
    expect(h.lease(A).pauseReadyAt).toBeNull();
    await h.rounds.report({ hostId: 1, engine: 'claude', sessionId: B, state: 'paused', round, now: t0 + 2000 });
    expect(h.lease(A).pauseReadyAt).not.toBeNull();
    expect(h.lease(B).pauseReadyAt).not.toBeNull();
    // The same session reserving its lease again keeps what it had reported.
    await acquireOwnedProvider(h.owner, 1, 'claude', SCOPE, A, 90, 1, 'connection');
    expect(h.lease(A)).toMatchObject({ pauseRound: round, pauseState: 'paused', pauseCapable: 1 });
  });

  it('pauses a scope whose credentials were committed but not written', async () => {
    const h = harness();
    await h.session(A);
    const t0 = Date.now();
    const generation = h.lease(A).bindingGeneration;
    // No request is pending: the commit went through, the write did not.
    expect(await h.rounds.tick('claude', input(), t0)).toEqual({ started: 0, aborted: 0 });
    h.rounds.noteUnfinishedWrite(1, 'claude', SCOPE, generation, t0);
    expect(await h.rounds.tick('claude', input(), t0 + 1000)).toEqual({ started: 1, aborted: 0 });
    expect(h.audits().at(-1)).toMatchObject({ details: { reason: 'credentials_not_written', to_account_id: null } });
    const round = h.lease(A).pauseRound!;
    await h.rounds.report({ hostId: 1, engine: 'claude', sessionId: A, state: 'paused', round, now: t0 + 2000 });
    await h.rounds.report({ hostId: 1, engine: 'claude', sessionId: A, state: 'done', round, now: t0 + 3000 });
    // Written: the report is history. An old one does not start another round either.
    expect(await h.rounds.tick('claude', input(), t0 + 4000)).toEqual({ started: 0, aborted: 0 });
    h.rounds.noteUnfinishedWrite(1, 'claude', SCOPE, generation, t0);
    expect(await h.rounds.tick('claude', input(), t0 + WRITE_PENDING_FRESH_MS + 1000)).toEqual({ started: 0, aborted: 0 });
  });

  it('ends a running round when pausing is switched off', async () => {
    const h = harness();
    await h.session(A);
    const t0 = Date.now();
    await h.patchScope(requested(t0 - 600_000));
    await h.rounds.tick('claude', input(), t0);
    expect(await h.rounds.tick('claude', input({ policy: { pause: 'off' } }), t0 + 1000)).toEqual({ started: 0, aborted: 1 });
    expect(h.lease(A).pauseRound).toBeNull();
    // Switched on again, nothing holds the scope back: that was no failed round.
    expect(await h.rounds.tick('claude', input(), t0 + 2000)).toEqual({ started: 1, aborted: 0 });
  });
});
