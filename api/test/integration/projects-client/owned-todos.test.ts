import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import * as schema from '../../../src/db/schema.js';
import { scopedDatabase } from '../../../src/db/fresh-read.js';
import { CommandExecutor } from '../../../src/control-plane/commands.js';
import { DeadlineQueue } from '../../../src/control-plane/deadlines.js';
import { bindOwnerRuntime, type OwnerRuntime } from '../../../src/control-plane/state/runtime.js';
import { OwnerStateSnapshot, OwnerStateStore, type PreparedOwnerState } from '../../../src/control-plane/state/store.js';
import type { StateSeed } from '../../../src/control-plane/state/catalog.js';
import type { PersistenceTransaction } from '../../../src/control-plane/persistence.js';
import { HostProjectsService } from '../../../src/services/host-projects.js';
import { getTestDb } from '../../helpers/test-db.js';

const handle = await getTestDb();

describe.skipIf(!handle)('owned todo SQL transaction', () => {
  it.each([false, true])('keeps card and audit atomic with audit failure=%s', async (failAudit) => {
    const raw = handle!.db, db = scopedDatabase(raw), now = new Date().toISOString();
    const slug = 'audit-owner-' + randomUUID();
    const [insertedHost] = await raw.insert(schema.hosts).values({
      fqdn: slug + '.example', apiKey: randomUUID(), status: 'active', createdAt: now, updatedAt: now,
    });
    const hostId = Number(insertedHost.insertId);
    const [inserted] = await raw.insert(schema.coordProjects).values({
      slug, aboutJson: {}, rosterMarkdown: '', latestEventSeq: 0, createdAt: now, updatedAt: now,
    });
    const projectId = Number(inserted.insertId);
    const [project] = await raw.select().from(schema.coordProjects).where(eq(schema.coordProjects.id, projectId));
    const [host] = await raw.select().from(schema.hosts).where(eq(schema.hosts.id, hostId));
    const state = new OwnerStateStore(new OwnerStateSnapshot({ epoch: randomUUID(), sequence: 0n }, {
      coordProjects: [{ ...project!, recentEvents: [] }],
    } as unknown as StateSeed));
    const deadlines = new DeadlineQueue((error) => { throw error; });
    const executor = new CommandExecutor<OwnerStateSnapshot, PersistenceTransaction, PreparedOwnerState>({
      state, assertOwner() {}, loseOwner(error) { throw error; }, committed() {}, notificationError(error) { throw error; },
      persistence: {
        async receipt() { return undefined; }, async record() {},
        async transaction(run) {
          await raw.transaction(async tx => {
            const guarded = new Proxy(tx, { get(target, key) {
              if (failAudit && key === 'insert') return (table: unknown) => {
                if (table === schema.logs) throw new Error('injected audit failure');
                return target.insert(table as typeof schema.logs);
              };
              const value = Reflect.get(target, key);
              return typeof value === 'function' ? value.bind(target) : value;
            } });
            await run(guarded as unknown as PersistenceTransaction);
          });
        },
      },
    });
    const owner: OwnerRuntime = { state, deadlines, assertOwner() {}, execute: command => executor.execute(command) };
    bindOwnerRuntime(db, owner);
    try {
      const operation = new HostProjectsService(db).createTodo(slug, { title: 'atomic probe' }, host!);
      if (failAudit) await expect(operation).rejects.toThrow('injected audit failure');
      else await expect(operation).resolves.toMatchObject({ project: slug, todo: { title: 'atomic probe' } });
      const cards = await raw.select().from(schema.coordProjectCards).where(eq(schema.coordProjectCards.projectId, projectId));
      const audits = await raw.select().from(schema.logs).where(eq(schema.logs.hostId, hostId));
      const events = await raw.select().from(schema.coordProjectEvents).where(eq(schema.coordProjectEvents.projectId, projectId));
      expect(cards).toHaveLength(failAudit ? 0 : 1);
      expect(audits).toHaveLength(failAudit ? 0 : 1);
      expect(events).toHaveLength(failAudit ? 0 : 1);
      expect(state.snapshot().table('coordProjectCards').all()).toHaveLength(failAudit ? 0 : 1);
    } finally {
      deadlines.close();
      await raw.delete(schema.coordProjectEvents).where(eq(schema.coordProjectEvents.projectId, projectId));
      await raw.delete(schema.coordProjectCards).where(eq(schema.coordProjectCards.projectId, projectId));
      await raw.delete(schema.coordProjectBoardColumns).where(eq(schema.coordProjectBoardColumns.projectId, projectId));
      await raw.delete(schema.coordProjectBoards).where(eq(schema.coordProjectBoards.projectId, projectId));
      await raw.delete(schema.coordProjects).where(eq(schema.coordProjects.id, projectId));
      await raw.delete(schema.logs).where(eq(schema.logs.hostId, hostId));
      await raw.delete(schema.hosts).where(eq(schema.hosts.id, hostId));
    }
  });
});
