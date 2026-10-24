import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { drizzle } from 'drizzle-orm/mysql2';
import { eq, inArray } from 'drizzle-orm';
import * as schema from '../../src/db/schema.js';
import { getTestDb } from '../helpers/test-db.js';
import { testKeyring } from '../helpers/test-keyring.js';
import { ControlPlaneOwnership } from '../../src/control-plane/owner.js';
import { OwnerPersistence } from '../../src/control-plane/persistence.js';
import { CommandExecutor } from '../../src/control-plane/commands.js';
import { DeadlineQueue } from '../../src/control-plane/deadlines.js';
import { ConnectionPresence, bindOwnerPresence } from '../../src/control-plane/presence.js';
import { hydrateOwnerState } from '../../src/control-plane/state/hydrate.js';
import { bindOwnerRuntime, type OwnerRuntime } from '../../src/control-plane/state/runtime.js';
import { ProjectsService } from '../../src/services/projects.js';
import { ProjectContentService } from '../../src/services/project-content.js';
import { HostProjectsService } from '../../src/services/host-projects.js';
import { ProjectBoardService } from '../../src/services/project-board.js';
import { AdminMemoryLifecycle } from '../../src/services/admin-memory-lifecycle.js';
const handle = await getTestDb();
describe.skipIf(!handle)('owner content atomicity against real MySQL', () => {
  afterAll(async () => {
    await handle?.pool.end();
  });
  it('publishes content metadata/audit/cursors, serves summaries without SQL, and hydrates equivalent bounded projections', async () => {
    const suffix = randomUUID(),
      slug = 'owner-' + suffix,
      now = new Date().toISOString(),
      owner = new ControlPlaneOwnership(handle!.pool, 'owner_refactor_test'),
      deadlines = new DeadlineQueue((e) => {
        throw e;
      }),
      presence = new ConnectionPresence((e) => {
        throw e;
      }),
      receipts: string[] = [];
    let hostId = 0,
      projectId = 0;
    let drain: (() => Promise<void>) | undefined;
    try {
      const [host] = await handle!.db
        .insert(schema.hosts)
        .values({
          fqdn: slug + '.test',
          apiKey: randomUUID(),
          secure: 1,
          engines: 'codex',
          createdAt: now,
          updatedAt: now,
        })
        .$returningId();
      hostId = host!.id;
      const [project] = await handle!.db
        .insert(schema.coordProjects)
        .values({
          slug,
          aboutJson: { title: 'Content fixture' },
          rosterMarkdown: '',
          latestEventSeq: 0,
          createdAt: now,
          updatedAt: now,
        })
        .$returningId();
      projectId = project!.id;
      await owner.acquire();
      const { store } = await owner.hydrate((connection, epoch) =>
        hydrateOwnerState(drizzle(connection, { schema, mode: 'default' }), { epoch, sequence: 0n }),
      );
      owner.ready();
      const executor = new CommandExecutor({
        state: store,
        persistence: new OwnerPersistence(owner, testKeyring()),
        assertOwner: () => owner.assertReady(),
        loseOwner: (e) => owner.lose(e),
        committed: (r) => {
          receipts.push(r.id);
        },
        notificationError: (e) => {
          throw e;
        },
      });
      drain = () => executor.drain();
      const runtime: OwnerRuntime = {
        state: store,
        deadlines,
        assertOwner: () => owner.assertReady(),
        execute: (c) => executor.execute(c),
      };
      bindOwnerRuntime(handle!.db, runtime);
      bindOwnerPresence(runtime, presence);
      const content = new ProjectContentService(handle!.db, new ProjectsService(handle!.db)),
        projects = new HostProjectsService(handle!.db),
        board = new ProjectBoardService({ db: handle!.db, projects }),
        memories = new AdminMemoryLifecycle(handle!.db),
        hostRow = (await handle!.db.select().from(schema.hosts).where(eq(schema.hosts.id, hostId)))[0]!;
      const note = await content.upsertNote(slug, null, { header: 'Fixture', body: 'N'.repeat(800) }, hostId);
      await content.upsertFile(slug, { stored_name: 'fixture.txt', content: 'UTF8 ä content' }, hostId);
      await content.createFeedback(slug, { title: 'Issue', body: 'Issue detail' }, hostId);
      await board.todoCreate(slug, { title: 'Task', detail: 'Task content' }, hostId);
      await projects.upsertMemory(slug, { id: 'context', content: 'M'.repeat(800) }, hostRow);
      const shared = await memories.create('shared', { id: slug, content: 'Initial' }, 7);
      const changed = await memories.update(
        'shared',
        shared.memory.record_id,
        { content: 'Changed', expected_etag: shared.memory.etag },
        7,
      );
      await expect(
        memories.update(
          'shared',
          shared.memory.record_id,
          { content: 'Stale', expected_etag: shared.memory.etag },
          7,
        ),
      ).rejects.toThrow();
      const appended = await memories.appendShared(shared.memory.record_id, 'Append', 7);
      expect(appended.memory.content).toBe('Changed\n\nAppend');
      const select = vi.spyOn(handle!.db, 'select');
      const summary = await projects.summary(slug, {}, hostRow);
      expect(summary.counts).toMatchObject({ notes: 1, files: 1, memories: 1, open_todos: 1 });
      await projects.listMemories(slug, {}, hostRow);
      await board.todoRowsFor(projectId);
      expect(select).not.toHaveBeenCalled();
      select.mockRestore();
      const before = store.snapshot();
      expect(before.table('coordProjectNotes').get(note.note.id)?.bodyLength).toBe(800);
      expect(before.table('coordProjectNotes').get(note.note.id)).not.toHaveProperty('body');
      expect(before.table('coordProjects').get(projectId)?.recentEvents.length).toBeGreaterThan(0);
      await executor.drain();
      await owner.close();
      const next = new ControlPlaneOwnership(handle!.pool, 'owner_refactor_test');
      try {
        await next.acquire();
        const reloaded = await next.hydrate((connection, epoch) =>
          hydrateOwnerState(drizzle(connection, { schema, mode: 'default' }), { epoch, sequence: 0n }),
        );
        for (const table of [
          'coordProjects',
          'coordProjectNotes',
          'coordProjectFiles',
          'coordProjectMemories',
        ] as const) {
          const live = before
            .table(table)
            .all()
            .filter((r) =>
              table === 'coordProjects' ? r.id === projectId : 'projectId' in r && r.projectId === projectId,
            );
          for (const row of live) expect(reloaded.store.snapshot().table(table).get(row.id)).toEqual(row);
        }
        expect(reloaded.store.snapshot().table('sharedMemories').get(shared.memory.record_id)?.revision).toBe(
          3,
        );
      } finally {
        await next.close();
      }
    } finally {
      await drain?.();
      presence.close();
      deadlines.close();
      await owner.close();
      if (projectId) {
        for (const table of [
          schema.coordProjectCardDeps,
          schema.coordProjectCards,
          schema.coordProjectBoardColumns,
          schema.coordProjectBoards,
          schema.coordProjectNotes,
          schema.coordProjectFiles,
          schema.coordProjectFeedback,
          schema.coordProjectMemories,
          schema.coordProjectEvents,
        ])
          await handle!.db.delete(table).where(eq(table.projectId, projectId));
        await handle!.db.delete(schema.coordProjects).where(eq(schema.coordProjects.id, projectId));
      }
      const shared = await handle!.db
        .select({ id: schema.sharedMemories.id })
        .from(schema.sharedMemories)
        .where(eq(schema.sharedMemories.slug, slug));
      if (shared.length) {
        const ids = shared.map((r) => r.id);
        await handle!.db
          .delete(schema.sharedMemoryChunks)
          .where(inArray(schema.sharedMemoryChunks.memoryId, ids));
        await handle!.db
          .delete(schema.sharedMemoryRevisions)
          .where(inArray(schema.sharedMemoryRevisions.memoryId, ids));
        await handle!.db.delete(schema.sharedMemories).where(inArray(schema.sharedMemories.id, ids));
      }
      if (hostId) {
        await handle!.db.delete(schema.logs).where(eq(schema.logs.hostId, hostId));
        await handle!.db.delete(schema.hosts).where(eq(schema.hosts.id, hostId));
      }
      if (receipts.length)
        await handle!.db
          .delete(schema.controlPlaneCommandReceipts)
          .where(inArray(schema.controlPlaneCommandReceipts.requestId, receipts));
    }
  }, 60000);
});
