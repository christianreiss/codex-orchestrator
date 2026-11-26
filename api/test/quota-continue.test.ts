import { afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { supervisorFixture } from './helpers/supervisor.js';
import { mutateOwnerState } from '../src/control-plane/state/runtime.js';
import { stageUpdate } from '../src/control-plane/state/rows.js';
import type { StateSeed } from '../src/control-plane/state/catalog.js';
import { watchdogPolicy } from '../src/control-plane/streams/policies.js';
import { WatchdogsService } from '../src/services/watchdogs.js';
import { tickOwnedSchedules } from '../src/services/schedules/owner.js';
import { tickOwnedWatchdogs } from '../src/services/schedules/watchdog-owner.js';
import { AccountSwitchService } from '../src/services/account-switch.js';
import { ProviderAccountsService } from '../src/services/provider-accounts.js';
import { DEFAULT_ACCOUNT_POLICY } from '../src/services/account-policy.js';
import {
  parseQuotaExhaustion,
  quotaExhaustedKey,
  quotaExhaustionEnd,
  recordQuotaExhaustion,
  reconcileQuotaExhaustion,
} from '../src/services/quota-exhaustion.js';
import { poolContinuePossible, poolRecoveryApplies, quotaRecoveryGate, QUOTA_SWITCH_WAIT_MS } from '../src/services/quota-pool.js';
import { quotaResumeGate, quotaSnapshot } from '../src/services/quota-observation.js';
import {
  quotaContinuationPending,
  quotaContinueFence,
  quotaSwitchContinuation,
  quotaSwitchWatchdog,
  QUOTA_SWITCH_CONTINUATION,
} from '../src/services/watchdog-lifecycle.js';
import { decrypt } from '../src/security/secret-box.js';

const HOST = 94251;
const A = 1;
const B = 2;
const at = (ms: number) => new Date(Date.now() + ms).toISOString();
const HOUR = 3_600_000;

const closers: Array<() => void> = [];
afterEach(() => {
  for (const close of closers.splice(0)) close();
});

interface PoolOptions {
  engine?: string;
  /** Account policy mode of the engine (default: the stored default, `auto`). */
  mode?: 'auto' | 'manual';
  /** Readings of the two accounts; A lags at 93 % by default, B has room. */
  a?: { short?: number; shortReset?: string; weekly?: number; weeklyReset?: string };
  b?: { short?: number; shortReset?: string; weekly?: number; weeklyReset?: string } | null;
  /** Leave the host without a resident daemon. */
  noDaemon?: boolean;
  quotaPolicy?: Record<string, unknown>;
}

/** Two accounts of one engine, one scope of the fixture host bound to A. */
function pool(options: PoolOptions = {}) {
  const engine = options.engine ?? 'claude';
  const now = new Date().toISOString();
  const reading = (id: number, accountId: number, r: NonNullable<PoolOptions['a']>) => ({
    id,
    accountId,
    hostId: HOST,
    source: 'statusline',
    fiveHourUsedPercent: r.short ?? null,
    fiveHourResetsAt: r.short === undefined ? null : (r.shortReset ?? at(2 * HOUR)),
    sevenDayUsedPercent: r.weekly ?? null,
    sevenDayResetsAt: r.weekly === undefined ? null : (r.weeklyReset ?? at(72 * HOUR)),
    fetchedAt: now,
    createdAt: now,
  });
  const versions = [
    { name: 'agent_messaging_enabled', version: '1', updatedAt: now },
    ...(options.mode ? [{ name: `account_policy_${engine}`, version: JSON.stringify({ ...DEFAULT_ACCOUNT_POLICY, mode: options.mode }), updatedAt: now }] : []),
    ...(options.quotaPolicy ? [{ name: `quota_policy_${engine}`, version: JSON.stringify({ unlimited: false, short_warn_percent: 85, long_warn_percent: 85, short_auto_resume: true, long_auto_resume: false, ...options.quotaPolicy }), updatedAt: now }] : []),
  ];
  const f = supervisorFixture(engine, {
    versions,
    ...(options.noDaemon ? { hostDaemons: [] } : {}),
    providerAccounts: [A, B].map((id) => ({
      id, engine, label: id === A ? 'alpha@example.test' : 'beta@example.test', identityKey: `identity-${id}`, mergedIntoAccountId: null,
      state: 'enabled', payloadId: 10 + id, generation: 1, lastSelectedAt: null, createdAt: now, updatedAt: now,
    })),
    authPayloads: [A, B].map((id) => ({ id: 10 + id, accountId: id, engine, verificationState: 'verified', verificationReason: null, verificationCheckedAt: now, createdAt: now })),
    providerAccountSessions: [{
      id: 'lease-a', hostId: HOST, engine, scopeId: 'scope-1', accountId: A, ownershipMode: 'connection', expiresAt: at(HOUR), createdAt: now,
      bindingGeneration: 1, desiredAccountId: null, desiredReason: null, desiredAt: null, boundAt: at(-6 * HOUR),
    }],
    claudeUsageSnapshots: engine === 'claude'
      ? [reading(1, A, options.a ?? { short: 93, weekly: 40 }), ...(options.b === null ? [] : [reading(2, B, options.b ?? { short: 20, weekly: 30 })])]
      : [],
  } as unknown as StateSeed);
  closers.push(f.close);
  return f;
}
type Fixture = ReturnType<typeof pool>;

async function patch(f: Fixture, table: 'agentSessions' | 'agentWatchdogs' | 'agentScheduleRuns' | 'providerAccounts', id: string | number, value: Record<string, unknown>) {
  await mutateOwnerState(f.owner, { kind: 'test.patch', payload: { id }, prepare: (ctx) => { stageUpdate(ctx, table as 'agentSessions', id as string, value); return null; } });
}

/** The session as a live, idle Claude session on account A with its channel receiver attached. */
async function idleOnA(f: Fixture, extra: Record<string, unknown> = {}, receiver = true) {
  const a = f.agents[0]!, generation = randomUUID();
  await patch(f, 'agentSessions', a.id, {
    providerAccountId: A,
    activeTurnId: null,
    receiver: receiver ? { generation, native_session_id: a.native, heartbeat_at: f.now, probes: { peer: true }, failure: null } : null,
    activity: { generation, native_session_id: a.native, binding_generation: 1, state: 'idle', wait_reason: null, sequence: 3,
      received_at: f.now, changed_at: f.now, expires_at: '2099-01-01T00:00:00Z', receiver_bound: true },
    ...extra,
  });
  if (receiver)
    f.presence.attach({ connectionId: randomUUID(), hostId: HOST, username: 'root',
      scope: { topic: 'receiver', session_id: a.id, binding_generation: 1, receiver_generation: generation } });
  return a;
}
const quotaFailure = (f: Fixture, extra: Record<string, unknown> = {}) => ({ last_progress_at: f.now, failure: 'capacity' as const, quota_limit: true, ...extra });
const watchdogs = (f: Fixture) => f.state.snapshot().table('agentWatchdogs').all();
const continuation = (f: Fixture) => watchdogs(f).find((w) => quotaSwitchWatchdog(w));
const marker = (f: Fixture, id = A) => parseQuotaExhaustion(f.state.snapshot().setting(quotaExhaustedKey(id)));
const lease = (f: Fixture) => f.state.snapshot().table('providerAccountSessions').get('lease-a')!;
const scheduleMessages = (f: Fixture) => f.state.snapshot().messages.all().filter((m) => m.kind === 'schedule');
const soon = () => new Date(Date.now() + 11_000);

describe('how long a provider usage-limit refusal holds an account back', () => {
  const now = Date.parse('2026-11-26T12:00:00Z');
  const short = (used: number, reset: string) => ({ kind: 'short' as const, used_percent: used, resets_at: reset, source: 'claude_statusline' });
  const long = (used: number, reset: string) => ({ kind: 'long' as const, used_percent: used, resets_at: reset, source: 'claude_statusline' });

  it('believes the reset the provider stated and names its window', () => {
    expect(quotaExhaustionEnd(now, '2026-11-26T14:00:00Z', [short(93, '2026-11-26T14:02:00Z'), long(40, '2026-11-29T00:00:00Z')]))
      .toEqual({ until: '2026-11-26T14:00:00.000Z', window: 'short', source: 'provider_reset' });
    expect(quotaExhaustionEnd(now, '2026-11-29T00:00:00Z', [short(93, '2026-11-26T14:00:00Z'), long(60, '2026-11-29T00:05:00Z')]))
      .toMatchObject({ until: '2026-11-29T00:00:00.000Z', window: 'long' });
    // Further out than a short window can be: a long one, even with no reading of it.
    expect(quotaExhaustionEnd(now, '2026-11-28T15:00:00Z', [])).toMatchObject({ window: 'long', source: 'provider_reset' });
    expect(quotaExhaustionEnd(now, '2026-11-26T13:00:00Z', [])).toMatchObject({ window: null, source: 'provider_reset' });
  });

  it('does not believe a reset that is past or absurdly far away', () => {
    expect(quotaExhaustionEnd(now, '2026-11-26T11:00:00Z', []).source).toBe('default');
    expect(quotaExhaustionEnd(now, '2027-01-01T00:00:00Z', []).source).toBe('default');
    expect(quotaExhaustionEnd(now, 'tomorrow', []).source).toBe('default');
  });

  it('infers the window that is furthest along, for at most one short window', () => {
    expect(quotaExhaustionEnd(now, undefined, [short(93, '2026-11-26T14:00:00Z'), long(60, '2026-11-29T00:00:00Z')]))
      .toEqual({ until: '2026-11-26T14:00:00.000Z', window: 'short', source: 'window_reset' });
    expect(quotaExhaustionEnd(now, undefined, [short(20, '2026-11-26T14:00:00Z'), long(97, '2026-11-29T00:00:00Z')]))
      .toEqual({ until: '2026-11-26T17:00:00.000Z', window: 'long', source: 'window_reset' });
  });

  it('falls back to thirty minutes when no reading comes close to a limit', () => {
    expect(quotaExhaustionEnd(now, undefined, [short(20, '2026-11-26T14:00:00Z'), long(30, '2026-11-29T00:00:00Z')]))
      .toEqual({ until: '2026-11-26T12:30:00.000Z', window: null, source: 'default' });
    // A reading whose window has ended, and an emulated budget, say nothing.
    expect(quotaExhaustionEnd(now, undefined, [short(99, '2026-11-26T11:00:00Z'), { kind: 'short', used_percent: 100, resets_at: '2026-11-26T14:00:00Z', source: 'emulated' }]).source).toBe('default');
  });

  it('reads a stored marker only while it holds', () => {
    const stored = JSON.stringify({ at: '2026-11-26T12:00:00Z', until: '2026-11-26T14:00:00Z', window: 'short', source: 'provider_reset', short_resets_at: '2026-11-26T14:00:00Z', long_resets_at: null, host_id: 7, session_id: 's' });
    expect(parseQuotaExhaustion(stored, now)).toMatchObject({ until: '2026-11-26T14:00:00Z', window: 'short', source: 'provider_reset', host_id: 7 });
    expect(parseQuotaExhaustion(stored, Date.parse('2026-11-26T14:00:00Z'))).toBeNull();
    expect(parseQuotaExhaustion('not json', now)).toBeNull();
    expect(parseQuotaExhaustion('{"until":"2026-11-26T14:00:00Z"}', now)).toBeNull();
    expect(parseQuotaExhaustion(null, now)).toBeNull();
  });
});

describe('the failed turn as the newest activity of its session', () => {
  const armed = '2026-11-26T12:00:00.000Z';
  const activity = (state: string, changed: string) => ({ activity: { state, changed_at: changed }, endedAt: null });

  it('is clear while nothing happened after the failure', () => {
    expect(quotaContinueFence(activity('idle', '2026-11-26T11:59:58.000Z'), armed)).toBe('clear');
    // The failed turn's own idle report may trail the failure report a little.
    expect(quotaContinueFence(activity('idle', '2026-11-26T12:00:10.000Z'), armed)).toBe('clear');
    expect(quotaContinueFence({ activity: null }, armed)).toBe('clear');
    expect(quotaContinueFence(null, armed)).toBe('clear');
  });
  it('is superseded by any later turn and deferred by a running one', () => {
    expect(quotaContinueFence(activity('working', '2026-11-26T12:01:00.000Z'), armed)).toBe('superseded');
    expect(quotaContinueFence(activity('idle', '2026-11-26T12:03:00.000Z'), armed)).toBe('superseded');
    expect(quotaContinueFence(activity('working', '2026-11-26T11:50:00.000Z'), armed)).toBe('busy');
    expect(quotaContinueFence(activity('waiting', '2026-11-26T12:00:05.000Z'), armed)).toBe('busy');
  });
  it('does not take decayed hook evidence for a turn', () => {
    // 45 seconds without a hook the wrapper reports `unknown`: a change of
    // state, long after the failure, and still the same idle prompt.
    expect(quotaContinueFence(activity('unknown', '2026-11-26T12:00:47.000Z'), armed)).toBe('clear');
    expect(quotaContinueFence(activity('unknown', '2026-11-26T12:30:00.000Z'), armed)).toBe('clear');
  });
  it('follows the native turn proof where the session reports one', () => {
    const at = Date.parse(armed);
    const proof = (state: string, observed: number, activityState = 'unknown') =>
      ({ activity: { state: activityState, changed_at: '2026-11-26T12:00:47.000Z', turn_proof: { state, observed_at_ms: observed } }, endedAt: null });
    // StopFailure leaves the proof unknown; so does a reconnect, whenever it happens.
    expect(quotaContinueFence(proof('unknown', at - 1000), armed, at + 60_000)).toBe('clear');
    expect(quotaContinueFence(proof('unknown', at + 300_000), armed, at + 400_000)).toBe('clear');
    // The activity state has decayed or was re-reported; the proof has not moved.
    expect(quotaContinueFence(proof('unknown', at - 1000, 'idle'), armed, at + 60_000)).toBe('clear');
    // A prompt after the failure: a turn runs, or ran and ended.
    expect(quotaContinueFence(proof('active', at + 60_000), armed, at + 61_000)).toBe('superseded');
    expect(quotaContinueFence(proof('idle', at + 90_000), armed, at + 91_000)).toBe('superseded');
    // The failed turn's own last event has not been replaced yet.
    expect(quotaContinueFence(proof('active', at - 2000), armed, at + 5000)).toBe('busy');
    // An `active` nothing confirmed for ten minutes no longer says a turn runs.
    expect(quotaContinueFence(proof('active', at - 2000), armed, at + 11 * 60_000)).toBe('clear');
    expect(quotaContinueFence(proof('idle', at - 2000), armed, at + 5000)).toBe('clear');
  });
  it('names the account in the delivered text', () => {
    expect(quotaSwitchContinuation(QUOTA_SWITCH_CONTINUATION, { id: 2, label: 'beta@example.test' }))
      .toMatch(/^The previous turn failed on a provider quota limit and now continues on account beta@example\.test \(#2\)\. Continue where you left off; check quota_get before heavy work; do not invent new work\./);
    expect(quotaSwitchContinuation(QUOTA_SWITCH_CONTINUATION, { id: null, label: null })).toContain('continues on another account of the pool.');
  });
});

describe('a provider usage limit marks the account exhausted', () => {
  it('scores the account 100 despite a lagging reading and moves its scope at once', async () => {
    const f = pool(), a = await idleOnA(f);
    const switches = new AccountSwitchService(f.db, f.keyring);
    expect((await switches.pool('claude')).find((x) => x.id === A)).toMatchObject({ score: 93, exhausted_until: null });
    await new WatchdogsService(f.db, f.keyring).activity(a.id, f.token, quotaFailure(f));
    // 93 % was the last successful response; the refusal is newer than that.
    const set = marker(f)!;
    expect(set).toMatchObject({ window: 'short', source: 'window_reset', host_id: HOST, session_id: a.id });
    expect(Date.parse(set.until)).toBeGreaterThan(Date.now() + HOUR);
    const listed = await switches.pool('claude');
    expect(listed.find((x) => x.id === A)).toMatchObject({ score: 100, short_used_percent: 93, exhausted_until: set.until });
    expect(listed.find((x) => x.id === B)!.score).toBe(30);
    // The dwell does not hold a scope on a full account: the switch is pending.
    expect(lease(f)).toMatchObject({ accountId: A, desiredAccountId: B, desiredReason: 'policy' });
    expect(f.fake.inserts.some((x) => (x.values as Record<string, unknown>).action === 'provider_account.quota_exhausted')).toBe(true);
  });

  it('uses the reset the provider printed', async () => {
    const f = pool(), a = await idleOnA(f), reset = new Date(Math.floor(Date.now() / 1000) * 1000 + 90 * 60_000).toISOString();
    await new WatchdogsService(f.db, f.keyring).activity(a.id, f.token, quotaFailure(f, { retry_not_before: reset }));
    expect(marker(f)).toMatchObject({ until: reset, source: 'provider_reset' });
  });

  it('sends a new launch to another account while the marker holds', async () => {
    const f = pool({ a: { short: 10, weekly: 5 } }), a = await idleOnA(f);
    const accounts = new ProviderAccountsService(f.db, f.keyring);
    await new WatchdogsService(f.db, f.keyring).activity(a.id, f.token, quotaFailure(f));
    // By its readings A (10 %) would win against B (30 %).
    expect((await accounts.acquire(HOST, 'claude', 'scope-2', 'lease-new', 95)).account.id).toBe(B);
  });

  it('keeps the stronger statement when a second session fails on the same account', async () => {
    const f = pool(), a = await idleOnA(f), reset = new Date(Math.floor(Date.now() / 1000) * 1000 + 90 * 60_000).toISOString();
    const first = await recordQuotaExhaustion(f.db, { engine: 'claude', accountId: A, hostId: HOST, sessionId: a.id, retryNotBefore: reset });
    const second = await recordQuotaExhaustion(f.db, { engine: 'claude', accountId: A, hostId: HOST, sessionId: 'other' });
    expect(second).toEqual(first);
    expect(marker(f)!.session_id).toBe(a.id);
  });

  it('concludes nothing for an account the host does not run on, an unlimited one or another engine', async () => {
    const f = pool();
    expect(await recordQuotaExhaustion(f.db, { engine: 'claude', accountId: B, hostId: HOST, sessionId: 's' })).toBeNull();
    expect(await recordQuotaExhaustion(f.db, { engine: 'claude', accountId: A, hostId: HOST + 1, sessionId: 's' })).toBeNull();
    const unlimited = pool({ quotaPolicy: { unlimited: true } });
    expect(await recordQuotaExhaustion(unlimited.db, { engine: 'claude', accountId: A, hostId: HOST, sessionId: 's' })).toBeNull();
    for (const engine of ['codex', 'grok', 'kimi'] as const) {
      const other = pool({ engine });
      expect(await recordQuotaExhaustion(other.db, { engine, accountId: A, hostId: HOST, sessionId: 's' })).toBeNull();
      expect(other.state.snapshot().setting(quotaExhaustedKey(A))).toBeFalsy();
    }
  });

  it('is ended by a reading of a new window, never by the same or a lower figure of the old one', async () => {
    const f = pool(), a = await idleOnA(f);
    const set = (await recordQuotaExhaustion(f.db, { engine: 'claude', accountId: A, hostId: HOST, sessionId: a.id }))!;
    // A session that has not asked the provider since repeats its old reading.
    expect(await reconcileQuotaExhaustion(f.db, 'claude', A, { short_resets_at: set.short_resets_at, long_resets_at: set.long_resets_at })).toBe(false);
    // The weekly window is not the one that ran out.
    expect(await reconcileQuotaExhaustion(f.db, 'claude', A, { short_resets_at: set.short_resets_at, long_resets_at: at(200 * HOUR) })).toBe(false);
    expect(marker(f)).not.toBeNull();
    expect(await reconcileQuotaExhaustion(f.db, 'claude', A, { short_resets_at: at(7 * HOUR), long_resets_at: set.long_resets_at })).toBe(true);
    expect(f.state.snapshot().setting(quotaExhaustedKey(A))).toBeFalsy();
    expect(f.fake.inserts.some((x) => (x.values as Record<string, unknown>).action === 'provider_account.quota_exhaustion_cleared')).toBe(true);
  });
});

describe('a quota-failed Claude turn continues on the next pool account', () => {
  it('arms one continuation that neither terminates nor times the idle session', async () => {
    const f = pool(), a = await idleOnA(f), dogs = new WatchdogsService(f.db, f.keyring);
    const view = await dogs.activity(a.id, f.token, quotaFailure(f));
    const dog = continuation(f)!;
    expect(watchdogs(f)).toHaveLength(1);
    expect(dog).toMatchObject({ status: 'capacity_wait', lastError: 'quota_switch', quotaAccountId: A, quotaWindow: 'short', createdBy: `quota:${a.id}`, sessionId: a.id });
    expect(dog.taskKey.startsWith(`quota-switch:${a.native}:`)).toBe(true);
    const due = Date.parse(f.state.snapshot().table('agentSchedules').get(dog.scheduleId)!.nextDueAt!);
    expect(due - Date.now()).toBeGreaterThan(5_000);
    expect(due - Date.now()).toBeLessThan(15_000);
    // The same failure retained and sent again at exit as a bare capacity
    // failure would terminate under any other watchdog.
    expect(view).toMatchObject({ terminate_requested: false, progress_timeout_seconds: null });
    await dogs.activity(a.id, f.token, { last_progress_at: f.now, failure: 'capacity' });
    expect(watchdogPolicy(f.state.snapshot(), f.state.snapshot().sessions.get(a.id)!)).toMatchObject({ terminate_requested: false, progress_timeout_seconds: null });
    expect(watchdogs(f)).toHaveLength(1);
    expect(await quotaContinuationPending(f.db, [a.addressId, f.agents[1]!.addressId])).toEqual(new Set([a.addressId]));
    // The stored prompt has no watchdog preamble: nothing is left for the agent to finish.
    const stored = f.fake.inserts.find((x) => (x.values as Record<string, unknown>).id === dog.scheduleId)!.values as Record<string, unknown>;
    expect(decrypt(String(stored.promptEnc), f.keyring)).toBe(QUOTA_SWITCH_CONTINUATION);
  });

  it('waits for the live switch and then delivers one continuation naming the new account', async () => {
    const f = pool(), a = await idleOnA(f), dogs = new WatchdogsService(f.db, f.keyring);
    await dogs.activity(a.id, f.token, quotaFailure(f));
    const dog = continuation(f)!;
    await tickOwnedSchedules(f.db, f.keyring, soon());
    // Another account has room, but the scope has not switched yet.
    const run = () => f.state.snapshot().table('agentScheduleRuns').by('scheduleId', dog.scheduleId)[0]!;
    expect(run()).toMatchObject({ status: 'capacity_wait', lastError: 'quota_switch_wait', messageId: null });
    expect(scheduleMessages(f)).toHaveLength(0);
    await tickOwnedWatchdogs(f.db, soon());
    expect(continuation(f)!.status).toBe('capacity_wait');
    // The wrapper commits the switch at the turn boundary: the session runs on B.
    await patch(f, 'agentSessions', a.id, { providerAccountId: B });
    await tickOwnedSchedules(f.db, f.keyring, new Date(Date.now() + 30_000));
    expect(run().status).toBe('queued');
    const [message] = scheduleMessages(f);
    expect(scheduleMessages(f)).toHaveLength(1);
    expect(message).toMatchObject({ targetAddressId: a.addressId, status: 'queued' });
    const body = decrypt(String((f.fake.inserts.find((x) => (x.values as Record<string, unknown>).id === message!.id)!.values as Record<string, unknown>).contentEnc), f.keyring);
    expect(body).toMatch(/^The previous turn failed on a provider quota limit and now continues on account beta@example\.test \(#2\)\./);
    expect(continuation(f)).toMatchObject({ quotaAttempts: 1 });
    // Further ticks never queue a second one.
    await tickOwnedSchedules(f.db, f.keyring, new Date(Date.now() + 60_000));
    expect(scheduleMessages(f)).toHaveLength(1);
  });

  it('reaches the running session without a resident daemon, and waits while it has no receiver', async () => {
    const f = pool({ noDaemon: true }), a = await idleOnA(f), dogs = new WatchdogsService(f.db, f.keyring);
    await dogs.activity(a.id, f.token, quotaFailure(f));
    await patch(f, 'agentSessions', a.id, { providerAccountId: B });
    await tickOwnedSchedules(f.db, f.keyring, soon());
    expect(scheduleMessages(f)).toHaveLength(1);

    const g = pool({ noDaemon: true }), b = await idleOnA(g);
    await new WatchdogsService(g.db, g.keyring).activity(b.id, g.token, quotaFailure(g));
    await patch(g, 'agentSessions', b.id, { providerAccountId: B, receiver: null });
    await tickOwnedSchedules(g.db, g.keyring, soon());
    expect(scheduleMessages(g)).toHaveLength(0);
    expect(continuation(g)!.status).toBe('capacity_wait');
    expect(g.state.snapshot().table('agentScheduleRuns').all().some((r) => r.status === 'blocked')).toBe(false);
  });

  it('drops the continuation when a new turn began after the failure', async () => {
    const f = pool(), a = await idleOnA(f), dogs = new WatchdogsService(f.db, f.keyring);
    await dogs.activity(a.id, f.token, quotaFailure(f));
    const session = f.state.snapshot().sessions.get(a.id)!;
    // The user typed: the session worked and went idle again.
    await patch(f, 'agentSessions', a.id, { providerAccountId: B, activity: { ...(session.activity as object), sequence: 9, changed_at: at(60_000) } });
    await tickOwnedSchedules(f.db, f.keyring, new Date(Date.now() + 90_000));
    expect(scheduleMessages(f)).toHaveLength(0);
    expect(continuation(f)).toMatchObject({ status: 'disabled', lastError: 'quota_continue_superseded' });
  });

  it('defers while a turn is running and gives way to a watchdog the agent arms itself', async () => {
    const f = pool(), a = await idleOnA(f), dogs = new WatchdogsService(f.db, f.keyring);
    await dogs.activity(a.id, f.token, quotaFailure(f));
    const session = f.state.snapshot().sessions.get(a.id)!;
    await patch(f, 'agentSessions', a.id, { providerAccountId: B, activity: { ...(session.activity as object), state: 'working' } });
    await tickOwnedSchedules(f.db, f.keyring, soon());
    expect(scheduleMessages(f)).toHaveLength(0);
    expect(continuation(f)!.status).toBe('capacity_wait');
    const own = await dogs.enable({ target: `agent:${a.addressId}`, task_key: 'my-task', continuation: 'Continue my task.', duration_seconds: 3600, progress_timeout_seconds: 600 }, `agent:${a.addressId}`, a.id);
    expect(own.status).toBe('watching');
    // The stopped row leaves working memory once a newer watchdog exists; its stop is persisted.
    expect(watchdogs(f).map((w) => w.taskKey)).toEqual(['my-task']);
    expect(f.fake.updates.some((x) => x.set.status === 'disabled' && x.set.lastError === 'quota_continue_superseded')).toBe(true);
    await tickOwnedSchedules(f.db, f.keyring, new Date(Date.now() + 60_000));
    expect(scheduleMessages(f)).toHaveLength(0);
  });

  it('does not continue elsewhere under the manual account policy', async () => {
    const f = pool({ mode: 'manual' }), a = await idleOnA(f);
    await new WatchdogsService(f.db, f.keyring).activity(a.id, f.token, quotaFailure(f));
    // The refusal is still recorded; nothing moves and nothing continues elsewhere.
    expect(marker(f)).not.toBeNull();
    expect(continuation(f)).toBeUndefined();
    expect(lease(f).desiredAccountId).toBeNull();
    expect(await poolContinuePossible(f.db, 'claude', A)).toBe(false);
    // What is left is the quota policy's reset recovery on the account itself:
    // it waits for A's reset, though B has room.
    const [dog] = watchdogs(f);
    expect(watchdogs(f)).toHaveLength(1);
    expect(dog).toMatchObject({ taskKey: `quota:${a.native}`, status: 'capacity_wait', lastError: 'capacity', quotaAccountId: A });
    const due = Date.parse(f.state.snapshot().table('agentSchedules').get(dog!.scheduleId)!.nextDueAt!);
    expect(due).toBe(Date.parse(marker(f)!.until) + 60_000);
    // A session of a peer delivery gets neither.
    const g = pool({ mode: 'manual' }), b = await idleOnA(g, { invocationKind: 'peer_delivery' });
    await new WatchdogsService(g.db, g.keyring).activity(b.id, g.token, quotaFailure(g));
    expect(watchdogs(g)).toHaveLength(0);
  });

  it('never continues a peer delivery session or one without a receiver', async () => {
    const f = pool(), a = await idleOnA(f, { invocationKind: 'peer_delivery' });
    await new WatchdogsService(f.db, f.keyring).activity(a.id, f.token, quotaFailure(f));
    expect(marker(f)).not.toBeNull();
    expect(watchdogs(f)).toHaveLength(0);
    const g = pool(), b = await idleOnA(g, {}, false);
    await new WatchdogsService(g.db, g.keyring).activity(b.id, g.token, quotaFailure(g));
    expect(continuation(g)).toBeUndefined();
  });

  it('does not continue elsewhere when no other account has room, or for a transient capacity failure', async () => {
    const full = pool({ b: { short: 100, weekly: 30 } }), a = await idleOnA(full);
    await new WatchdogsService(full.db, full.keyring).activity(a.id, full.token, quotaFailure(full));
    expect(marker(full)).not.toBeNull();
    expect(continuation(full)).toBeUndefined();
    const f = pool(), b = await idleOnA(f);
    await new WatchdogsService(f.db, f.keyring).activity(b.id, f.token, { last_progress_at: f.now, failure: 'capacity' });
    expect(marker(f)).toBeNull();
    expect(watchdogs(f)).toHaveLength(0);
  });

  it('leaves the other engines as they were', async () => {
    for (const engine of ['codex', 'grok', 'kimi']) {
      const f = pool({ engine }), a = await idleOnA(f);
      await new WatchdogsService(f.db, f.keyring).activity(a.id, f.token, quotaFailure(f));
      expect(f.state.snapshot().setting(quotaExhaustedKey(A))).toBeFalsy();
      expect(watchdogs(f)).toHaveLength(0);
      expect(lease(f).desiredAccountId).toBeNull();
    }
  });
});

describe('a recovery that cannot continue at once follows the pool', () => {
  const due = (f: Fixture, dog: { scheduleId: string }) => Date.parse(f.state.snapshot().table('agentSchedules').get(dog.scheduleId)!.nextDueAt!) - Date.now();
  const run = (f: Fixture, dog: { scheduleId: string }) => f.state.snapshot().table('agentScheduleRuns').by('scheduleId', dog.scheduleId)[0]!;
  const shortReset = (f: Fixture, id: number) => f.state.snapshot().table('claudeUsageSnapshots').get(id)!.fiveHourResetsAt!;
  const full = { short: 100, shortReset: at(HOUR), weekly: 30 };

  it('waits for the earliest reset of a full pool, not for the account the turn failed on', async () => {
    const f = pool({ a: { short: 100, shortReset: at(4 * HOUR), weekly: 40 }, b: full }), a = await idleOnA(f);
    await new WatchdogsService(f.db, f.keyring).activity(a.id, f.token, quotaFailure(f));
    const [dog] = watchdogs(f);
    expect(watchdogs(f)).toHaveLength(1);
    // No account has room: the reset recovery of the quota policy, not a continuation elsewhere.
    expect(dog).toMatchObject({ taskKey: `quota:${a.native}`, status: 'capacity_wait', lastError: 'capacity', quotaAccountId: A, quotaWindow: 'short' });
    // It looks after the usual five minutes instead of sleeping until A's reset in four hours.
    expect(due(f, dog!)).toBeLessThan(7 * 60_000);
    await tickOwnedSchedules(f.db, f.keyring, new Date(Date.now() + 7 * 60_000));
    expect(run(f, dog!)).toMatchObject({ status: 'capacity_wait', lastError: 'quota_wait', messageId: null,
      nextAttemptAt: new Date(Date.parse(shortReset(f, 2)) + 60_000).toISOString() });
  });

  it('arms that recovery on the refusal alone when the reading of the account lags', async () => {
    const f = pool({ a: { short: 93, shortReset: at(4 * HOUR), weekly: 40 }, b: full }), a = await idleOnA(f);
    await new WatchdogsService(f.db, f.keyring).activity(a.id, f.token, quotaFailure(f));
    const [dog] = watchdogs(f);
    expect(dog).toMatchObject({ taskKey: `quota:${a.native}`, status: 'capacity_wait', quotaAccountId: A, quotaWindow: 'short', quotaResetAt: marker(f)!.until });
    expect(due(f, dog!)).toBeLessThan(7 * 60_000);
    await tickOwnedSchedules(f.db, f.keyring, new Date(Date.now() + 7 * 60_000));
    expect(run(f, dog!)).toMatchObject({ status: 'capacity_wait', lastError: 'quota_wait',
      nextAttemptAt: new Date(Date.parse(shortReset(f, 2)) + 60_000).toISOString() });
  });

  it('arms nothing on a lagging reading without the refusal, or where the quota policy switches that window off', async () => {
    const lagging = { a: { short: 93, shortReset: at(4 * HOUR), weekly: 40 }, b: full };
    const f = pool(lagging), a = await idleOnA(f);
    // A wrapper before 0.9.213 reports the failure without `quota_limit`.
    await new WatchdogsService(f.db, f.keyring).activity(a.id, f.token, { last_progress_at: f.now, failure: 'capacity' });
    expect(watchdogs(f)).toHaveLength(0);
    const off = pool({ ...lagging, quotaPolicy: { short_auto_resume: false } }), b = await idleOnA(off);
    await new WatchdogsService(off.db, off.keyring).activity(b.id, off.token, quotaFailure(off));
    expect(marker(off)).not.toBeNull();
    expect(watchdogs(off)).toHaveLength(0);
    // A reset recovery terminates the session and only a resident daemon
    // resumes it: without one the refusal alone leaves the session alone.
    const away = pool({ ...lagging, noDaemon: true }), c = await idleOnA(away);
    await new WatchdogsService(away.db, away.keyring).activity(c.id, away.token, quotaFailure(away));
    expect(marker(away)).not.toBeNull();
    expect(watchdogs(away)).toHaveLength(0);
  });

  it("does not park an agent's own watchdog on the reset of the failed account while the pool decides", async () => {
    const reset = new Date(Math.floor(Date.now() / 1000) * 1000 + 3 * HOUR).toISOString();
    const own = { task_key: 'my-task', continuation: 'Continue my task.', duration_seconds: 3600, progress_timeout_seconds: 600 };
    const f = pool(), a = await idleOnA(f), dogs = new WatchdogsService(f.db, f.keyring);
    await dogs.enable({ target: `agent:${a.addressId}`, ...own }, `agent:${a.addressId}`, a.id);
    await dogs.activity(a.id, f.token, quotaFailure(f, { retry_not_before: reset }));
    expect(watchdogs(f)).toHaveLength(1);
    expect(watchdogs(f)[0]).toMatchObject({ taskKey: 'my-task', status: 'capacity_wait' });
    // The provider's reset is about account A; the relaunch gets another account.
    expect(due(f, watchdogs(f)[0]!)).toBeLessThan(7 * 60_000);
    // Without a pool to decide (manual distribution) the hint holds, as before.
    const manual = pool({ mode: 'manual' }), b = await idleOnA(manual), manualDogs = new WatchdogsService(manual.db, manual.keyring);
    await manualDogs.enable({ target: `agent:${b.addressId}`, ...own }, `agent:${b.addressId}`, b.id);
    await manualDogs.activity(b.id, manual.token, quotaFailure(manual, { retry_not_before: reset }));
    expect(due(manual, watchdogs(manual)[0]!)).toBeGreaterThan(2.9 * HOUR);
  });

  it('applies only to an engine with live switching, the automatic policy and a second usable account', async () => {
    expect(await poolRecoveryApplies(pool().db, 'claude', A)).toBe(true);
    expect(await poolRecoveryApplies(pool({ mode: 'manual' }).db, 'claude', A)).toBe(false);
    const single = pool({ b: null });
    await patch(single, 'providerAccounts', B, { state: 'paused' });
    expect(await poolRecoveryApplies(single.db, 'claude', A)).toBe(false);
    for (const engine of ['codex', 'grok', 'kimi'] as const) expect(await poolRecoveryApplies(pool({ engine }).db, engine, A)).toBe(false);
  });
});

describe('the quota gate follows the pool, not the account the turn failed on', () => {
  const quota = (f: Fixture, patch: Record<string, unknown> = {}) => ({ account_id: A, window: 'short', reset_at: at(2 * HOUR), attempts: 0, attempt_at: null, native_session_id: f.agents[0]!.native, ...patch });
  const target = (f: Fixture) => f.state.snapshot().addresses.get(f.agents[0]!.addressId)!;
  const on = (accountId: number | null, endedAt: string | null = null) => ({ providerAccountId: accountId, endedAt });
  const mark = (f: Fixture, accountId = A) => recordQuotaExhaustion(f.db, { engine: 'claude', accountId, hostId: HOST, sessionId: f.agents[0]!.id });

  it('is ready as soon as the session runs on a usable account with room', async () => {
    const f = pool();
    await mark(f);
    expect(await quotaRecoveryGate(f.db, { engine: 'claude', quota: quota(f), target: target(f), session: on(B), now: Date.now() }))
      .toEqual({ ready: true, account_id: B, account_label: 'beta@example.test' });
    // A paused account is no place to continue on.
    await patch(f, 'providerAccounts', B, { state: 'paused' });
    expect(await quotaRecoveryGate(f.db, { engine: 'claude', quota: quota(f), target: target(f), session: on(B), now: Date.now() }))
      .toMatchObject({ wait_until: expect.any(String), reason: 'quota_wait' });
  });

  it('looks again shortly while the switch is pending, then falls back to the failed account', async () => {
    const f = pool();
    const set = (await mark(f))!;
    const now = Date.now();
    const pending = await quotaRecoveryGate(f.db, { engine: 'claude', quota: quota(f), target: target(f), session: on(A), now });
    expect(pending).toMatchObject({ reason: 'quota_switch_wait' });
    expect(Date.parse((pending as { wait_until: string }).wait_until) - now).toBe(15_000);
    // The scope never moved: the reset of its own account decides, as before.
    // The gate still looks every five minutes, so a late switch is not slept through.
    const late = now + QUOTA_SWITCH_WAIT_MS + 1000, reset = new Date(Date.parse(set.until) + 60_000).toISOString();
    const waiting = { engine: 'claude' as const, quota: quota(f, { reset_at: set.until }), target: target(f), switchSince: at(-QUOTA_SWITCH_WAIT_MS - 1000) };
    expect(await quotaRecoveryGate(f.db, { ...waiting, session: on(A), now: late }))
      .toEqual({ wait_until: new Date(late + 5 * 60_000).toISOString(), reason: 'quota_wait', reset_at: reset });
    expect(await quotaRecoveryGate(f.db, { ...waiting, session: on(B), now: late })).toMatchObject({ ready: true, account_id: B });
    // Close to the reset the wait is the reset itself.
    const close = Date.parse(set.until) - 60_000;
    expect(await quotaRecoveryGate(f.db, { ...waiting, session: on(A), now: close })).toEqual({ wait_until: reset, reason: 'quota_wait' });
  });

  it('is ready for a session that is gone when a new launch would get an account with room', async () => {
    const f = pool();
    await mark(f);
    expect(await quotaRecoveryGate(f.db, { engine: 'claude', quota: quota(f), target: target(f), session: on(A, at(-1000)), now: Date.now() }))
      .toEqual({ ready: true, account_id: null, account_label: null });
    expect(await quotaRecoveryGate(f.db, { engine: 'claude', quota: quota(f), target: target(f), session: null, now: Date.now() })).toMatchObject({ ready: true });
  });

  it('waits for the earliest reset in the pool when no account has room', async () => {
    const f = pool({ a: { short: 100, shortReset: at(4 * HOUR), weekly: 40 }, b: { short: 100, shortReset: at(HOUR), weekly: 30 } });
    const bReset = f.state.snapshot().table('claudeUsageSnapshots').get(2)!.fiveHourResetsAt!;
    expect(await quotaRecoveryGate(f.db, { engine: 'claude', quota: quota(f, { reset_at: at(4 * HOUR) }), target: target(f), session: on(A), now: Date.now() }))
      .toEqual({ wait_until: new Date(Date.parse(bReset) + 60_000).toISOString(), reason: 'quota_wait' });
  });

  it('waits only where the quota policy lets a recovery wait for that window', async () => {
    // B is out for the week (long_auto_resume is off by default); A's short window comes back in four hours.
    const f = pool({ a: { short: 100, shortReset: at(4 * HOUR), weekly: 40 }, b: { short: 10, weekly: 100, weeklyReset: at(HOUR) } });
    const aReset = f.state.snapshot().table('claudeUsageSnapshots').get(1)!.fiveHourResetsAt!;
    expect(await quotaRecoveryGate(f.db, { engine: 'claude', quota: quota(f), target: target(f), session: on(A), now: Date.now() }))
      .toEqual({ wait_until: new Date(Date.parse(aReset) + 60_000).toISOString(), reason: 'quota_wait' });
    const none = pool({ quotaPolicy: { short_auto_resume: false }, a: { short: 100, weekly: 40 }, b: { short: 100, weekly: 30 } });
    expect(await quotaRecoveryGate(none.db, { engine: 'claude', quota: quota(none), target: target(none), session: on(A), now: Date.now() }))
      .toEqual({ stop: 'quota_auto_resume_disabled' });
  });

  it('keeps the native-session fence and the attempt budget', async () => {
    const f = pool();
    await mark(f);
    expect(await quotaRecoveryGate(f.db, { engine: 'claude', quota: quota(f, { native_session_id: randomUUID() }), target: target(f), session: on(B), now: Date.now() }))
      .toEqual({ stop: 'quota_native_session_changed' });
    expect(await quotaRecoveryGate(f.db, { engine: 'claude', quota: quota(f), target: undefined, session: on(B), now: Date.now() }))
      .toEqual({ stop: 'quota_native_session_changed' });
    expect(await quotaRecoveryGate(f.db, { engine: 'claude', quota: quota(f, { attempts: 4 }), target: target(f), session: on(B), now: Date.now() }))
      .toEqual({ stop: 'quota_resume_attempts_exhausted' });
    const last = at(-60_000);
    expect(await quotaRecoveryGate(f.db, { engine: 'claude', quota: quota(f, { attempts: 1, attempt_at: last }), target: target(f), session: on(B), now: Date.now() }))
      .toEqual({ wait_until: new Date(Date.parse(last) + 300_000).toISOString(), reason: 'quota_wait' });
  });

  it('is the gate of the single account under the manual policy, for one account and for other engines', async () => {
    const same = async (f: Fixture, engine: 'claude' | 'codex' | 'grok' | 'kimi') => {
      const now = Date.now(), q = quota(f);
      const expected = quotaResumeGate(await quotaSnapshot(f.db, A, engine, now), q.window, q.reset_at, q.attempts, q.attempt_at, now);
      const gate = await quotaRecoveryGate(f.db, { engine, quota: q, target: target(f), session: on(B), now });
      expect(gate).toMatchObject(expected);
      return gate;
    };
    // Bound to B with room, yet the account it failed on decides: wait for A's reset.
    expect(await same(pool({ mode: 'manual' }), 'claude')).toMatchObject({ wait_until: expect.any(String) });
    const single = pool({ b: null });
    await patch(single, 'providerAccounts', B, { state: 'paused' });
    await same(single, 'claude');
    for (const engine of ['codex', 'grok', 'kimi'] as const) await same(pool({ engine }), engine);
  });
});
