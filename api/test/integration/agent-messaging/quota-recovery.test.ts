import { randomBytes, randomUUID } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import { beforeAll, afterAll, afterEach, describe, it, expect } from 'vitest';
import { agentBusAddresses, agentBusConversations, agentBusMessages, agentSchedules, agentScheduleRuns, agentWatchdogs, agentSessions, providerAccounts, chatgptUsageSnapshots, claudeUsageSnapshots, grokUsageSnapshots, hosts, versions, hostDaemons } from '../../../src/db/schema.js';
import { AgentMessagingService } from '../../../src/services/agent-messaging.js';
import { WatchdogsService } from '../../../src/services/watchdogs.js';
import { SchedulesService } from '../../../src/services/schedules.js';
import { DEFAULT_QUOTA_POLICY } from '../../../src/services/quota-policy.js';
import { quotaNoticeId } from '../../../src/ops/quota-worker.js';
import { getTestDb, type TestDb } from '../../helpers/test-db.js';
import { loadTestEnv, testKeyring } from '../../helpers/test-keyring.js';
import { markPersistentHost } from '../../helpers/persistent-host.js';
import type { Engine } from '../../../src/util/engine.js';
const handle = await getTestDb();
describe.skipIf(!handle)('quota recovery on MySQL', { timeout: 120000 }, () => {
  const db = handle?.db as TestDb, keyring = testKeyring();
  const flagNames = ['api_disabled', 'agent_messaging_enabled', 'agent_portal_enabled', 'codex_engine_disabled', 'claude_engine_disabled', 'grok_engine_disabled'];
  let saved: (typeof versions.$inferSelect)[], host: typeof hosts.$inferSelect;
  let bus: AgentMessagingService, watchdogs: WatchdogsService, schedules: SchedulesService;
  const sessionIds: string[] = [], addressIds: string[] = [], accountIds: number[] = [];
  beforeAll(async () => {
    saved = await db.select().from(versions).where(inArray(versions.name, flagNames));
    for (const name of flagNames) await db.insert(versions).values({ name, updatedAt: new Date().toISOString(), version: name === 'agent_messaging_enabled' ? '1' : '0' }).onDuplicateKeyUpdate({ set: { version: name === 'agent_messaging_enabled' ? '1' : '0' } });
    const fqdn = `quota-test-${randomUUID()}.example`, now = new Date().toISOString();
    await db.insert(hosts).values({ fqdn, apiKey: randomBytes(32).toString('hex'), secure: 1, status: 'active', engines: 'codex,claude,grok', createdAt: now, updatedAt: now });
    host = (await db.select().from(hosts).where(eq(hosts.fqdn, fqdn)))[0]!;
    await markPersistentHost(db, host.id, 'quota-test');
    bus = new AgentMessagingService(db, loadTestEnv(), keyring); watchdogs = new WatchdogsService(db, keyring); schedules = new SchedulesService(db, keyring);
  });
  async function agent(engine: Engine, unlimited = false) {
    const now = new Date().toISOString(), label = randomUUID();
    await db.insert(providerAccounts).values({ engine, label, state: 'enabled', createdAt: now, updatedAt: now });
    const account = (await db.select().from(providerAccounts).where(eq(providerAccounts.label, label)))[0]!; accountIds.push(account.id);
    await db.insert(versions).values({ name: `quota_policy_account_${account.id}`, updatedAt: now, version: JSON.stringify({ ...DEFAULT_QUOTA_POLICY, unlimited, long_auto_resume: engine === 'grok' }) });
    const reset = new Date(Date.now() + 60000).toISOString();
    if (engine === 'claude') await db.insert(claudeUsageSnapshots).values({ accountId: account.id, fiveHourUsedPercent: 100, fiveHourResetsAt: reset, sevenDayUsedPercent: 20, sevenDayResetsAt: new Date(Date.now() + 86400000).toISOString(), fetchedAt: now, createdAt: now });
    else if (engine === 'codex') await db.insert(chatgptUsageSnapshots).values({ accountId: account.id, primaryUsedPercent: 100, primaryLimitSeconds: 18000, primaryResetAt: reset, status: 'ok', nextEligibleAt: now, fetchedAt: now, createdAt: now });
    else await db.insert(grokUsageSnapshots).values({ accountId: account.id, usedPercent: 100, periodType: 'weekly', periodResetsAt: reset, fetchedAt: now, checkedAt: now });
    const id = randomUUID(), token = randomBytes(32).toString('base64url'), native = randomUUID(); sessionIds.push(id);
    const registered = await bus.registerSession(host, { engine, username: 'quota-test', cwd: '/tmp/quota-test', sessionId: id, bridgeToken: token, invocationKind: 'interactive', upstreamSessionId: native, continuity: 'native', adapterProtocol: 'cxx-agent-listen-v1', adapterCapabilities: { execution_contract_version: 2, watchdog_protocol_version: 1 } });
    const address = registered.address as { id: string }; addressIds.push(address.id);
    await db.update(agentSessions).set({ providerAccountId: account.id }).where(eq(agentSessions.id, id));
    return { id, token, native, account, address, reset };
  }
  afterEach(async () => {
    const watches = addressIds.length ? await db.select().from(agentWatchdogs).where(inArray(agentWatchdogs.targetAddressId, addressIds)) : [];
    const ids = watches.map(w => w.scheduleId);
    if (ids.length) { await db.delete(agentWatchdogs).where(inArray(agentWatchdogs.scheduleId, ids)); await db.delete(agentScheduleRuns).where(inArray(agentScheduleRuns.scheduleId, ids)); await db.delete(agentSchedules).where(inArray(agentSchedules.id, ids)); }
    if (addressIds.length) { await db.delete(agentBusMessages).where(inArray(agentBusMessages.targetAddressId, addressIds)); await db.delete(agentBusConversations).where(inArray(agentBusConversations.addressBId, addressIds)); await db.delete(agentBusAddresses).where(inArray(agentBusAddresses.id, addressIds)); }
    if (sessionIds.length) await db.delete(agentSessions).where(inArray(agentSessions.id, sessionIds));
    for (const id of accountIds) { await db.delete(versions).where(eq(versions.name, `quota_policy_account_${id}`)); await db.delete(chatgptUsageSnapshots).where(eq(chatgptUsageSnapshots.accountId, id)); await db.delete(claudeUsageSnapshots).where(eq(claudeUsageSnapshots.accountId, id)); await db.delete(grokUsageSnapshots).where(eq(grokUsageSnapshots.accountId, id)); await db.delete(providerAccounts).where(eq(providerAccounts.id, id)); }
    sessionIds.length = addressIds.length = accountIds.length = 0;
  });
  afterAll(async () => {
    await db.delete(hostDaemons).where(eq(hostDaemons.hostId, host.id)); await db.delete(hosts).where(eq(hosts.id, host.id));
    await db.delete(versions).where(inArray(versions.name, flagNames)); for (const row of saved) await db.insert(versions).values(row);
    await handle!.pool.end();
  });
  it.each(['codex', 'claude', 'grok'] as const)('%s arms one bound reset recovery and user stop prevents it', async engine => {
    const a = await agent(engine);
    const body = { failure: 'capacity', last_progress_at: new Date().toISOString(), native_session_id: a.native };
    await watchdogs.activity(a.id, a.token, body); await watchdogs.activity(a.id, a.token, body);
    const row = await watchdogs.forSession(a.id);
    expect(row).toMatchObject({ status: 'capacity_wait', quota: { account_id: a.account.id, window: engine === 'grok' ? 'long' : 'short', attempts: 0 } });
    await schedules.tick(); expect(await db.select().from(agentScheduleRuns).where(eq(agentScheduleRuns.targetAddressId, a.address.id))).toHaveLength(0);
    await watchdogs.activity(a.id, a.token, { failure: 'user_stop', last_progress_at: new Date().toISOString(), native_session_id: a.native });
    await schedules.tick(new Date(Date.now() + 400000)); expect((await watchdogs.forSession(a.id))?.status).toBe('disabled');
  });
  it('suppresses unlimited recovery and cancels reset wake after a policy change', async () => {
    const unlimited = await agent('claude', true);
    await watchdogs.activity(unlimited.id, unlimited.token, { failure: 'capacity', last_progress_at: new Date().toISOString(), native_session_id: unlimited.native });
    expect(await watchdogs.forSession(unlimited.id)).toBeNull();
    const a = await agent('codex');
    await watchdogs.activity(a.id, a.token, { failure: 'capacity', last_progress_at: new Date().toISOString(), native_session_id: a.native });
    await db.update(versions).set({ version: JSON.stringify({ ...DEFAULT_QUOTA_POLICY, unlimited: true }) }).where(eq(versions.name, `quota_policy_account_${a.account.id}`));
    await schedules.tick(new Date(Date.now() + 400000));
    expect(await watchdogs.forSession(a.id)).toMatchObject({ status: 'blocked', last_error: 'quota_policy_disabled' });
  });
  it('keeps a scheduled delivery in its existing lane and fences a queued wake after PayG changes', async () => {
    const a = await agent('claude');
    const scheduled = await schedules.create({ name: 'quota scheduled work', target: `agent:${a.address.id}`, prompt: 'Continue this authorized task', kind: 'once', at: new Date(Date.now() + 1000).toISOString(), persistent: true, progress_timeout_seconds: 600 }, 'test');
    const id = scheduled.schedule.id;
    try {
      await schedules.tick(new Date(Date.now() + 2000));
      const [run] = await db.select().from(agentScheduleRuns).where(eq(agentScheduleRuns.scheduleId, id));
      await db.update(agentBusMessages).set({ status: 'accepted', deliverySessionId: a.id }).where(eq(agentBusMessages.id, run!.messageId!));
      await db.update(agentScheduleRuns).set({ status: 'accepted' }).where(eq(agentScheduleRuns.id, run!.id));
      await watchdogs.activity(a.id, a.token, { failure: 'capacity', last_progress_at: new Date().toISOString(), native_session_id: a.native });
      expect(await watchdogs.forSession(a.id)).toBeNull();
      const [bound] = await db.select().from(agentScheduleRuns).where(eq(agentScheduleRuns.id, run!.id));
      expect(bound?.quotaRecovery).toMatchObject({ account_id: a.account.id, native_session_id: a.native, window: 'short' });
      await db.update(agentBusMessages).set({ status: 'queued', nextAttemptAt: new Date().toISOString() }).where(eq(agentBusMessages.id, run!.messageId!));
      await db.update(versions).set({ version: JSON.stringify({ ...DEFAULT_QUOTA_POLICY, unlimited: true }) }).where(eq(versions.name, `quota_policy_account_${a.account.id}`));
      expect(await bus.claimForSession(a.id, a.token, randomUUID())).toBeNull();
    } finally {
      await db.delete(agentScheduleRuns).where(eq(agentScheduleRuns.scheduleId, id));
      await db.delete(agentSchedules).where(eq(agentSchedules.id, id));
    }
  });
  it('deduplicates informational notices transactionally and binds them to the running session', async () => {
    const a = await agent('claude'); const key = quotaNoticeId(`test:${a.id}`);
    const notices = await Promise.all([bus.noticeAddresses([a.address.id], 'QUOTA/1 warning', key), bus.noticeAddresses([a.address.id], 'QUOTA/1 warning', key)]);
    expect(notices[0].deliveries[0]?.message_id).toBe(notices[1].deliveries[0]?.message_id);
    const rows = await db.select().from(agentBusMessages).where(and(eq(agentBusMessages.targetAddressId, a.address.id), eq(agentBusMessages.clientMessageId, key)));
    expect(rows).toHaveLength(1); expect(rows[0]).toMatchObject({ kind: 'presence_notice', targetSessionId: a.id });
  });
});
