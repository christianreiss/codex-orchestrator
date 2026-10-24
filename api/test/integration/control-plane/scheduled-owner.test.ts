import { randomUUID } from 'node:crypto';
import mysql from 'mysql2/promise';
import { drizzle } from 'drizzle-orm/mysql2';
import { eq, inArray } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import * as schema from '../../../src/db/schema.js';
import { createOwnedControlPlane } from '../../../src/control-plane/bootstrap.js';
import { registerOwnedMessagingSession } from '../../../src/control-plane/state/session-registration.js';
import { mutateOwnerState } from '../../../src/control-plane/state/runtime.js';
import { stageUpdate } from '../../../src/control-plane/state/rows.js';
import { SchedulesService } from '../../../src/services/schedules.js';
import { WatchdogsService } from '../../../src/services/watchdogs.js';
import { daemonSettingsSchema } from '../../../src/services/host-daemon/policy.js';
import { sha256 } from '../../../src/security/hash.js';
import { readDbConfig } from '../../helpers/test-db.js';
import { loadTestEnv, testKeyring } from '../../helpers/test-keyring.js';
import { installSqlBudget } from '../../helpers/sql-budget.js';

const config = readDbConfig();
describe.skipIf(!config)('scheduled owner lifecycle on real MySQL', () => {
  it(
    'persists due wakes, protects native identity, and keeps repeated watchdog observations SQL-free',
    { timeout: 90_000 },
    async () => {
      const pool = mysql.createPool({ ...config!, connectionLimit: 3 }),
        db = drizzle(pool, { schema, mode: 'default' }),
        keyring = testKeyring();
      const env = { ...loadTestEnv(), DB_DATABASE: String(config!.database) },
        budget = installSqlBudget(pool),
        now = new Date().toISOString();
      const [flag] = await db
        .select()
        .from(schema.versions)
        .where(eq(schema.versions.name, 'agent_messaging_enabled'));
      await db
        .insert(schema.versions)
        .values({ name: 'agent_messaging_enabled', version: '1', updatedAt: now })
        .onDuplicateKeyUpdate({ set: { version: '1' } });
      const [created] = await db
        .insert(schema.hosts)
        .values({
          fqdn: `scheduled-${randomUUID()}.test`,
          apiKey: 'fixture-key',
          apiKeyHash: sha256('fixture-key'),
          secure: 1,
          status: 'active',
          engines: 'codex,claude,grok',
          createdAt: now,
          updatedAt: now,
        });
      const hostId = Number(created.insertId),
        sessions: string[] = [],
        addresses: string[] = [],
        schedules: string[] = [];
      await db
        .insert(schema.hostDaemons)
        .values({
          hostId,
          settings: daemonSettingsSchema.parse({
            enabled: true,
            resident_enabled: true,
            username: 'fixture',
          }),
          updatedAt: now,
        });
      const [host] = await db.select().from(schema.hosts).where(eq(schema.hosts.id, hostId));
      let owner: Awaited<ReturnType<typeof createOwnedControlPlane>> | undefined;
      try {
        owner = await createOwnedControlPlane({
          pool,
          handle: db,
          env,
          keyring,
          error: (error) => {
            throw error;
          },
        });
        const service = new SchedulesService(db, keyring),
          watchdogs = new WatchdogsService(db, keyring);
        for (const engine of ['codex', 'claude', 'grok'] as const) {
          const id = randomUUID(),
            token = `fixture-${randomUUID()}-${randomUUID()}`;
          sessions.push(id);
          await registerOwnedMessagingSession(
            owner.runtime,
            host!,
            {
              sessionId: id,
              bridgeToken: token,
              engine,
              username: 'fixture',
              cwd: '/fixture',
              invocationKind: 'interactive',
              upstreamSessionId: randomUUID(),
              adapterCapabilities: { watchdog_protocol_version: 1 },
            },
            env,
          );
          const address = owner.runtime.state.snapshot().sessions.get(id)!.agentBusAddressId!;
          addresses.push(address);
          const createdSchedule = await service.create(
            {
              target: `agent:${address}`,
              name: 'Lifecycle fixture',
              prompt: 'Authorized fixture work',
              kind: 'once',
              at: new Date(Date.now() + 3600_000).toISOString(),
              timezone: 'UTC',
            },
            'integration',
          );
          schedules.push(createdSchedule.schedule.id);
          const paused = await service.update(
            { id: createdSchedule.schedule.id, version: createdSchedule.schedule.version, enabled: false },
            'integration',
          );
          await service.remove({ id: paused.schedule.id, version: paused.schedule.version }, 'integration');
          const enabled = await watchdogs.enable(
            {
              target: `agent:${address}`,
              task_key: `fixture-${engine}`,
              continuation: 'Continue the authorized integration fixture',
              duration_seconds: 120,
            },
            'integration',
            id,
          );
          const watch = owner.runtime.state.snapshot().table('agentWatchdogs').get(enabled.id)!;
          schedules.push(watch.scheduleId);
          budget.reset();
          for (let n = 0; n < 25; n++) {
            await watchdogs.snapshot(id, token);
            await watchdogs.activity(id, token, { last_progress_at: watch.lastProgressAt });
            await service.sessionPolicy(id, token);
            await service.list();
          }
          expect(budget.snapshot()).toEqual([]);
          await watchdogs.activity(id, token, { last_progress_at: watch.lastProgressAt, failure: 'crash' });
          expect(owner.runtime.state.snapshot().table('agentWatchdogs').get(enabled.id)?.status).toBe(
            'recovering',
          );
          await mutateOwnerState(owner.runtime, {
            kind: 'fixture.due',
            payload: { id },
            prepare(context) {
              stageUpdate(context, 'agentSchedules', watch.scheduleId, { nextDueAt: now, atTime: now });
              return null;
            },
          });
          await service.tick();
          const run = owner.runtime.state
            .snapshot()
            .table('agentScheduleRuns')
            .by('scheduleId', watch.scheduleId)[0]!;
          expect(run.status).toBe('queued');
          expect(run.messageId).toBeTruthy();
          await mutateOwnerState(owner.runtime, {
            kind: 'fixture.accept',
            payload: { id },
            prepare(context) {
              stageUpdate(context, 'agentBusMessages', run.messageId!, {
                status: 'accepted',
                acceptedAt: now,
                deliverySessionId: id,
                targetBindingGeneration: 1,
              });
              stageUpdate(context, 'agentScheduleRuns', run.id, { status: 'accepted' });
              return null;
            },
          });
          await watchdogs.finish(
            { id: enabled.id, version: enabled.version, status: 'succeeded' },
            'integration',
            false,
            id,
          );
          expect(owner.runtime.state.snapshot().table('agentScheduleRuns').get(run.id)?.status).toBe(
            'accepted',
          );
          expect(owner.runtime.state.snapshot().table('agentBusMessages').get(run.messageId!)?.status).toBe(
            'accepted',
          );
        }
      } finally {
        const epoch = owner?.runtime.state.revision().epoch;
        await owner?.close();
        if (epoch)
          await pool.execute('DELETE FROM control_plane_command_receipts WHERE owner_epoch = ?', [epoch]);
        if (schedules.length) {
          await db.delete(schema.agentWatchdogs).where(inArray(schema.agentWatchdogs.scheduleId, schedules));
          await db
            .delete(schema.agentScheduleRuns)
            .where(inArray(schema.agentScheduleRuns.scheduleId, schedules));
          await db.delete(schema.agentSchedules).where(inArray(schema.agentSchedules.id, schedules));
        }
        if (addresses.length) {
          const messages = await db
            .select({ conversationId: schema.agentBusMessages.conversationId })
            .from(schema.agentBusMessages)
            .where(inArray(schema.agentBusMessages.targetAddressId, addresses));
          await db
            .delete(schema.agentBusMessages)
            .where(inArray(schema.agentBusMessages.targetAddressId, addresses));
          if (messages.length)
            await db.delete(schema.agentBusConversations).where(
              inArray(
                schema.agentBusConversations.id,
                messages.map((row) => row.conversationId),
              ),
            );
        }
        if (sessions.length) {
          await db.delete(schema.agentNameLeases).where(inArray(schema.agentNameLeases.sessionId, sessions));
          await db
            .update(schema.agentNamePool)
            .set({ currentSessionId: null })
            .where(inArray(schema.agentNamePool.currentSessionId, sessions));
          await db.delete(schema.agentSessions).where(inArray(schema.agentSessions.id, sessions));
        }
        if (addresses.length)
          await db.delete(schema.agentBusAddresses).where(inArray(schema.agentBusAddresses.id, addresses));
        await db.delete(schema.hosts).where(eq(schema.hosts.id, hostId));
        if (flag)
          await db
            .update(schema.versions)
            .set({ version: flag.version })
            .where(eq(schema.versions.name, flag.name));
        else await db.delete(schema.versions).where(eq(schema.versions.name, 'agent_messaging_enabled'));
        budget.restore();
        await pool.end();
      }
    },
  );
});
