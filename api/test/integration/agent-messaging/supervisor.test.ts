import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import * as schema from '../../../src/db/schema.js';
import { getTestDb } from '../../helpers/test-db.js';
import { supervisorFixture } from '../../helpers/supervisor.js';
import { WatchdogsService } from '../../../src/services/watchdogs.js';
import { OwnerStateSnapshot } from '../../../src/control-plane/state/store.js';
import { randomUUID } from 'node:crypto';
import { splitSqlStatements } from '../../../src/db/migration-sql.js';
import { readFile } from 'node:fs/promises';
import { mutateOwnerState } from '../../../src/control-plane/state/runtime.js';
import { cancelOwnedConversation } from '../../../src/services/agent-messaging/owned-cancel.js';
import { newQueuedMessage } from '../../../src/services/agent-messaging/views.js';
const handle = await getTestDb();
describe.skipIf(!handle)('durable supervisor on isolated MySQL', () => {
  let f: ReturnType<typeof supervisorFixture>;
  beforeAll(async () => {
    f = supervisorFixture('codex', {}, handle!.db);
    // Populate only this fixture's explicit rows; all identities are task-owned.
    for (const table of [schema.hosts, schema.hostDaemons, schema.agentBusAddresses, schema.agentSessions]) {
      const rows = f.fake.tables.get(table)!;
      await handle!.db.insert(table).values(rows as never);
    }
  });
  afterAll(async () => {
    if (f) {
      const ids = f.agents.map((a) => a.addressId),
        sessions = f.agents.map((a) => a.id),
        db = handle!.db;
      const dogs = await db
        .select()
        .from(schema.agentWatchdogs)
        .where(inArray(schema.agentWatchdogs.targetAddressId, ids));
      const scheduleIds = dogs.map((d) => d.scheduleId);
      await db.delete(schema.agentChatNotices).where(inArray(schema.agentChatNotices.sessionId, sessions));
      await db.delete(schema.agentEvents).where(inArray(schema.agentEvents.sessionId, sessions));
      if (scheduleIds.length) {
        await db
          .delete(schema.agentScheduleRuns)
          .where(inArray(schema.agentScheduleRuns.scheduleId, scheduleIds));
        await db.delete(schema.agentWatchdogs).where(inArray(schema.agentWatchdogs.scheduleId, scheduleIds));
        await db.delete(schema.agentSchedules).where(inArray(schema.agentSchedules.id, scheduleIds));
      }
      await db.delete(schema.agentWorkStates).where(inArray(schema.agentWorkStates.addressId, ids));
      await db
        .delete(schema.agentWorkDependencies)
        .where(inArray(schema.agentWorkDependencies.waiterAddressId, ids));
      await db.delete(schema.agentBusMessages).where(inArray(schema.agentBusMessages.targetAddressId, ids));
      await db
        .delete(schema.agentBusConversations)
        .where(inArray(schema.agentBusConversations.addressBId, ids));
      await db.delete(schema.agentSessions).where(inArray(schema.agentSessions.id, sessions));
      await db.delete(schema.agentBusAddresses).where(inArray(schema.agentBusAddresses.id, ids));
      await db.delete(schema.hostDaemons).where(eq(schema.hostDaemons.hostId, 94251));
      await db.delete(schema.hosts).where(eq(schema.hosts.id, 94251));
      f.close();
    }
    await handle!.pool.end();
  });
  it('atomically arms early capacity, reloads its budget and retains it on duplicate observation', async () => {
    const a = f.agents[0]!,
      dogs = new WatchdogsService(handle!.db, f.keyring);
    await dogs.activity(a.id, f.token, { last_progress_at: f.now, failure: 'capacity' });
    const [work] = await handle!.db
      .select()
      .from(schema.agentWorkStates)
      .where(eq(schema.agentWorkStates.addressId, a.addressId));
    expect(work?.watchdogId).toBeTruthy();
    expect(work?.model).toBe('fixture-model');
    const [dog] = await handle!.db
      .select()
      .from(schema.agentWatchdogs)
      .where(eq(schema.agentWatchdogs.id, work!.watchdogId!));
    expect(dog?.status).toBe('capacity_wait');
    expect(dog?.deadlineAt).toBe(work?.deadlineAt);
    expect(Date.parse(work!.deadlineAt!) - Date.parse(work!.incidentAt!)).toBe(7200000);
    const reboot = new OwnerStateSnapshot(
      { epoch: randomUUID(), sequence: 0n },
      { agentWorkStates: [work!], agentWatchdogs: [dog!] },
    );
    expect(reboot.table('agentWorkStates').get(a.addressId)?.deadlineAt).toBe(work!.deadlineAt);
    await dogs.activity(a.id, f.token, { last_progress_at: f.now, failure: 'capacity' });
    expect(
      await handle!.db
        .select()
        .from(schema.agentWatchdogs)
        .where(eq(schema.agentWatchdogs.targetAddressId, a.addressId)),
    ).toHaveLength(1);
    expect(
      (
        await handle!.db
          .select()
          .from(schema.agentWorkStates)
          .where(eq(schema.agentWorkStates.addressId, a.addressId))
      )[0]!.deadlineAt,
    ).toBe(work!.deadlineAt);
  });
  it('persists an explicit direct-operator task key and reason before automatic discovery', async () => {
    const a = f.agents[1]!;
    const input = {
      state: 'working', task_key: 'dc-upgrade-critical-review',
      coordinator: `agent:${f.agents[0]!.addressId}`,
      reason: 'Dokumente, Originalangebot, Belege und Herstellerangaben geprüft; priorisiertes Feedback wird abgeschlossen.',
    };
    await f.service.report(a.id, f.token, input);
    await f.service.report(a.id, f.token, input);
    const [work] = await handle!.db.select().from(schema.agentWorkStates)
      .where(eq(schema.agentWorkStates.addressId, a.addressId));
    expect(work).toMatchObject({ taskKey: input.task_key, reason: input.reason, state: input.state,
      coordinatorAddressId: f.agents[0]!.addressId, model: 'fixture-model' });
    expect(work?.version).toBe(1);
  });
  it('migration can be reapplied without losing state', async () => {
    const before = await handle!.db.select().from(schema.agentWorkStates);
    const sql = await readFile(
      new URL('../../../src/db/migrations/0111_agent_supervisor.sql', import.meta.url),
      'utf8',
    );
    const connection = await handle!.pool.getConnection();
    try {
      for (const statement of splitSqlStatements(sql)) await connection.query(statement);
    } finally {
      connection.release();
    }
    expect(await handle!.db.select().from(schema.agentWorkStates)).toEqual(before);
  });
  it('cancels a completed-work conversation idempotently without undoing the completed result', async () => {
    const [source, target] = f.agents, id = randomUUID(), messageId = randomUUID();
    const conversation = {
      id, addressAId: source!.addressId, addressBId: target!.addressId,
      createdByAddressId: source!.addressId, nextSequence: 2, status: 'open',
      lastActivityAt: f.now, canceledBy: null, cancelReason: null, canceledAt: null,
      createdAt: f.now, updatedAt: f.now,
    };
    const message = {
      ...newQueuedMessage({
        id: messageId, conversationId: id, sequence: 1,
        sender: f.state.snapshot().addresses.get(source!.addressId)!, senderSessionId: source!.id,
        target: f.state.snapshot().addresses.get(target!.addressId)!, kind: 'request',
        content: 'Completed fixture', contentEnc: 'fixture', clientMessageId: randomUUID(),
        expiresAt: '2099-01-01T00:00:00.000Z', now: f.now,
      }),
      status: 'completed', claimId: randomUUID(), acceptedAt: f.now, completedAt: f.now,
      taskResultStatus: 'succeeded',
    };
    await mutateOwnerState(f.owner, {
      kind: 'test.completed-conversation', payload: { id }, prepare(ctx) {
        ctx.draft.upsert('agentBusConversations', conversation);
        ctx.draft.upsert('agentBusMessages', { ...message, dispatchOrder: 1 } as schema.AgentBusMessage);
        ctx.write(async tx => {
          await tx.insert(schema.agentBusConversations).values(conversation);
          await tx.insert(schema.agentBusMessages).values(message);
        });
        return null;
      },
    });
    const before = await handle!.db.select().from(schema.agentBusMessages).where(eq(schema.agentBusMessages.id, messageId));
    const cancel = () => cancelOwnedConversation(f.owner, id, `agent:${source!.addressId}`,
      'Operator withdrew the completed request', { sessionId: source!.id, token: f.token });
    expect(await cancel()).toMatchObject({
      status: 'canceled', canceled_messages: 0, ambiguous_messages: 0,
    });
    const [canceled] = await handle!.db.select().from(schema.agentBusConversations).where(eq(schema.agentBusConversations.id, id));
    expect(await cancel()).toMatchObject({ status: 'canceled', canceled_messages: 0, ambiguous_messages: 0 });
    expect(await handle!.db.select().from(schema.agentBusMessages).where(eq(schema.agentBusMessages.id, messageId))).toEqual(before);
    expect((await handle!.db.select().from(schema.agentBusConversations).where(eq(schema.agentBusConversations.id, id)))[0]).toEqual(canceled);
  });
});
