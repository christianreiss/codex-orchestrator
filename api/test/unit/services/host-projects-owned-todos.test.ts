import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import * as schema from '../../../src/db/schema.js';
import { CommandExecutor } from '../../../src/control-plane/commands.js';
import { DeadlineQueue } from '../../../src/control-plane/deadlines.js';
import { bindOwnerRuntime, type OwnerRuntime } from '../../../src/control-plane/state/runtime.js';
import { OwnerStateSnapshot, OwnerStateStore, type PreparedOwnerState } from '../../../src/control-plane/state/store.js';
import type { StateSeed } from '../../../src/control-plane/state/catalog.js';
import type { PersistenceTransaction } from '../../../src/control-plane/persistence.js';
import { scopedDatabase } from '../../../src/db/fresh-read.js';
import { HostProjectsService } from '../../../src/services/host-projects.js';
import { wsPublisher } from '../../../src/ws/publisher.js';
import { createDbFake } from '../../helpers/db-fake.js';

function fixture(failAudit = false) {
  const now = new Date().toISOString();
  const seed = { coordProjects: [{ id: 1, slug: 'audit-todos', aboutJson: {}, rosterMarkdown: '',
    latestEventSeq: 0, recentEvents: [], archivedAt: null, createdAt: now, updatedAt: now }] } as unknown as StateSeed;
  const raw = createDbFake(new Map([[schema.coordProjects, structuredClone(seed.coordProjects!) as unknown as Record<string, unknown>[]]]));
  const db = scopedDatabase(raw);
  const insert = raw.insert.bind(raw);
  db.insert = (table) => {
    if (failAudit && table === schema.logs) throw new Error('audit persistence failed');
    return insert(table);
  };
  const state = new OwnerStateStore(new OwnerStateSnapshot({ epoch: randomUUID(), sequence: 0n }, seed));
  const deadlines = new DeadlineQueue((error) => { throw error; });
  let commits = 0;
  const executor = new CommandExecutor<OwnerStateSnapshot, PersistenceTransaction, PreparedOwnerState>({
    state, assertOwner() {}, loseOwner(error) { throw error; }, notificationError(error) { throw error; },
    committed() { commits++; },
    persistence: {
      async receipt() { return undefined; },
      async record() {},
      async transaction(run) { await run(raw as unknown as PersistenceTransaction); },
    },
  });
  const owner: OwnerRuntime = { state, deadlines, assertOwner() {}, execute: (command) => executor.execute(command) };
  bindOwnerRuntime(db, owner);
  return { db, state, service: new HostProjectsService(db as never), commits: () => commits, close: () => deadlines.close() };
}

describe('host todo facade under the exclusive owner', () => {
  it('creates, updates, completes, reopens and deletes todos with one audit per command', async () => {
    const h = fixture();
    try {
      const host = { id: 7 } as schema.Host;
      const created = await h.service.createTodo('audit-todos', { title: 'probe' }, host) as { todo: { id: number } };
      const id = created.todo.id;
      await h.service.updateTodo('audit-todos', id, { title: 'updated' }, host);
      await h.service.setTodoDone('audit-todos', id, true, host);
      await h.service.setTodoDone('audit-todos', id, false, host);
      await h.service.deleteTodo('audit-todos', id, host);
      expect(h.commits()).toBe(5);
      expect((h.db.tables.get(schema.logs) ?? []).map(row => row.action)).toEqual([
        'project.todo.create', 'project.todo.update', 'project.todo.done', 'project.todo.done', 'project.todo.delete',
      ]);
      expect(h.state.snapshot().table('coordProjectCards').all()[0]?.archivedAt).toBeTruthy();
    } finally { h.close(); }
  });

  it('does not commit a card or publish success when its audit fails', async () => {
    const h = fixture(true), publish = vi.spyOn(wsPublisher, 'publish');
    try {
      await expect(h.service.createTodo('audit-todos', { title: 'probe' }, { id: 7 } as schema.Host))
        .rejects.toThrow('audit persistence failed');
      expect(h.commits()).toBe(0);
      expect(h.state.snapshot().table('coordProjectCards').all()).toEqual([]);
      expect(publish).not.toHaveBeenCalled();
    } finally { publish.mockRestore(); h.close(); }
  });
});
