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
      await db.delete(agentTaskResults).where(inArray(agentTaskResults.messageId, (await db.select({id:agentBusMessages.id}).from(agentBusMessages).where(inArray(agentBusMessages.targetAddressId,addressIds))).map(r=>r.id)));
      await db.delete(agentFreshStartGrants).where(inArray(agentFreshStartGrants.targetAddressId,addressIds));
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
      adapterProtocol: 'cxx-agent-listen-v1',
      adapterCapabilities: { execution_contract_version: 2 },
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
        capabilities: { execution_contract_version: 2 },
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
    await service.tick(new Date(now.getTime() + 72000));
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
  it.each(['codex','claude','grok'] as const)('stores encrypted %s outcomes idempotently, with an atomic peer reply', async engine => {
    const sender=await agent(engine), target=await agent(engine);
    const sent=await bus.sendMessage(sender.id,sender.token,{to:target.address.address,content:'check fixture',kind:'request',clientMessageId:randomUUID()});
    const messageId=String((sent.message as Record<string,unknown>).id), claimId=randomUUID();
    const delivery=await bus.claimForSession(target.id,target.token,claimId);
    expect(delivery).toMatchObject({message_id:messageId,work_kind:'request',execution_contract_version:2});
    const report={status:'succeeded' as const,summary:'Fixture check passed',evidence:[{description:'checked fixture',reference:'/tmp/fixture'}]};
    await expect(bus.acknowledgeSessionDelivery(target.id,target.token,messageId,{claimId,outcome:'completed',taskResult:report})).rejects.toMatchObject({code:'agent_task_result_not_accepted'});
    await bus.acknowledgeSessionDelivery(target.id,target.token,messageId,{claimId,outcome:'accepted'});
    const input={claimId,taskResult:report,content:'Fixture checked',clientMessageId:randomUUID()};
    await bus.replyMessage(target.id,target.token,messageId,input);
    const completedAt = '2026-01-01T00:00:00.000Z';
    await db.update(agentBusMessages).set({ completedAt }).where(eq(agentBusMessages.id, messageId));
    await bus.replyMessage(target.id,target.token,messageId,input);
    const [message]=await db.select().from(agentBusMessages).where(eq(agentBusMessages.id,messageId));
    expect(message).toMatchObject({status:'completed',taskResultStatus:'succeeded'});
    expect(message!.completedAt).toBe(completedAt);
    const rows=await db.select().from(agentTaskResults).where(eq(agentTaskResults.messageId,messageId));
    expect(rows).toHaveLength(1); expect(rows[0]!.bodyEnc).not.toContain(report.summary);
    expect(JSON.parse(decrypt(rows[0]!.bodyEnc,keyring))).toEqual(report);
    await expect(bus.acknowledgeSessionDelivery(target.id,target.token,messageId,{claimId,outcome:'completed',taskResult:{...report,status:'failed'}})).rejects.toMatchObject({code:'agent_task_result_conflict'});
    await expect(bus.acknowledgeSessionDelivery(target.id,target.token,messageId,{claimId:randomUUID(),outcome:'completed',taskResult:report})).rejects.toMatchObject({code:'agent_messaging_lease_lost'});
  });
  it('keeps work queued for legacy adapters and accepts informational traffic',async()=>{
    const sender=await agent('codex'),target=await agent('claude');
    await bus.heartbeatSession(target.id,target.token,{adapterCapabilities:{listen:true},receiveCapable:true});
    const sent=await bus.sendMessage(sender.id,sender.token,{to:target.address.address,content:'legacy upgrade required',kind:'request',clientMessageId:randomUUID()});
    expect(await bus.claimForSession(target.id,target.token,randomUUID())).toBeNull();
    const [row]=await db.select().from(agentBusMessages).where(eq(agentBusMessages.id,String((sent.message as Record<string,unknown>).id)));
    expect(row!.lastErrorCode).toBe('adapter_upgrade_required');
  });
  it('consumes one operator grant for ordinary missing transcripts and rejects wakes',async()=>{
    const sender=await agent('codex'),target=await agent('grok');
    const sent=await bus.sendMessage(sender.id,sender.token,{to:target.address.address,content:'ordinary task',kind:'request',clientMessageId:randomUUID()});
    const messageId=String((sent.message as Record<string,unknown>).id),claimId=randomUUID();
    await bus.claimForSession(target.id,target.token,claimId);
    await bus.acknowledgeSessionDelivery(target.id,target.token,messageId,{claimId,outcome:'dead',errorCode:'native_transcript_missing'});
    // The operator can approve recovery after the original queue TTL elapsed.
    await db.update(agentBusMessages).set({ expiresAt: '2026-01-01T00:00:00.000Z', attempts: 12 }).where(eq(agentBusMessages.id, messageId));
    await expect(bus.approveMessageFreshStart(messageId,2,'Operator requests replacement','host:fixture')).rejects.toMatchObject({code:'agent_execution_version_conflict'});
    await bus.approveMessageFreshStart(messageId,1,'Operator requests replacement','host:fixture');
    await bus.approveMessageFreshStart(messageId,1,'Operator requests replacement','host:fixture');
    expect(await bus.claimForSession(target.id,target.token,randomUUID())).toBeNull();
    await bus.finishSession(target.id,target.token,'completed');
    const relay=await bus.registerRelay(host,{username:'ztest-schedules',instanceId:randomUUID(),wrapperVersion:'test',capabilities:{execution_contract_version:2}});
    const nextClaim=randomUUID();
    const replacement=await bus.claimForRelay(String(relay.relay_id),String(relay.relay_token),nextClaim);
    expect(replacement?.target.fresh_start_approved).toBe(true);
    await bus.acknowledgeRelayDelivery(String(relay.relay_id),String(relay.relay_token),messageId,{claimId:nextClaim,outcome:'accepted'});
    const [grant]=await db.select().from(agentFreshStartGrants).where(eq(agentFreshStartGrants.messageId,messageId));
    expect(grant?.consumedClaimId).toBe(nextClaim);
    await bus.acknowledgeRelayDelivery(String(relay.relay_id),String(relay.relay_token),messageId,{claimId:nextClaim,outcome:'dead',errorCode:'native_transcript_missing'});
    await expect(bus.approveMessageFreshStart(messageId,2,'Again','host:fixture')).rejects.toMatchObject({code:'agent_fresh_start_already_granted'});
    const schedule=await create(target.address.address);
    await service.tick(due()); const [run]=await runs(schedule.id);
    await expect(bus.approveMessageFreshStart(run!.messageId!,1,'Fresh wake','host:fixture')).rejects.toThrow();
  });
  it('pauses the entire schedule when recovery attempts are exhausted and starts a new budget on re-enable',async()=>{
    const target=await agent('codex'),schedule=await create(target.address.address);
    await service.update({id:schedule.id,version:1,max_recovery_attempts:1},'host:fixture');
    await service.tick(due()); const [run]=await runs(schedule.id);
    await db.update(agentScheduleRuns).set({recoveryCount:1}).where(eq(agentScheduleRuns.id,run!.id));
    await db.update(agentBusMessages).set({status:'ambiguous',lastErrorCode:'schedule_capacity'}).where(eq(agentBusMessages.id,run!.messageId!));
    await service.tick(due());
    const paused=await service.get(schedule.id); expect(paused.schedule).toMatchObject({enabled:false,pause_reason:'recovery_limit_reached'});
    await service.tick(new Date(Date.now()+86400000)); expect(await runs(schedule.id)).toHaveLength(1);
    await service.update({id:schedule.id,version:paused.schedule.version,enabled:true},'host:fixture');
    await service.tick(due()); expect((await runs(schedule.id)).map(r=>r.recoveryCount).sort()).toEqual([0,1]);
  });

 it('fences a headless result while allowing its accepted child to bind the same target',async()=>{
  const sender=await agent('codex'), target=await agent('claude');
  const sent=await bus.sendMessage(sender.id,sender.token,{to:target.address.address,content:'headless check',kind:'request',clientMessageId:randomUUID()});
  const messageId=String((sent.message as Record<string,unknown>).id);
  await bus.finishSession(target.id,target.token,'completed');
  const relay=await bus.registerRelay(host,{username:'ztest-schedules',instanceId:randomUUID(),wrapperVersion:'test',capabilities:{execution_contract_version:2}}),claimId=randomUUID();
  const delivery=await bus.claimForRelay(String(relay.relay_id),String(relay.relay_token),claimId);
  await bus.acknowledgeRelayDelivery(String(relay.relay_id),String(relay.relay_token),messageId,{claimId,outcome:'accepted'});
  const childId=randomUUID(),token=randomBytes(32).toString('base64url');sessionIds.push(childId);
  const registration={engine:'claude' as const,username:'ztest-schedules',cwd:'/tmp/ztest-schedules',sessionId:childId,bridgeToken:token,invocationKind:'peer_delivery' as const,requestedAddress:target.address.address,expectedBindingGeneration:Number(delivery!.target.binding_generation),upstreamSessionId:String(delivery!.target.upstream_session_id),deliveryMessageId:messageId,deliveryClaimId:claimId,adapterCapabilities:{execution_contract_version:2}};
  await expect(bus.registerSession(host,{...registration,deliveryClaimId:randomUUID()})).rejects.toMatchObject({code:'agent_messaging_lease_lost'});
  await expect(bus.registerSession(host,{...registration,upstreamSessionId:null})).rejects.toMatchObject({code:'agent_fresh_start_not_authorized'});
  await bus.registerSession(host,registration);
  await bus.renewRelayDelivery(String(relay.relay_id),String(relay.relay_token),messageId,claimId);
  await bus.finishSession(childId,token,'completed');
  await bus.replyFromRelayDelivery(String(relay.relay_id),String(relay.relay_token),messageId,{claimId,content:'checked',clientMessageId:randomUUID(),upstreamSessionId:'replacement-native',taskResult:{status:'succeeded',summary:'checked'}});
  const [message]=await db.select().from(agentBusMessages).where(eq(agentBusMessages.id,messageId));
  expect(message).toMatchObject({status:'completed',taskResultStatus:'succeeded',deliverySessionId:childId,targetBindingGeneration:Number(delivery!.target.binding_generation)+1});
  const [address]=await db.select().from(agentBusAddresses).where(eq(agentBusAddresses.id,target.address.id));expect(address!.lastUpstreamSessionId).toBe('replacement-native');
 });

 it('queues one correlated summary for a result-only peer completion, and none for a wake',async()=>{
  const sender=await agent('codex'),target=await agent('claude');
  const sent=await bus.sendMessage(sender.id,sender.token,{to:target.address.address,content:'check fixture',kind:'request',clientMessageId:randomUUID()}),messageId=String((sent.message as Record<string,unknown>).id),claimId=randomUUID();
  await bus.claimForSession(target.id,target.token,claimId);
  await bus.acknowledgeSessionDelivery(target.id,target.token,messageId,{claimId,outcome:'accepted'});
  const report={status:'blocked' as const,summary:'Operator input required'};
  const input={claimId,outcome:'completed' as const,taskResult:report};
  await bus.acknowledgeSessionDelivery(target.id,target.token,messageId,input);
  await bus.acknowledgeSessionDelivery(target.id,target.token,messageId,input);
  const replies=await db.select().from(agentBusMessages).where(eq(agentBusMessages.replyToMessageId,messageId));
  expect(replies).toHaveLength(1);expect(replies[0]).toMatchObject({kind:'reply',status:'queued',targetAddressId:sender.address.id});
  expect(decrypt(replies[0]!.contentEnc,keyring)).toBe(report.summary);
  const schedule=await create(target.address.address);await service.tick(due());const [run]=await runs(schedule.id);
  await db.update(agentBusMessages).set({nextAttemptAt:new Date().toISOString()}).where(eq(agentBusMessages.id,run!.messageId!));
  const wakeClaim=randomUUID();await bus.claimForSession(target.id,target.token,wakeClaim);
  await bus.acknowledgeSessionDelivery(target.id,target.token,run!.messageId!,{claimId:wakeClaim,outcome:'accepted'});
  await bus.acknowledgeSessionDelivery(target.id,target.token,run!.messageId!,{claimId:wakeClaim,outcome:'completed',taskResult:{status:'failed',summary:'Fixture domain failure'}});
  expect(await db.select().from(agentBusMessages).where(eq(agentBusMessages.replyToMessageId,run!.messageId!))).toHaveLength(0);
  await service.tick(due());expect((await runs(schedule.id))[0]).toMatchObject({status:'completed',recoveryCount:0});
 });

});
