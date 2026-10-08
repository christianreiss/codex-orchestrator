import { randomUUID, randomBytes } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
import { beforeAll, afterAll, afterEach, describe, expect, it } from 'vitest';
import {
  agentTaskResults,
  agentFreshStartGrants,
  agentBusAddresses,
  agentBusRelays,
  agentBusConversations,
  agentBusMessages,
  agentWatchdogs,
  agentPrompts,
  agentSchedules,
  agentScheduleRuns,
  agentSessions,
  hosts,
  versions,
} from '../../../src/db/schema.js';
import { AgentMessagingService } from '../../../src/services/agent-messaging.js';
import { WatchdogsService } from '../../../src/services/watchdogs.js';
import { SchedulesService } from '../../../src/services/schedules.js';
import { invalidateFleetEngineState } from '../../../src/services/engine-switch.js';
import { decrypt } from '../../../src/security/secret-box.js';
import { getTestDb, type TestDb } from '../../helpers/test-db.js';
import { loadTestEnv, testKeyring } from '../../helpers/test-keyring.js';
import type { Engine } from '../../../src/util/engine.js';
const handle = await getTestDb();
describe.skipIf(!handle)('bounded task watchdogs on MySQL', { timeout: 120000 }, () => {
  const db = handle?.db as TestDb,
    keyring = testKeyring();
  let watchdogs: WatchdogsService;
  let service: SchedulesService, bus: AgentMessagingService, host: typeof hosts.$inferSelect;
  const addressIds: string[] = [],
    sessionIds: string[] = [],
    scheduleIds: string[] = [];
  const flags = [
    'api_disabled',
    'agent_messaging_enabled',
    'codex_engine_disabled',
    'claude_engine_disabled',
    'grok_engine_disabled',
  ];
  let savedFlags: (typeof versions.$inferSelect)[];
  beforeAll(async () => {
    savedFlags = await db.select().from(versions).where(inArray(versions.name, flags));
    for (const name of flags)
      await db
        .insert(versions)
        .values({
          name,
          version: name === 'agent_messaging_enabled' ? '1' : '0',
          updatedAt: new Date().toISOString(),
        })
        .onDuplicateKeyUpdate({ set: { version: name === 'agent_messaging_enabled' ? '1' : '0' } });
    invalidateFleetEngineState(db);
    await db.insert(hosts).values({
      fqdn: 'ztest-watchdogs.example',
      apiKey: 'e'.repeat(64),
      status: 'active',
      secure: 1,
      engines: 'codex,claude,grok',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    host = (await db.select().from(hosts).where(eq(hosts.fqdn, 'ztest-watchdogs.example')))[0]!;
    bus = new AgentMessagingService(db, loadTestEnv(), keyring);
    service = new SchedulesService(db, keyring);
    watchdogs = new WatchdogsService(db, keyring);
  });
  afterEach(async () => {
    if (scheduleIds.length) {
      await db.delete(agentWatchdogs).where(inArray(agentWatchdogs.scheduleId, scheduleIds));
      await db.delete(agentScheduleRuns).where(inArray(agentScheduleRuns.scheduleId, scheduleIds));
      await db.delete(agentSchedules).where(inArray(agentSchedules.id, scheduleIds));
    }
    if (addressIds.length) {
      await db.delete(agentTaskResults).where(
        inArray(
          agentTaskResults.messageId,
          (
            await db
              .select({ id: agentBusMessages.id })
              .from(agentBusMessages)
              .where(inArray(agentBusMessages.targetAddressId, addressIds))
          ).map((r) => r.id),
        ),
      );
      await db
        .delete(agentFreshStartGrants)
        .where(inArray(agentFreshStartGrants.targetAddressId, addressIds));
      await db.delete(agentBusMessages).where(inArray(agentBusMessages.targetAddressId, addressIds));
      await db.delete(agentBusConversations).where(inArray(agentBusConversations.addressBId, addressIds));
      await db.delete(agentBusAddresses).where(inArray(agentBusAddresses.id, addressIds));
    }
    if (host) await db.delete(agentBusRelays).where(eq(agentBusRelays.hostId, host.id));
    if (sessionIds.length) await db.delete(agentPrompts).where(inArray(agentPrompts.sessionId, sessionIds));
    if (sessionIds.length) await db.delete(agentSessions).where(inArray(agentSessions.id, sessionIds));
    scheduleIds.length = addressIds.length = sessionIds.length = 0;
    for (const name of flags)
      await db
        .update(versions)
        .set({ version: name === 'agent_messaging_enabled' ? '1' : '0' })
        .where(eq(versions.name, name));
    invalidateFleetEngineState(db);
  });
  afterAll(async () => {
    if (host) await db.delete(hosts).where(eq(hosts.id, host.id));
    await db.delete(versions).where(inArray(versions.name, flags));
    for (const row of savedFlags) await db.insert(versions).values(row);
    invalidateFleetEngineState(db);
    await handle!.pool.end();
  });
  async function agent(engine: Engine) {
    const id = randomUUID(),
      token = randomBytes(32).toString('base64url');
    sessionIds.push(id);
    const result = await bus.registerSession(host, {
      engine,
      username: 'ztest-watchdogs',
      cwd: '/tmp/ztest-watchdogs',
      sessionId: id,
      bridgeToken: token,
      invocationKind: 'interactive',
      upstreamSessionId: randomUUID(),
      continuity: 'native',
      adapterProtocol: 'cxx-agent-listen-v1',
      adapterCapabilities: { execution_contract_version: 2, watchdog_protocol_version: 1 },
    });
    const address = result.address as { id: string; address: string };
    addressIds.push(address.id);
    return { id, token, address };
  }
  async function runs(id: string) {
    return db.select().from(agentScheduleRuns).where(eq(agentScheduleRuns.scheduleId, id));
  }

  async function enable(a: Awaited<ReturnType<typeof agent>>, extra: Record<string, unknown> = {}) {
    const w = await watchdogs.enable(
      {
        target: a.address.address,
        task_key: 'current-task',
        continuation: 'Finish current authorized task and check the result.',
        ...extra,
      },
      'test',
      a.id,
    );
    const [row] = await db.select().from(agentWatchdogs).where(eq(agentWatchdogs.id, w.id));
    if (!scheduleIds.includes(row!.scheduleId)) scheduleIds.push(row!.scheduleId);
    return w;
  }
  it.each(['codex', 'claude', 'grok'] as const)(
    'arms %s without waking a healthy agent; retries never extend the deadline',
    async (engine) => {
      const a = await agent(engine),
        w = await enable(a),
        repeat = await enable(a);
      expect(w.progress_timeout_seconds).toBe(600);
      expect(Date.parse(w.deadline_at) - Date.now()).toBeGreaterThan(7190000);
      expect(repeat.id).toBe(w.id);
      expect(repeat.deadline_at).toBe(w.deadline_at);
      await watchdogs.tick();
      await service.tick();
      expect(await runs(scheduleIds[0]!)).toHaveLength(0);
      expect((await service.list()).schedules).toHaveLength(0);
      expect((await watchdogs.snapshot(a.id, a.token)).progress_timeout_seconds).toBe(600);
      expect((await service.sessionPolicy(a.id, a.token)).progress_timeout_seconds).toBeNull();
      await expect(enable(a, { task_key: 'other' })).rejects.toMatchObject({
        code: 'watchdog_already_active',
      });
    },
  );
  it('encrypts continuation, scopes activation and fences versions', async () => {
    const a = await agent('codex');
    await expect(
      watchdogs.enable(
        { target: a.address.address, task_key: 'task', continuation: 'continue' },
        'test',
        randomUUID(),
      ),
    ).rejects.toMatchObject({ code: 'watchdog_own_task_only' });
    const w = await enable(a);
    const [s] = await db.select().from(agentSchedules).where(eq(agentSchedules.id, scheduleIds[0]!));
    expect(s!.promptEnc).not.toContain('authorized');
    expect(decrypt(s!.promptEnc, keyring)).toContain('watchdog_finish');
    await expect(service.update({ id: s!.id, version: 1, enabled: false }, 'test')).rejects.toMatchObject({
      code: 'watchdog_schedule_managed',
    });
    await expect(service.remove({ id: s!.id, version: 1 }, 'test')).rejects.toMatchObject({
      code: 'watchdog_schedule_managed',
    });
    await expect(watchdogs.finish({ id: w.id, version: 99 }, 'test', true)).rejects.toMatchObject({
      code: 'watchdog_version_conflict',
    });
    const done = await watchdogs.finish({ id: w.id, version: 1, status: 'succeeded' }, 'test', false, a.id);
    expect(done.status).toBe('completed');
    expect(
      (await watchdogs.finish({ id: w.id, version: 1, status: 'succeeded' }, 'test', false, a.id)).version,
    ).toBe(done.version);
    await expect(enable(a)).rejects.toMatchObject({ code: 'watchdog_version_conflict' });
  });
  it('honors provider reset and coalesces concurrent recovery ticks', async () => {
    const a = await agent('codex'),
      w = await enable(a),
      reset = new Date(Date.now() + 3600000).toISOString();
    await watchdogs.activity(a.id, a.token, {
      last_progress_at: new Date().toISOString(),
      failure: 'capacity',
      retry_not_before: reset,
    });
    expect((await watchdogs.get(w.id)).next_wake_at).toBe(reset);
    await service.tick(new Date(Date.parse(reset) - 1));
    expect(await runs(scheduleIds[0]!)).toHaveLength(0);
    await Promise.all([service.tick(new Date(reset)), service.tick(new Date(reset))]);
    const current = await runs(scheduleIds[0]!);
    expect(current).toHaveLength(1);
    expect(current[0]!.status).toBe('queued');
    await db
      .update(agentBusAddresses)
      .set({ lastUpstreamSessionId: randomUUID() })
      .where(eq(agentBusAddresses.id, a.address.id));
    await watchdogs.tick();
    expect((await watchdogs.get(w.id)).last_error).toBe('native_session_changed');
    expect(
      (await db.select().from(agentBusMessages).where(eq(agentBusMessages.id, current[0]!.messageId!)))[0]!
        .status,
    ).toBe('canceled');
  });
  it('backs off repeated capacity failures', async () => {
    const a = await agent('codex'),
      w = await enable(a);
    await watchdogs.activity(a.id, a.token, {
      last_progress_at: new Date().toISOString(),
      failure: 'capacity',
    });
    const at = (await watchdogs.get(w.id)).next_wake_at!;
    await service.tick(new Date(at));
    const [run] = await runs(scheduleIds[0]!);
    const lastWake = new Date(Date.now() - 60000).toISOString();
    await db
      .update(agentBusMessages)
      .set({ status: 'ambiguous', lastErrorCode: 'schedule_capacity', acceptedAt: lastWake })
      .where(eq(agentBusMessages.id, run!.messageId!));
    await service.tick(new Date(at));
    const backoff = await watchdogs.get(w.id);
    expect(backoff.recovery_status).toBe('capacity_wait');
    expect(Date.parse(backoff.next_wake_at!)).toBeGreaterThanOrEqual(Date.parse(at) + 300000);
    await service.tick(new Date(backoff.next_wake_at!));
    expect((await watchdogs.get(w.id)).recovery_count).toBe(2);
    expect((await watchdogs.get(w.id)).last_wake_at).toBe(lastWake);
  });
  it('protects questions; wrapper heartbeat is not progress', async () => {
    const a = await agent('codex'),
      w = await enable(a),
      now = new Date().toISOString();
    await db
      .insert(agentPrompts)
      .values({ id: randomUUID(), sessionId: a.id, questionEnc: 'test', createdAt: now });
    expect((await watchdogs.snapshot(a.id, a.token)).progress_timeout_seconds).toBeNull();
    await bus.heartbeatSession(a.id, a.token, {});
    expect((await watchdogs.get(w.id)).last_progress_at).toBe(w.last_progress_at);
  });
  it('deadline cancels pending recovery and preserves accepted work', async () => {
    const a = await agent('codex'),
      w = await enable(a, { duration_seconds: 60 });
    await watchdogs.activity(a.id, a.token, { last_progress_at: new Date().toISOString(), failure: 'crash' });
    await watchdogs.tick(new Date(Date.parse(w.deadline_at) + 1));
    expect((await watchdogs.get(w.id)).status).toBe('expired');
    await service.tick(new Date(Date.now() + 3600000));
    expect(await runs(scheduleIds[0]!)).toHaveLength(0);
  });
  it('STOP and permanent provider errors end recovery; rejects revoked bridges and stale hooks', async () => {
    const a = await agent('codex'),
      w = await enable(a);
    await expect(watchdogs.snapshot(a.id, 'wrong')).rejects.toMatchObject({
      code: 'watchdog_bridge_invalid',
    });
    expect(
      await watchdogs.activity(a.id, a.token, {
        last_progress_at: new Date().toISOString(),
        failure: 'user_stop',
        native_session_id: randomUUID(),
      }),
    ).toEqual({ ignored: true });
    await watchdogs.activity(a.id, a.token, {
      last_progress_at: new Date().toISOString(),
      failure: 'user_stop',
    });
    expect((await watchdogs.get(w.id)).status).toBe('disabled');
    const second = await enable(a, { task_key: 'second' });
    await watchdogs.activity(a.id, a.token, {
      last_progress_at: new Date().toISOString(),
      failure: 'blocked',
    });
    expect((await watchdogs.get(second.id)).status).toBe('blocked');
  });
  it('engine suspension blocks recovery', async () => {
    const a = await agent('codex'),
      w = await enable(a);
    await db.update(versions).set({ version: '1' }).where(eq(versions.name, 'codex_engine_disabled'));
    invalidateFleetEngineState(db);
    await watchdogs.tick();
    expect((await watchdogs.get(w.id)).last_error).toBe('target_unavailable');
  });
  it('requires compatible wrappers and fences superseded session bridges', async () => {
    const a = await agent('codex');
    await db
      .update(agentSessions)
      .set({ adapterCapabilities: { execution_contract_version: 2 } })
      .where(eq(agentSessions.id, a.id));
    await expect(enable(a)).rejects.toMatchObject({ code: 'adapter_upgrade_required' });
    await db
      .update(agentSessions)
      .set({ adapterCapabilities: { execution_contract_version: 2, watchdog_protocol_version: 1 } })
      .where(eq(agentSessions.id, a.id));
    await enable(a);
    await db
      .update(agentBusAddresses)
      .set({ currentSessionId: randomUUID() })
      .where(eq(agentBusAddresses.id, a.address.id));
    await expect(watchdogs.snapshot(a.id, a.token)).rejects.toMatchObject({ code: 'watchdog_binding_stale' });
  });
  it('replays versioned updates without extending deadlines or dropping finish instructions', async () => {
    const a = await agent('codex'),
      w = await enable(a);
    const patch = { version: w.version, continuation: 'Updated acceptance criteria' };
    const updated = await enable(a, patch),
      repeated = await enable(a, patch);
    expect(repeated.version).toBe(updated.version);
    expect(repeated.deadline_at).toBe(updated.deadline_at);
    const [schedule] = await db.select().from(agentSchedules).where(eq(agentSchedules.id, scheduleIds[0]!));
    expect(decrypt(schedule!.promptEnc, keyring)).toContain('watchdog_finish');
  });
  async function queued(a: Awaited<ReturnType<typeof agent>>) {
    const w = await enable(a);
    await watchdogs.activity(a.id, a.token, {
      last_progress_at: new Date().toISOString(),
      failure: 'capacity',
    });
    await service.tick(new Date((await watchdogs.get(w.id)).next_wake_at!));
    const [run] = await runs(scheduleIds[0]!);
    await db
      .update(agentBusMessages)
      .set({ nextAttemptAt: new Date().toISOString() })
      .where(eq(agentBusMessages.id, run!.messageId!));
    return { w, run: run! };
  }
  it('fences deadline between claim and durable acceptance', async () => {
    const a = await agent('codex'),
      { w, run } = await queued(a),
      claim = randomUUID();
    const delivery = await bus.claimForSession(a.id, a.token, claim);
    expect(delivery?.target.watchdog_native_session_id).toBe(w.native_session_id);
    await db
      .update(agentWatchdogs)
      .set({ deadlineAt: new Date(Date.now() - 1000).toISOString() })
      .where(eq(agentWatchdogs.id, w.id));
    await expect(
      bus.acknowledgeSessionDelivery(a.id, a.token, run.messageId!, { claimId: claim, outcome: 'accepted' }),
    ).rejects.toMatchObject({ code: 'watchdog_recovery_unavailable' });
    await watchdogs.tick();
    expect(
      (await db.select().from(agentBusMessages).where(eq(agentBusMessages.id, run.messageId!)))[0]!.status,
    ).toBe('canceled');
  });
  it('keeps accepted recovery work running at expiry and accepts its final receipt', async () => {
    const a = await agent('codex'),
      { w, run } = await queued(a),
      claim = randomUUID();
    await bus.claimForSession(a.id, a.token, claim);
    await bus.acknowledgeSessionDelivery(a.id, a.token, run.messageId!, {
      claimId: claim,
      outcome: 'accepted',
    });
    expect((await watchdogs.get(w.id)).last_wake_at).not.toBeNull();
    await watchdogs.tick(new Date(Date.parse(w.deadline_at) + 1));
    expect(
      (await db.select().from(agentBusMessages).where(eq(agentBusMessages.id, run.messageId!)))[0]!.status,
    ).toBe('accepted');
    await bus.acknowledgeSessionDelivery(a.id, a.token, run.messageId!, {
      claimId: claim,
      outcome: 'completed',
      taskResult: { status: 'succeeded', summary: 'finished after protection expiry' },
    });
    await service.tick();
    expect((await runs(scheduleIds[0]!))[0]!.status).toBe('completed');
  });
  it('stops capacity recovery when the user closes the original session', async () => {
    const a = await agent('codex'),
      w = await enable(a);
    await watchdogs.activity(a.id, a.token, {
      last_progress_at: new Date().toISOString(),
      failure: 'capacity',
    });
    await db
      .update(agentSessions)
      .set({ closeRequestedAt: new Date().toISOString() })
      .where(eq(agentSessions.id, a.id));
    await watchdogs.tick();
    expect((await watchdogs.get(w.id)).status).toBe('disabled');
  });

  it('ends protection when the original accepted task has an explicit outcome', async () => {
    const sender = await agent('claude'),
      a = await agent('codex');
    const sent = await bus.sendMessage(sender.id, sender.token, {
      to: a.address.address,
      content: 'authorized task',
      kind: 'request',
      clientMessageId: randomUUID(),
    });
    const id = String((sent.message as Record<string, unknown>).id),
      claim = randomUUID();
    await bus.claimForSession(a.id, a.token, claim);
    await bus.acknowledgeSessionDelivery(a.id, a.token, id, { claimId: claim, outcome: 'accepted' });
    const w = await enable(a);
    await bus.acknowledgeSessionDelivery(a.id, a.token, id, {
      claimId: claim,
      outcome: 'completed',
      taskResult: { status: 'succeeded', summary: 'verified' },
    });
    await watchdogs.tick();
    expect((await watchdogs.get(w.id)).status).toBe('completed');
  });
});
