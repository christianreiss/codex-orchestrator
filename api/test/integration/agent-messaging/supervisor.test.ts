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
});
