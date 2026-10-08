import { randomUUID, randomBytes } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
import { beforeAll, afterAll, afterEach, describe, expect, it } from 'vitest';
import {
  agentBusAddresses,
  agentBusRelays,
  agentBusConversations,
  agentBusMessages,
  agentSchedules,
  agentScheduleRuns,
  agentSessions,
  hosts,
  versions,
} from '../../../src/db/schema.js';
import { AgentMessagingService } from '../../../src/services/agent-messaging.js';
import { SchedulesService } from '../../../src/services/schedules.js';
import { invalidateFleetEngineState } from '../../../src/services/engine-switch.js';
import { decrypt } from '../../../src/security/secret-box.js';
import { getTestDb, type TestDb } from '../../helpers/test-db.js';
import { loadTestEnv, testKeyring } from '../../helpers/test-keyring.js';
import type { Engine } from '../../../src/util/engine.js';
const handle = await getTestDb();
describe.skipIf(!handle)('durable Wake/Cron schedules on MySQL', { timeout: 120000 }, () => {
  const db = handle?.db as TestDb,
    keyring = testKeyring();
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
      fqdn: 'ztest-schedules.example',
      apiKey: 'e'.repeat(64),
      status: 'active',
      secure: 1,
      engines: 'codex,claude,grok',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    host = (await db.select().from(hosts).where(eq(hosts.fqdn, 'ztest-schedules.example')))[0]!;
    bus = new AgentMessagingService(db, loadTestEnv(), keyring);
    service = new SchedulesService(db, keyring);
  });
  afterEach(async () => {
    if (scheduleIds.length) {
      await db.delete(agentScheduleRuns).where(inArray(agentScheduleRuns.scheduleId, scheduleIds));
      await db.delete(agentSchedules).where(inArray(agentSchedules.id, scheduleIds));
    }
    if (addressIds.length) {
      await db.delete(agentBusMessages).where(inArray(agentBusMessages.targetAddressId, addressIds));
      await db.delete(agentBusConversations).where(inArray(agentBusConversations.addressBId, addressIds));
      await db.delete(agentBusAddresses).where(inArray(agentBusAddresses.id, addressIds));
    }
    if (host) await db.delete(agentBusRelays).where(eq(agentBusRelays.hostId, host.id));
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
      username: 'ztest-schedules',
      cwd: '/tmp/ztest-schedules',
      sessionId: id,
      bridgeToken: token,
      invocationKind: 'interactive',
      upstreamSessionId: randomUUID(),
      continuity: 'native',
    });
    const address = result.address as { id: string; address: string };
    addressIds.push(address.id);
    return { id, token, address };
  }
  async function create(target: string, persistent = true) {
    const value = await service.create(
      {
        name: 'Continue',
        target,
        prompt: 'continue task',
        kind: 'interval',
        interval_minutes: 1,
        persistent,
        ...(persistent ? { progress_timeout_seconds: 60 } : {}),
      },
      'host:fixture',
    );
    scheduleIds.push(value.schedule.id);
    return value.schedule;
  }
  async function runs(id: string) {
    return db.select().from(agentScheduleRuns).where(eq(agentScheduleRuns.scheduleId, id));
  }
  const due = () => new Date(Date.now() + 120000);
  it('CRUD preserves prompt encryption and rejects conflicting edits', async () => {
    const target = await agent('codex'),
      schedule = await create(target.address.address);
    const [row] = await db.select().from(agentSchedules).where(eq(agentSchedules.id, schedule.id));
    expect(row!.promptEnc).not.toContain('continue task');
    expect(decrypt(row!.promptEnc, keyring)).toBe('continue task');
    const edited = await service.update({ id: schedule.id, version: 1, name: 'Changed' }, 'host:other');
    expect(edited.schedule.name).toBe('Changed');
    expect(edited.schedule.updated_by).toBe('host:other');
    await expect(
      service.update({ id: schedule.id, version: 1, name: 'Stale' }, 'host:other'),
    ).rejects.toMatchObject({ code: 'schedule_version_conflict' });
    await service.remove({ id: schedule.id, version: 2 }, 'host:other');
    await expect(service.get(schedule.id)).rejects.toMatchObject({ code: 'schedule_not_found' });
  });
  it.each(['codex', 'claude', 'grok'] as const)(
    'dispatches persistent %s work once across concurrent ticks with a native target',
    async (engine) => {
      const target = await agent(engine),
        schedule = await create(target.address.address);
      await bus.finishSession(target.id, target.token, 'completed');
      const now = due();
      await Promise.all([service.tick(now), service.tick(now)]);
      const values = await runs(schedule.id);
      expect(values).toHaveLength(1);
      const [message] = await db
        .select()
        .from(agentBusMessages)
        .where(eq(agentBusMessages.id, values[0]!.messageId!));
      expect(message).toMatchObject({
        kind: 'schedule',
        sourceEngine: 'server',
        targetEngine: engine,
        status: 'queued',
      });
      const [row] = await db
        .select()
        .from(agentBusAddresses)
        .where(eq(agentBusAddresses.id, target.address.id));
      expect(row!.lastUpstreamSessionId).toBeTruthy();
      await db
        .update(agentBusMessages)
        .set({ nextAttemptAt: new Date().toISOString() })
        .where(eq(agentBusMessages.id, message!.id));
      const relay = await bus.registerRelay(host, {
        username: 'ztest-schedules',
        instanceId: randomUUID(),
        wrapperVersion: 'test',
      });
      const delivery = await bus.claimForRelay(
        String(relay.relay_id),
        String(relay.relay_token),
        randomUUID(),
      );
      expect(delivery).toMatchObject({
        kind: 'schedule',
        target: {
          engine,
          upstream_session_id: row!.lastUpstreamSessionId,
          schedule_persistent: true,
          progress_timeout_seconds: 60,
        },
      });

      await service.tick(new Date(now.getTime() + 600000));
      expect(await runs(schedule.id)).toHaveLength(1);
    },
  );
  it('regular schedules wait instead of resuming an ended session', async () => {
    const target = await agent('claude'),
      schedule = await create(target.address.address, false);
    await bus.finishSession(target.id, target.token, 'completed');
    await service.tick(due());
    expect((await runs(schedule.id))[0]).toMatchObject({ status: 'waiting', messageId: null });
  });
  it('recovers ambiguous failures after the interval and blocks missing transcripts', async () => {
    const target = await agent('grok'),
      schedule = await create(target.address.address);
    await bus.finishSession(target.id, target.token, 'completed');
    const now = due();
    await service.tick(now);
    const [run] = await runs(schedule.id);
    await db
      .update(agentBusMessages)
      .set({ status: 'ambiguous', lastErrorCode: 'native_outcome_ambiguous' })
      .where(eq(agentBusMessages.id, run!.messageId!));
    await service.tick(now);
    expect((await runs(schedule.id))[0]!.status).toBe('recovering');
    await service.tick(new Date(now.getTime() + 59000));
    expect((await runs(schedule.id))[0]!.recoveryCount).toBe(0);
    await service.tick(new Date(now.getTime() + 60000));
    expect((await runs(schedule.id))[0]!.recoveryCount).toBe(1);
    await db
      .update(agentBusMessages)
      .set({ status: 'dead', lastErrorCode: 'schedule_transcript_missing' })
      .where(eq(agentBusMessages.id, run!.messageId!));
    await service.tick(now);
    expect((await runs(schedule.id))[0]!.status).toBe('blocked');
  });
  it.each(['queued', 'leased'])('pause cancels %s work before acceptance', async (status) => {
    const target = await agent('codex'),
      schedule = await create(target.address.address);
    await bus.finishSession(target.id, target.token, 'completed');
    await service.tick(due());
    const [run] = await runs(schedule.id);
    await db.update(agentBusMessages).set({ status }).where(eq(agentBusMessages.id, run!.messageId!));
    await service.update({ id: schedule.id, version: 1, enabled: false }, 'admin:1');
    const [message] = await db
      .select()
      .from(agentBusMessages)
      .where(eq(agentBusMessages.id, run!.messageId!));
    expect(message!.status).toBe('canceled');
    expect((await runs(schedule.id))[0]!.status).toBe('canceled');
  });
  it('running recovery keeps its timeout snapshot; pausing protects accepted work', async () => {
    const target = await agent('codex'),
      schedule = await create(target.address.address);
    const now = due();
    await service.tick(now);
    expect(await service.sessionPolicy(target.id, target.token)).toMatchObject({
      progress_timeout_seconds: null,
    });
    const [run] = await runs(schedule.id);
    await db
      .update(agentBusMessages)
      .set({ status: 'accepted' })
      .where(eq(agentBusMessages.id, run!.messageId!));
    await service.update(
      { id: schedule.id, version: 1, persistent: false, progress_timeout_seconds: null },
      'admin:1',
    );
    expect(await service.sessionPolicy(target.id, target.token)).toMatchObject({
      progress_timeout_seconds: 60,
    });
    await service.update({ id: schedule.id, version: 2, enabled: false }, 'admin:1');
    expect(await service.sessionPolicy(target.id, target.token)).toMatchObject({
      progress_timeout_seconds: null,
    });
    const [message] = await db
      .select()
      .from(agentBusMessages)
      .where(eq(agentBusMessages.id, run!.messageId!));
    expect(message!.status).toBe('accepted');
    await db
      .update(agentBusMessages)
      .set({ status: 'ambiguous' })
      .where(eq(agentBusMessages.id, run!.messageId!));
    await service.tick(new Date(now.getTime() + 600000));
    expect((await runs(schedule.id))[0]).toMatchObject({ status: 'canceled', recoveryCount: 0 });
  });
  it('kill switch and engine suspension retain waiting work', async () => {
    const target = await agent('codex'),
      schedule = await create(target.address.address);
    await db.update(versions).set({ version: '1' }).where(eq(versions.name, 'api_disabled'));
    await service.tick(due());
    expect(await runs(schedule.id)).toHaveLength(0);
    await db.update(versions).set({ version: '0' }).where(eq(versions.name, 'api_disabled'));
    await db.update(versions).set({ version: '1' }).where(eq(versions.name, 'codex_engine_disabled'));
    invalidateFleetEngineState(db);
    await service.tick(due());
    expect((await runs(schedule.id))[0]).toMatchObject({ status: 'waiting', messageId: null });
  });
  it('timeout policy needs current bridge, active work and enabled opt-in', async () => {
    const target = await agent('codex'),
      schedule = await create(target.address.address);
    expect(await service.sessionPolicy(target.id, target.token)).toMatchObject({
      progress_timeout_seconds: null,
    });
    await db.update(agentSessions).set({ activeTurnId: 'working' }).where(eq(agentSessions.id, target.id));
    expect(await service.sessionPolicy(target.id, target.token)).toMatchObject({
      progress_timeout_seconds: 60,
    });
    await service.update({ id: schedule.id, version: 1, enabled: false }, 'host:other');
    expect(await service.sessionPolicy(target.id, target.token)).toMatchObject({
      progress_timeout_seconds: null,
    });
    await expect(service.sessionPolicy(target.id, 'invalid')).rejects.toMatchObject({
      code: 'schedule_bridge_invalid',
    });
  });
});
